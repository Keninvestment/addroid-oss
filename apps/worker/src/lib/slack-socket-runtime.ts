// AdDroid OSS — apps/worker Slack Socket Mode receiver wiring (Regression fix).
//
// `@addroid/queue/slack-socket-receiver` の純粋なオーケストレーション層に対し、
// 本ファイルは worker プロセス固有の I/O 実装 (Prisma による token 取得 + 復号、
// Slack `apps.connections.open` HTTP 呼び出し、Node 内蔵 `globalThis.WebSocket`)
// を組み立てて受信機を起動するアダプタ。
//
// Slack 連携が未設定 (`oauth_tokens` に provider='slack' 行が無い、ENCRYPTION_KEY
// が未設定、token が壊れている、等) のとき本関数は **null を返し**、worker は
// Slack 受信機を起動しないまま GitOps polling / Apply / Cron を続行する
// (acceptance: "Slack integration is optional; AdDroid starts and passes core
// health checks without Slack tokens" + "Slack and Web UI failures do not block
// core GitOps polling, Apply, or Cron execution")。

import {
  getCryptoBoundary,
  openSocketModeConnection,
  type SlackFetch,
} from "@addroid/config";
import {
  startSlackSocketReceiver,
  type SlackCommandBoss,
  type SlackInstallation,
  type SlackInstallationLoader,
  type SlackSocketReceiverHandle,
  type SlackSocketReceiverLogger,
  type SocketModeReceiverChannel,
  type SocketModeReceiverChannelOpener,
  type SocketModeReceiverHandlers,
  type SocketModeUrlOpener,
} from "@addroid/queue";
import type { PrismaClient } from "@addroid/db";

export interface StartSlackSocketRuntimeOptions {
  prisma: PrismaClient;
  boss: SlackCommandBoss;
  logger?: SlackSocketReceiverLogger;
  /** test seam: Slack Web API 呼び出し用 fetch を差し替える。 */
  slackFetch?: SlackFetch;
  /** test seam: WebSocket 開設関数を差し替える。 */
  channelOpener?: SocketModeReceiverChannelOpener;
}

/**
 * Slack Socket Mode 受信機を worker から起動する。
 *
 * 戻り値:
 *   - `null`  → Slack 未設定 (token なし / ENCRYPTION_KEY なし / 復号失敗) で
 *               受信機を起動しなかった。worker はそのまま続行してよい。
 *   - handle → 受信機が起動した (state="connecting" / "connected" / 等)。
 *               worker shutdown 時に `handle.stop()` を必ず呼ぶ。
 */
export async function startSlackSocketRuntime(
  opts: StartSlackSocketRuntimeOptions
): Promise<SlackSocketReceiverHandle | null> {
  const installationLoader: SlackInstallationLoader = () =>
    loadSlackInstallation({ prisma: opts.prisma, logger: opts.logger });

  // 起動前に loader を 1 度回し、未設定なら受信機を組み立てない
  // (設定済みなら handle を返し、worker は stop() で閉じる責務を持つ)。
  const probe = await installationLoader();
  if (!probe) return null;

  const channelOpener =
    opts.channelOpener ?? defaultGlobalWebSocketOpener;
  const urlOpener = buildUrlOpener(opts.slackFetch);

  return await startSlackSocketReceiver({
    installationLoader: async () => probe,
    urlOpener,
    channelOpener,
    boss: opts.boss,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}

// ---------------------------------------------------------------------
// 1) Prisma → SlackInstallation loader (decrypt boundary)
// ---------------------------------------------------------------------

export interface LoadInstallationOptions {
  prisma: PrismaClient;
  logger?: SlackSocketReceiverLogger;
}

interface SlackInstallationMetadataShape {
  teamId?: unknown;
  teamName?: unknown;
  botUserId?: unknown;
  notificationChannelId?: unknown;
}

export async function loadSlackInstallation(
  opts: LoadInstallationOptions
): Promise<SlackInstallation | null> {
  const log = opts.logger;

  // ENCRYPTION_KEY が無ければ復号できない → 未設定扱い (fail-soft)。
  let crypto: ReturnType<typeof getCryptoBoundary>;
  try {
    crypto = getCryptoBoundary();
  } catch (err) {
    log?.info(
      `[slack-socket] ENCRYPTION_KEY 未設定のため Slack 受信機を skip: ${(err as Error).message}`
    );
    return null;
  }

  let row: {
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string | null;
    accountIdentifier: string;
    metadata: unknown;
  } | null;
  try {
    row = await opts.prisma.oAuthToken.findFirst({
      where: { provider: "slack" },
      orderBy: { connectedAt: "desc" },
      select: {
        accessTokenCiphertext: true,
        refreshTokenCiphertext: true,
        accountIdentifier: true,
        metadata: true,
      },
    });
  } catch (err) {
    log?.warn(
      `[slack-socket] oauth_tokens 読み出し失敗 (受信機 skip): ${(err as Error).message}`
    );
    return null;
  }
  if (!row) return null;

  // refreshTokenCiphertext には xapp-* (Socket Mode token) が入っている契約
  // (`addroid auth slack` / `packages/config/slack-auth.ts` の規約と一致)。
  if (!row.refreshTokenCiphertext) {
    log?.warn(
      "[slack-socket] oauth_tokens(provider=slack) に xapp トークンがありません — Slack 受信機を skip。`addroid auth slack` を再実行してください。"
    );
    return null;
  }

  let botToken: string;
  let appToken: string;
  try {
    botToken = crypto.decrypt(row.accessTokenCiphertext);
    appToken = crypto.decrypt(row.refreshTokenCiphertext);
  } catch (err) {
    log?.warn(
      `[slack-socket] Slack トークンの復号に失敗 (受信機 skip): ${(err as Error).message}`
    );
    return null;
  }

  const metadata = (row.metadata ?? {}) as SlackInstallationMetadataShape;
  const teamId =
    typeof metadata.teamId === "string" && metadata.teamId.length > 0
      ? (metadata.teamId as string)
      : row.accountIdentifier;
  const teamName =
    typeof metadata.teamName === "string" ? (metadata.teamName as string) : "";
  const botUserId =
    typeof metadata.botUserId === "string" ? (metadata.botUserId as string) : "";
  const notificationChannelId =
    typeof metadata.notificationChannelId === "string"
      ? (metadata.notificationChannelId as string)
      : "";

  return {
    botToken,
    appToken,
    teamId,
    teamName,
    botUserId,
    notificationChannelId,
  };
}

// ---------------------------------------------------------------------
// 2) Slack apps.connections.open wrapper (HTTP)
// ---------------------------------------------------------------------

function buildUrlOpener(
  fetchImpl?: SlackFetch
): SocketModeUrlOpener {
  return async (appToken: string) => {
    const opened = await openSocketModeConnection(appToken, fetchImpl);
    return { url: opened.url };
  };
}

// ---------------------------------------------------------------------
// 3) Default WebSocket opener (uses globalThis.WebSocket from Node 22+)
// ---------------------------------------------------------------------

interface MinimalGlobalWebSocketCtor {
  new (url: string): {
    addEventListener(type: "open", listener: () => void): void;
    addEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void
    ): void;
    addEventListener(
      type: "error",
      listener: (event: { message?: string }) => void
    ): void;
    addEventListener(
      type: "close",
      listener: (event: { code: number; reason: string }) => void
    ): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
  };
}

const defaultGlobalWebSocketOpener: SocketModeReceiverChannelOpener = (
  url: string,
  handlers: SocketModeReceiverHandlers
): SocketModeReceiverChannel => {
  const Ctor = (globalThis as { WebSocket?: MinimalGlobalWebSocketCtor })
    .WebSocket;
  if (typeof Ctor !== "function") {
    // Node 22+ でないランタイムは契約上サポート外 (engines に記述済み)。
    // worker 全体を落とさないよう receiver 側に "websocket_open_threw" として
    // 通知できる Error を投げる (receiver は scheduleReconnect に倒れる)。
    throw new Error(
      "WebSocket が利用できません (Slack Socket Mode 受信機には Node 22+ が必要です)"
    );
  }
  const ws = new Ctor(url);
  ws.addEventListener("open", () => {
    try {
      handlers.onOpen?.();
    } catch {
      /* swallow */
    }
  });
  ws.addEventListener("message", (ev) => {
    const data = ev.data;
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf-8");
    } else if (
      typeof Buffer !== "undefined" &&
      Buffer.isBuffer(data as Buffer)
    ) {
      text = (data as Buffer).toString("utf-8");
    } else {
      text = String(data);
    }
    handlers.onMessage(text);
  });
  ws.addEventListener("error", (ev) => {
    handlers.onError(ev?.message ?? "websocket error");
  });
  ws.addEventListener("close", (ev) => {
    handlers.onClose(ev?.code ?? 1006, ev?.reason ?? "");
  });
  return {
    send(text: string) {
      ws.send(text);
    },
    close(code?: number, reason?: string) {
      try {
        ws.close(code ?? 1000, reason ?? "addroid worker shutdown");
      } catch {
        /* ignore */
      }
    },
  };
};

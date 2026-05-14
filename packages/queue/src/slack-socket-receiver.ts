// AdDroid OSS — Slack Socket Mode `/adops` receiver (Regression fix).
//
// 本モジュールは worker プロセス内で Slack の Socket Mode WebSocket を保持し、
// Slack から流入する `/adops <subcommand>` envelope を以下の順で処理する:
//
//   1. envelope を 3 秒以内に Socket Mode の WebSocket で ack する
//      (Slack 側は ack 受領まで同 envelope を再送し続ける仕様)。
//   2. parse 失敗時は ack に usage 文字列を埋め込んで Slack に返す (即時表示)。
//   3. parse 成功時は **先に** 「受け付けました」短文の ack を送り出してから、
//      非同期に pg-boss へ `slack_command` job を enqueue する。enqueue の I/O
//      が ack 遅延に乗ると Slack の 3 秒契約を割り再送ストームを招くため、
//      enqueue の完了 / 失敗 (singletonKey reject や boss.send throw) の通知は
//      ack ではなく `response_url` 経由の follow-up メッセージで返す。
//      実作業は worker 側 handler が `runSlackCommandJob` で実施し、結果は同じ
//      `response_url` に返す。
//
// 設計原則 (UI design plan §0.14-0.18 + acceptance):
//   - Slack 連携は完全に任意 (`installationLoader` が `null` を返したら起動を
//     skip して "unconfigured" 状態のまま停止する。GitOps polling / Apply / Cron
//     には何の影響も与えない)。
//   - Slack 失敗 (HTTP / WebSocket / token) は本モジュール内で握り潰し、
//     呼び出し側 (= worker startup) には throw しない。代わりに `state` を
//     `failed` / `reconnecting` に倒し、worker は他の責務を続行する。
//   - 公開 webhook / request URL は使わない。Slack 側からの inbound HTTP は
//     一切受けず、すべて outbound-only な WebSocket で完結する。
//   - `@addroid/queue` から `@addroid/db` `@addroid/config` への新規依存を
//     作らない。Prisma / Slack SDK / fetch / WebSocket 実装はすべて呼び出し側
//     (= apps/worker) からインジェクトされる (test seam を兼ねる)。
//   - sanitize-on-render は既に `slack-command.ts` 側で完結しているため、本層は
//     ack 文字列の組み立てだけを担当し、機微値を扱わない (token は
//     installationLoader の返値に閉じている)。
//
// Socket Mode envelope 仕様 (要点):
//   - Slack → client: `{ "type": "hello"|"slash_commands"|"events_api"|...,
//     "envelope_id": "<uuid>", "payload": {...}, "accepts_response_payload": true }`
//   - client → Slack: `{ "envelope_id": "<同じ uuid>", "payload": { ... } }` を
//     **同じ WebSocket** で送り返す (これが Slack 側の 3 秒以内 ack 要件)。
//
// 本モジュールはあくまで `/adops` slash_commands envelope のみ ack/enqueue する。
// `events_api` / `interactive` 等は ack だけ返して payload は無視する (the current implementation
// の範囲: notification + slash command + audited Activate のみ)。

import {
  SLACK_SLASH_COMMAND,
  buildAckMessage,
  enqueueSlackCommandJob,
  parseSlashCommand,
  postSlackResponse,
  type RawSlackSlashCommandRequest,
  type SlackCommandBoss,
  type SlackResponseFetch,
} from "./slack-command.js";
import {
  enqueueSlackAgentJob,
  type SlackAgentEventType,
  type SlackAgentJobPayload,
} from "./slack-agent.js";

// ---------------------------------------------------------------------
// 1) Public types
// ---------------------------------------------------------------------

/**
 * worker 側 Prisma loader が返す Slack インストールの最小情報。
 *
 * `botToken` (xoxb-*) と `appToken` (xapp-*) は ENCRYPTION_KEY (AES-256-GCM)
 * で復号した直後の平文。loader 関数の return 直後にメモリへ載るが、本モジュール
 * は token をログ / Slack `ack` payload / pg-boss payload のいずれにも書き出さない。
 */
export interface SlackInstallation {
  botToken: string;
  appToken: string;
  teamId: string;
  /** auth.test 由来の Slack workspace 表示名。ログに出してよい。 */
  teamName: string;
  /** 通知チャンネル (Cxxxx)。本モジュールは使わないが、payload に詰めておく。 */
  notificationChannelId: string;
  /** auth.test 由来の bot user id。本モジュールは ack に詰めない。 */
  botUserId: string;
}

/**
 * Slack 未設定時は `null` を返す (= 起動 skip, fail-soft)。
 * 例外は throw せず、内部的に握り潰してログだけ残す責務は呼び出し側にある。
 */
export type SlackInstallationLoader = () => Promise<SlackInstallation | null>;

/**
 * Slack `apps.connections.open` に POST して wss URL を取得する関数。
 * `@addroid/config` の `openSocketModeConnection` をそのままラップする想定。
 */
export type SocketModeUrlOpener = (
  appToken: string
) => Promise<{ url: string }>;

/**
 * Slack Socket Mode WebSocket の極小抽象。`globalThis.WebSocket` をそのまま
 * 使える形にしてあり、テストではフェイクを注入する。
 *
 * `send()` は envelope ack を送り返すために本モジュールが使う。
 */
export interface SocketModeReceiverChannel {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketModeReceiverHandlers {
  onOpen?(): void;
  onMessage(text: string): void;
  onError(reason: string): void;
  onClose(code: number, reason: string): void;
}

export type SocketModeReceiverChannelOpener = (
  url: string,
  handlers: SocketModeReceiverHandlers
) => SocketModeReceiverChannel;

export interface SlackSocketReceiverLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type SlackSocketReceiverState =
  | "idle"
  | "unconfigured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped"
  | "failed";

export interface SlackSocketReceiverHandle {
  /** 現在状態。worker 側は health JSON で晒すために読むだけ。 */
  getState(): SlackSocketReceiverState;
  /** stop。idempotent。reconnect スケジュールも解除する。 */
  stop(): Promise<void>;
}

/**
 * Slack 側で再送される envelope を冪等に処理するためのバウンダリ。
 *
 * Socket Mode の slash_commands envelope は **3 秒以内に同じ WebSocket で ack
 * しないと Slack 側が同 envelope_id で再送する**。本モジュールでは pg-boss
 * の singletonKey で重複起動を抑止しているが、worker 再起動 / 一時的な
 * WebSocket 切断時に同じ envelope_id が再送されることがあるため、
 * 直近 N 件の envelope_id をメモリに覚えて 2 回目以降は ack だけ返して enqueue
 * を skip する (LRU 容量は `recentEnvelopeCacheSize` で上書き可)。
 */
export interface SlackSocketReceiverOptions {
  installationLoader: SlackInstallationLoader;
  urlOpener: SocketModeUrlOpener;
  channelOpener: SocketModeReceiverChannelOpener;
  /** 直接 enqueue に使う pg-boss send 互換ボス。 */
  boss: SlackCommandBoss;
  logger?: SlackSocketReceiverLogger;
  /** test seam: setTimeout 互換。 */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  /** test seam: clearTimeout 互換。setTimeoutImpl の return 値を渡す。 */
  clearTimeoutImpl?: (handle: unknown) => void;
  /** test seam: now()。reconnect backoff の判断にだけ使う。 */
  now?: () => number;
  /** WebSocket 開いてから hello を待つ最大時間 (ms)。default 10000。 */
  helloTimeoutMs?: number;
  /** 切断後の再接続 backoff 上限 (ms)。default 30000。 */
  reconnectMaxDelayMs?: number;
  /** 直近 envelope_id を覚える件数。default 256。 */
  recentEnvelopeCacheSize?: number;
  /**
   * test seam: enqueue 失敗 / singletonKey reject 時に
   * `response_url` へ follow-up を投げる際の fetch 実装。未指定時は
   * `postSlackResponse` 内で `globalThis.fetch` にフォールバックする。
   */
  responseFetch?: SlackResponseFetch;
}

// ---------------------------------------------------------------------
// 2) Implementation
// ---------------------------------------------------------------------

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECENT_ENVELOPE_CACHE_SIZE = 256;

const noopLogger: SlackSocketReceiverLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * receiver を起動する。Slack 未設定 (= installationLoader が null を返す) の
 * 場合は WebSocket を開かず `state="unconfigured"` のまま return する。
 *
 * 例外は throw しない契約。loader / Slack API / WebSocket のいずれが失敗しても
 * 内部 state を `failed` / `reconnecting` に倒し、worker startup には
 * `WorkerHandle.stop()` できる handle を返す。
 */
export async function startSlackSocketReceiver(
  opts: SlackSocketReceiverOptions
): Promise<SlackSocketReceiverHandle> {
  const log = opts.logger ?? noopLogger;
  const setTimeoutImpl =
    opts.setTimeoutImpl ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clearTimeoutImpl =
    opts.clearTimeoutImpl ??
    ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const reconnectMaxDelayMs =
    opts.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const recentCacheSize =
    opts.recentEnvelopeCacheSize ?? DEFAULT_RECENT_ENVELOPE_CACHE_SIZE;

  let state: SlackSocketReceiverState = "idle";
  let stopRequested = false;
  let installation: SlackInstallation | null = null;
  let channel: SocketModeReceiverChannel | null = null;
  let helloTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let reconnectAttempt = 0;
  const recentEnvelopes: string[] = [];

  // ---------------- helpers ----------------

  const cancelHelloTimer = () => {
    if (helloTimer !== null) {
      clearTimeoutImpl(helloTimer);
      helloTimer = null;
    }
  };
  const cancelReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const closeChannelSafely = () => {
    if (channel) {
      try {
        channel.close(1000, "addroid worker shutdown");
      } catch {
        // ignore — already closed
      }
      channel = null;
    }
  };
  const rememberEnvelope = (envelopeId: string): boolean => {
    if (recentEnvelopes.includes(envelopeId)) return true;
    recentEnvelopes.push(envelopeId);
    if (recentEnvelopes.length > recentCacheSize) {
      recentEnvelopes.splice(0, recentEnvelopes.length - recentCacheSize);
    }
    return false;
  };
  const computeBackoffMs = (attempt: number): number => {
    // 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    const base = Math.min(reconnectMaxDelayMs, 1000 * Math.pow(2, attempt));
    return Math.max(1000, Math.min(reconnectMaxDelayMs, base));
  };

  // ---------------- connect / reconnect ----------------

  const scheduleReconnect = (reason: string) => {
    if (stopRequested) return;
    cancelHelloTimer();
    closeChannelSafely();
    state = "reconnecting";
    const delay = computeBackoffMs(reconnectAttempt);
    reconnectAttempt += 1;
    log.warn(
      `[slack-socket] reconnecting in ${delay}ms (attempt=${reconnectAttempt}, reason=${reason})`
    );
    cancelReconnectTimer();
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      void connectOnce();
    }, delay);
  };

  const connectOnce = async (): Promise<void> => {
    if (stopRequested) return;
    if (!installation) return;
    state = "connecting";
    let opened: { url: string };
    try {
      opened = await opts.urlOpener(installation.appToken);
    } catch (err) {
      log.error(
        `[slack-socket] apps.connections.open failed: ${(err as Error).message}`
      );
      scheduleReconnect("apps_connections_open_failed");
      return;
    }
    let helloReceived = false;
    try {
      channel = opts.channelOpener(opened.url, {
        onOpen() {
          // hello を待つ。Slack 仕様上 onOpen 直後に hello envelope が来る。
        },
        onMessage(text) {
          handleEnvelopeText(text, () => {
            if (!helloReceived) {
              helloReceived = true;
              cancelHelloTimer();
              state = "connected";
              reconnectAttempt = 0;
              log.info(
                `[slack-socket] connected (team=${installation?.teamName ?? "?"} ${installation?.teamId ?? "?"})`
              );
            }
          });
        },
        onError(reason) {
          if (stopRequested) return;
          log.warn(`[slack-socket] websocket error: ${reason}`);
          scheduleReconnect(`websocket_error:${reason}`);
        },
        onClose(code, reason) {
          if (stopRequested) return;
          log.warn(
            `[slack-socket] websocket closed (code=${code}${
              reason ? `, reason=${reason}` : ""
            })`
          );
          scheduleReconnect(`websocket_closed:${code}`);
        },
      });
    } catch (err) {
      log.error(
        `[slack-socket] failed to open websocket: ${(err as Error).message}`
      );
      scheduleReconnect("websocket_open_threw");
      return;
    }
    cancelHelloTimer();
    helloTimer = setTimeoutImpl(() => {
      helloTimer = null;
      if (helloReceived || stopRequested) return;
      log.warn(`[slack-socket] hello timeout after ${helloTimeoutMs}ms`);
      scheduleReconnect("hello_timeout");
    }, helloTimeoutMs);
  };

  // ---------------- envelope dispatch ----------------

  const ackEnvelope = (envelopeId: string, payload?: unknown) => {
    if (!channel) return;
    const body =
      payload === undefined
        ? JSON.stringify({ envelope_id: envelopeId })
        : JSON.stringify({ envelope_id: envelopeId, payload });
    try {
      channel.send(body);
    } catch (err) {
      log.warn(
        `[slack-socket] envelope ack send failed (envelope_id=${envelopeId}): ${(err as Error).message}`
      );
    }
  };

  const handleEnvelopeText = (
    text: string,
    onHelloLike: () => void
  ): void => {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      log.warn(`[slack-socket] non-JSON message ignored (${text.length}B)`);
      return;
    }
    if (!envelope || typeof envelope !== "object") return;
    const obj = envelope as Record<string, unknown>;
    const type = typeof obj["type"] === "string" ? (obj["type"] as string) : "";

    if (type === "hello") {
      onHelloLike();
      return;
    }
    if (type === "disconnect") {
      // Slack 側からの計画切断 (refresh / migration)。再接続する。
      const reason = typeof obj["reason"] === "string" ? (obj["reason"] as string) : "disconnect";
      log.info(`[slack-socket] disconnect requested by Slack: ${reason}`);
      scheduleReconnect(`slack_disconnect:${reason}`);
      return;
    }

    const envelopeId =
      typeof obj["envelope_id"] === "string" ? (obj["envelope_id"] as string) : "";
    if (!envelopeId) {
      log.warn(`[slack-socket] envelope without envelope_id (type=${type}) ignored`);
      return;
    }

    if (type === "slash_commands") {
      void handleSlashCommandEnvelope(envelopeId, obj);
      return;
    }

    if (type === "events_api") {
      void handleEventsApiEnvelope(envelopeId, obj);
      return;
    }

    // 未対応の type (events_api / interactive / etc.) は ack だけ返して payload は無視。
    // Slack 側の再送ストームを避けるため必ず ack する。
    ackEnvelope(envelopeId);
  };

  const handleEventsApiEnvelope = async (
    envelopeId: string,
    obj: Record<string, unknown>
  ): Promise<void> => {
    const seenBefore = rememberEnvelope(envelopeId);
    ackEnvelope(envelopeId);
    if (seenBefore) {
      log.info(
        `[slack-socket] duplicate events_api envelope_id=${envelopeId} — re-acked without enqueue`
      );
      return;
    }

    const payload = asRecord(obj["payload"]);
    if (!payload) return;
    if (readString(payload, "type") !== "event_callback") return;
    const event = asRecord(payload["event"]);
    if (!event) return;

    const normalized = normalizeAgentEvent(event, payload, installation);
    if (!normalized) return;

    try {
      const result = await enqueueSlackAgentJob({
        boss: opts.boss,
        payload: normalized,
      });
      if (result.jobId === null) {
        log.info(
          `[slack-socket] slack_agent rejected by singletonKey (${result.singletonKey})`
        );
      }
    } catch (err) {
      log.error(
        `[slack-socket] slack_agent enqueue failed (envelope_id=${envelopeId}): ${(err as Error).message}`
      );
    }
  };

  const handleSlashCommandEnvelope = async (
    envelopeId: string,
    obj: Record<string, unknown>
  ): Promise<void> => {
    // 1) 直近処理済み envelope なら ack のみ返して enqueue を skip (冪等)。
    const seenBefore = rememberEnvelope(envelopeId);
    if (seenBefore) {
      log.info(
        `[slack-socket] duplicate envelope_id=${envelopeId} — re-acking without enqueue`
      );
      ackEnvelope(envelopeId);
      return;
    }

    const rawPayload = obj["payload"];
    if (!rawPayload || typeof rawPayload !== "object") {
      ackEnvelope(envelopeId, {
        response_type: "ephemeral",
        text: `${SLACK_SLASH_COMMAND}: 不正な payload を受信しました。`,
      });
      return;
    }
    const request = normalizeSlashRequest(rawPayload as Record<string, unknown>);

    // 2) parse — 失敗時は ack 内に usage を埋め込んで Slack 即時表示。
    const parsed = parseSlashCommand(request);
    const ack = buildAckMessage(parsed);

    if (!parsed.ok) {
      ackEnvelope(envelopeId, ack);
      return;
    }

    // 3) parse 成功 → **先に同じ WebSocket フレームで ack を送り** (3 秒以内 ack
    //    契約: pg-boss / DB の I/O を待たないため)、enqueue 完了/失敗の通知は
    //    `response_url` 経由の follow-up に回す。enqueue 失敗を ack に押し込むと
    //    ack 遅延が発生し、Slack 側で再送ストームを誘発する。
    ackEnvelope(envelopeId, ack);

    let enqueueResult: Awaited<ReturnType<typeof enqueueSlackCommandJob>>;
    try {
      enqueueResult = await enqueueSlackCommandJob({
        boss: opts.boss,
        parsed,
        request,
      });
    } catch (err) {
      log.error(
        `[slack-socket] enqueue failed (envelope_id=${envelopeId}): ${(err as Error).message}`
      );
      await postFollowUp(request.response_url, {
        response_type: "ephemeral",
        text: `${SLACK_SLASH_COMMAND} ${parsed.subcommand}: バックグラウンドキューへの登録に失敗しました。GitOps polling / Apply / Cron は通常通り稼働しています。`,
      });
      return;
    }

    if (enqueueResult.jobId === null) {
      // singletonKey で reject されたケース (= 同 user の二重連打)。ack は既に
      // 標準の "受け付けました" を返している (Slack 側の再送を止めるため)。
      // 重複である事実は response_url で穏便に追補する。
      await postFollowUp(request.response_url, {
        response_type: "ephemeral",
        text: `${SLACK_SLASH_COMMAND} ${parsed.subcommand}${parsed.target ? ` ${parsed.target}` : ""}: 直前の同じコマンドがまだ実行中です。完了後に再実行してください。`,
      });
    }
    // jobId !== null の通常成功時は何もしない: 実行結果は worker 側 handler が
    // 同じ response_url に postSlackResponse で返す (slack-command.ts 参照)。
  };

  const postFollowUp = async (
    responseUrl: string,
    message: {
      response_type: "ephemeral";
      text: string;
    }
  ): Promise<void> => {
    try {
      const result = await postSlackResponse({
        responseUrl,
        message,
        ...(opts.responseFetch ? { fetchImpl: opts.responseFetch } : {}),
      });
      if (!result.ok) {
        log.warn(
          `[slack-socket] response_url follow-up failed (${result.errorCode ?? "unknown"}): ${result.errorMessage ?? ""}`
        );
      }
    } catch (err) {
      // postSlackResponse は throw しない契約だが、念のため握り潰す。
      log.warn(
        `[slack-socket] response_url follow-up threw: ${(err as Error).message}`
      );
    }
  };

  // ---------------- start ----------------

  try {
    installation = await opts.installationLoader();
  } catch (err) {
    log.warn(
      `[slack-socket] installation loader failed: ${(err as Error).message}`
    );
    state = "failed";
    return buildHandle();
  }
  if (!installation) {
    state = "unconfigured";
    log.info(
      "[slack-socket] Slack tokens not configured — Socket Mode receiver skipped (Slack is optional)."
    );
    return buildHandle();
  }

  void connectOnce();

  function buildHandle(): SlackSocketReceiverHandle {
    return {
      getState() {
        return state;
      },
      async stop(): Promise<void> {
        if (stopRequested) return;
        stopRequested = true;
        cancelHelloTimer();
        cancelReconnectTimer();
        closeChannelSafely();
        state = "stopped";
      },
    };
  }

  return buildHandle();
}

// ---------------------------------------------------------------------
// 3) Payload normalization
// ---------------------------------------------------------------------

/**
 * Socket Mode envelope の `payload` は HTTP slash command と同じ form フィールド
 * を JSON として運ぶ (Slack 仕様)。`@addroid/queue/slack-command` 側はもとから
 * `RawSlackSlashCommandRequest` 形 (HTTP form-encoded フィールド名) を期待する
 * ため、ここで安全に string 化して詰め直す。型が想定外の値の場合は空文字に倒す
 * (parser 側で `wrong_command` / `empty_subcommand` に正しく落ちる)。
 */
function normalizeSlashRequest(
  payload: Record<string, unknown>
): RawSlackSlashCommandRequest {
  const str = (k: string): string => {
    const v = payload[k];
    return typeof v === "string" ? v : "";
  };
  const out: RawSlackSlashCommandRequest = {
    command: str("command"),
    text: str("text"),
    user_id: str("user_id"),
    channel_id: str("channel_id"),
    response_url: str("response_url"),
  };
  const userName = str("user_name");
  if (userName) out.user_name = userName;
  const teamId = str("team_id");
  if (teamId) out.team_id = teamId;
  const triggerId = str("trigger_id");
  if (triggerId) out.trigger_id = triggerId;
  return out;
}

function normalizeAgentEvent(
  event: Record<string, unknown>,
  payload: Record<string, unknown>,
  installation: SlackInstallation | null
): Omit<SlackAgentJobPayload, "enqueuedAt"> | null {
  const eventType = resolveAgentEventType(event, installation?.botUserId);
  if (!eventType) return null;
  if (readString(event, "bot_id")) return null;
  const subtype = readString(event, "subtype");
  if (subtype && subtype !== "file_share") return null;

  const userId = readString(event, "user");
  if (!userId || userId === installation?.botUserId) return null;
  const channelId = readString(event, "channel");
  const eventTs = readString(event, "ts");
  if (!channelId || !eventTs) return null;

  const rawText = readString(event, "text");
  const text = eventType === "app_mention" || eventType === "message.file_share"
    ? stripBotMention(rawText, installation?.botUserId)
    : rawText.trim();
  if (!text) return null;

  const threadTs = readString(event, "thread_ts") || eventTs;
  const teamId = readString(payload, "team_id") || installation?.teamId || "";
  const userName = readString(event, "username");
  const files = readAgentFiles(event);
  return {
    text,
    slackUserId: userId,
    ...(userName ? { slackUserName: userName } : {}),
    slackChannelId: channelId,
    ...(teamId ? { slackTeamId: teamId } : {}),
    threadTs,
    eventTs,
    eventType,
    ...(files.length > 0 ? { files } : {}),
  };
}

function readAgentFiles(event: Record<string, unknown>): NonNullable<SlackAgentJobPayload["files"]> {
  const raw = event["files"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const file = asRecord(item);
    if (!file) return [];
    const id = readString(file, "id");
    if (!id) return [];
    const out: NonNullable<SlackAgentJobPayload["files"]>[number] = { id };
    const name = readString(file, "name") || readString(file, "title");
    if (name) out.name = name;
    const mimetype = readString(file, "mimetype");
    if (mimetype) out.mimetype = mimetype;
    const filetype = readString(file, "filetype");
    if (filetype) out.filetype = filetype;
    const size = readNumber(file, "size");
    if (size !== null) out.size = size;
    return [out];
  });
}

function resolveAgentEventType(
  event: Record<string, unknown>,
  botUserId?: string
): SlackAgentEventType | null {
  const type = readString(event, "type");
  if (type === "app_mention") return "app_mention";
  if (type === "message" && readString(event, "channel_type") === "im") {
    return "message.im";
  }
  if (
    type === "message" &&
    readString(event, "subtype") === "file_share" &&
    hasBotMention(readString(event, "text"), botUserId)
  ) {
    return "message.file_share";
  }
  return null;
}

function hasBotMention(text: string, botUserId?: string): boolean {
  if (botUserId && text.includes(`<@${botUserId}>`)) return true;
  return /<@[A-Z0-9]+>/u.test(text);
}

function stripBotMention(text: string, botUserId?: string): string {
  let out = text;
  if (botUserId) {
    out = out.replace(new RegExp(`<@${escapeRegExp(botUserId)}>`, "gu"), "");
  }
  return out.replace(/<@[A-Z0-9]+>/gu, "").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// AdDroid OSS — Slack auth (Socket Mode) helpers (the current implementation, optional integration).
//
// 本モジュールは `addroid auth slack` CLI と (将来の) Web 側 Setup Server Action から
// 共通利用される薄いヘルパ群です。Slack Web API への HTTP 呼び出しと、AdDroid 内部の
// `oauth_tokens` 行に保存するための「非機微メタ」の正規化のみを担い、平文トークンを
// 扱う期間は呼び出し側の関数スコープ内に閉じ込めます。
//
// 不変条件:
//   - Slack 連携は完全に任意。本モジュールが load された時点では Slack 通信は走らない
//     (各関数を呼んだ時のみ outbound に出る)。
//   - Socket Mode 専用。public な webhook / request URL / tunnel を一切扱わない。
//   - 平文トークン (xoxb-* / xapp-*) はこのモジュールから返るデータ構造には含まれない。
//     呼び出し側で `getCryptoBoundary().encrypt()` を通してから永続化する責務を負う。
//   - すべての Slack Web API 呼び出しは `fetch` (Node 22+ 内蔵) を使う。
//     `fetch` は引数注入できるためテストでモック可能。
//   - Socket Mode の WebSocket は `globalThis.WebSocket` を使う。本プロジェクトの
//     最小ランタイム (Node 22+) では標準で提供されるため追加依存を持たない。
//   - サブプロセス起動・shell 経由の文字列展開は行わない (command injection 不要)。

const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;
const SLACK_APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{10,}$/;
const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{8,}$/;

/** Slack Web API のベース URL。テストで上書き可能。 */
export const SLACK_API_BASE_URL = "https://slack.com/api";

/**
 * Slack Web API へ流す `fetch` 互換シグネチャ。Node 22+ 標準 `fetch` がそのまま使える。
 * テストではこれをモック注入する。
 */
export type SlackFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface SlackAuthInputs {
  /** xoxb-* (Bot User OAuth Token)。auth.test / chat.postMessage で使用。 */
  botToken: string;
  /** xapp-* (App-Level Token, connections:write)。Socket Mode 接続テストで使用。 */
  appToken: string;
  /** 通知先チャンネル ID (`Cxxxx` / `Gxxxx` / `Dxxxx`)。chat.postMessage の対象。 */
  notificationChannelId: string;
}

export class SlackTokenValidationError extends Error {
  readonly code:
    | "missing_bot_token"
    | "missing_app_token"
    | "missing_channel_id"
    | "invalid_bot_token"
    | "invalid_app_token"
    | "invalid_channel_id";
  constructor(
    code: SlackTokenValidationError["code"],
    message: string
  ) {
    super(message);
    this.name = "SlackTokenValidationError";
    this.code = code;
  }
}

/**
 * 形式バリデーション。値の存在 + プレフィクス + 文字種のみを検査する (Slack 側の
 * 真正性チェックは {@link verifyBotToken} / {@link openSocketModeConnection} が担う)。
 *
 * 受け付けた値はそのまま返さず、`trim()` 済みの正規化値を返す。先頭末尾の空白で
 * しくじるユーザーを救済する目的。
 */
export function validateSlackInputs(
  raw: Partial<SlackAuthInputs>
): SlackAuthInputs {
  const botToken = (raw.botToken ?? "").trim();
  const appToken = (raw.appToken ?? "").trim();
  const channel = (raw.notificationChannelId ?? "").trim();
  if (!botToken)
    throw new SlackTokenValidationError(
      "missing_bot_token",
      "xoxb-* (Bot User OAuth Token) が指定されていません"
    );
  if (!appToken)
    throw new SlackTokenValidationError(
      "missing_app_token",
      "xapp-* (App-Level Token) が指定されていません"
    );
  if (!channel)
    throw new SlackTokenValidationError(
      "missing_channel_id",
      "通知チャンネル ID (Cxxxx / Gxxxx / Dxxxx) が指定されていません"
    );
  if (!SLACK_BOT_TOKEN_RE.test(botToken))
    throw new SlackTokenValidationError(
      "invalid_bot_token",
      "xoxb-* で始まる Bot User OAuth Token を渡してください"
    );
  if (!SLACK_APP_TOKEN_RE.test(appToken))
    throw new SlackTokenValidationError(
      "invalid_app_token",
      "xapp-* で始まる App-Level Token を渡してください (Socket Mode 用)"
    );
  if (!SLACK_CHANNEL_ID_RE.test(channel))
    throw new SlackTokenValidationError(
      "invalid_channel_id",
      "Slack チャンネル ID は C/G/D で始まる英数字 ID です (例: C012ABC...)"
    );
  return {
    botToken,
    appToken,
    notificationChannelId: channel,
  };
}

export class SlackApiError extends Error {
  readonly endpoint: string;
  readonly status: number;
  /** Slack Web API が `ok: false` で返したときのエラーコード (例: `invalid_auth`)。 */
  readonly slackError: string | null;
  constructor(
    endpoint: string,
    status: number,
    slackError: string | null,
    message: string
  ) {
    super(message);
    this.name = "SlackApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.slackError = slackError;
  }
}

async function callSlackApi<T>(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: SlackFetch
): Promise<T> {
  const url = `${SLACK_API_BASE_URL}/${endpoint}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new SlackApiError(
      endpoint,
      res.status,
      null,
      `Slack ${endpoint} が HTTP ${res.status} を返しました`
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new SlackApiError(
      endpoint,
      res.status,
      null,
      `Slack ${endpoint} の応答 JSON をパースできませんでした: ${(err as Error).message}`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SlackApiError(
      endpoint,
      res.status,
      null,
      `Slack ${endpoint} の応答が不正です (object でない)`
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["ok"] !== true) {
    const slackError =
      typeof obj["error"] === "string" ? (obj["error"] as string) : null;
    throw new SlackApiError(
      endpoint,
      res.status,
      slackError,
      slackError
        ? `Slack ${endpoint} が ok=false を返しました (${slackError})`
        : `Slack ${endpoint} が ok=false を返しました`
    );
  }
  return obj as unknown as T;
}

export interface SlackAuthTestResponse {
  ok: true;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

/**
 * `auth.test` を呼び、xoxb-* token の真正性と team_id / bot_user_id を確認する。
 * 成功時は team / user 情報を返す。
 */
export async function verifyBotToken(
  botToken: string,
  fetchImpl: SlackFetch = (globalThis as { fetch?: SlackFetch }).fetch as SlackFetch
): Promise<SlackAuthTestResponse> {
  if (typeof fetchImpl !== "function") {
    throw new SlackApiError(
      "auth.test",
      0,
      null,
      "fetch が利用できません (Node 22+ で実行してください)"
    );
  }
  return await callSlackApi<SlackAuthTestResponse>(
    "auth.test",
    botToken,
    {},
    fetchImpl
  );
}

export interface SlackConnectionsOpenResponse {
  ok: true;
  url: string; // wss://...
}

/**
 * `apps.connections.open` を呼び、Slack 側で Socket Mode 用の wss URL を発行する。
 *
 * 本関数は **HTTP 呼び出しのみ**で、実際の WebSocket は開かない。Socket Mode
 * 接続が本当に確立できることを確認するには {@link verifySocketModeConnection}
 * を使う (こちらは内部的に本関数を呼んだ上で WebSocket ハンドシェイクと
 * `hello` イベント受信まで検証する)。
 *
 * ここでの HTTP 成功は「xapp トークンが有効で `connections:write` スコープがあり、
 * Slack 側で Socket Mode が有効になっている」ことの確認に等しいが、ネットワーク
 * 経路 (TLS / WebSocket upgrade) が通ることまでは保証しない。
 */
export async function openSocketModeConnection(
  appToken: string,
  fetchImpl: SlackFetch = (globalThis as { fetch?: SlackFetch }).fetch as SlackFetch
): Promise<SlackConnectionsOpenResponse> {
  if (typeof fetchImpl !== "function") {
    throw new SlackApiError(
      "apps.connections.open",
      0,
      null,
      "fetch が利用できません (Node 22+ で実行してください)"
    );
  }
  return await callSlackApi<SlackConnectionsOpenResponse>(
    "apps.connections.open",
    appToken,
    {},
    fetchImpl
  );
}

/**
 * Socket Mode の WebSocket 抽象。`globalThis.WebSocket` の機能のうち
 * 検証に必要な最小限のみを切り出し、テストで差し込めるようにする。
 *
 * ハンドラは「最初に `onOpen` → 0 回以上の `onMessage` → `onError` か
 * `onClose` で終わる」という EventTarget 的な遷移を前提にする。
 */
export interface SocketModeChannelHandlers {
  onOpen?(): void;
  onMessage(text: string): void;
  onError(reason: string): void;
  onClose(code: number, reason: string): void;
}

export interface SocketModeChannel {
  /** WebSocket を閉じる。idempotent。 */
  close(): void;
}

/**
 * URL とハンドラを受け取って WebSocket 風のチャネルを開くファクトリ。
 * テストでは決定的なフェイクを注入する。本番ではグローバル `WebSocket` を使う。
 */
export type SocketModeChannelOpener = (
  url: string,
  handlers: SocketModeChannelHandlers
) => SocketModeChannel;

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
    close(code?: number, reason?: string): void;
  };
}

const defaultSocketModeChannelOpener: SocketModeChannelOpener = (
  url,
  handlers
) => {
  const Ctor = (globalThis as { WebSocket?: MinimalGlobalWebSocketCtor })
    .WebSocket;
  if (typeof Ctor !== "function") {
    throw new SlackApiError(
      "apps.connections.open",
      0,
      "websocket_unavailable",
      "WebSocket が利用できません (本プロジェクトの最小ランタイム Node 22+ 〈package.json engines〉 で実行するか、`SocketModeChannelOpener` を注入してください)"
    );
  }
  const ws = new Ctor(url);
  ws.addEventListener("open", () => {
    try {
      handlers.onOpen?.();
    } catch {
      // ハンドラ内例外は呼び出し側責務 (settle 済みなら無視される)
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
    close() {
      try {
        ws.close(1000, "verification complete");
      } catch {
        // 既に閉じている / close を二重に呼んだ場合は無視
      }
    },
  };
};

export interface SlackSocketModeVerificationResponse {
  /** Slack が発行した wss URL (ticket 付き、一回限り使用)。 */
  url: string;
  /**
   * Slack から受け取った `hello` イベントの中身。Socket Mode が確立すると
   * Slack はまず `{"type":"hello",...}` を送ってくる仕様で、これを受信したことを
   * もって「Socket Mode 接続が成立した」と確認する。
   */
  helloEvent: {
    type: "hello";
    num_connections?: number;
    debug_info?: Record<string, unknown>;
    connection_info?: Record<string, unknown>;
  };
}

/**
 * Socket Mode 接続を「実際に」確立して検証する。
 *
 * 流れ:
 *   1. `apps.connections.open` で wss URL (ticket 付き) を取得。
 *   2. 注入可能な {@link SocketModeChannelOpener} で WebSocket を開く。
 *   3. Slack が最初に送ってくる `hello` イベントを待つ。受信したら成功。
 *   4. 成功・失敗を問わず WebSocket は閉じる (本 CLI 側では持続接続しない —
 *      持続接続は worker プロセスの責務)。
 *
 * 失敗条件 (いずれも `SlackApiError` で throw):
 *   - timeoutMs (デフォルト 10s) 以内に hello が来ない (`socket_mode_timeout`)。
 *   - WebSocket がエラーで切れた (`socket_mode_failed`)。
 *   - WebSocket が hello より前に close した (`socket_mode_closed_before_hello`)。
 *   - hello 以外のイベント / 非 JSON テキストが先に届いた (`socket_mode_unexpected_event`)。
 *
 * これにより `addroid auth slack` は「URL が発行された」だけでなく
 * 「実際に Socket Mode に乗れた」ことを確認したうえでトークンを永続化できる
 * (the current implementation acceptance: "Slack auth setup ... verifies Socket Mode connection
 * with a test message" の前段)。
 */
export async function verifySocketModeConnection(
  appToken: string,
  options?: {
    fetchImpl?: SlackFetch;
    openChannel?: SocketModeChannelOpener;
    /** WebSocket 開設から hello 受信までの最大待ち時間 (ms)。既定 10000。 */
    timeoutMs?: number;
  }
): Promise<SlackSocketModeVerificationResponse> {
  const fetchImpl =
    options?.fetchImpl ??
    ((globalThis as { fetch?: SlackFetch }).fetch as SlackFetch);
  const openChannel = options?.openChannel ?? defaultSocketModeChannelOpener;
  const timeoutMs = options?.timeoutMs ?? 10_000;

  const opened = await openSocketModeConnection(appToken, fetchImpl);

  return await new Promise<SlackSocketModeVerificationResponse>(
    (resolve, reject) => {
      let settled = false;
      let channel: SocketModeChannel | null = null;

      const cleanup = () => {
        try {
          channel?.close();
        } catch {
          // already closed
        }
      };
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        action();
      };
      const fail = (slackError: string, message: string) =>
        settle(() =>
          reject(
            new SlackApiError("apps.connections.open", 0, slackError, message)
          )
        );

      const timer = setTimeout(() => {
        fail(
          "socket_mode_timeout",
          `Socket Mode WebSocket からの hello イベントが ${timeoutMs}ms 以内に届きませんでした`
        );
      }, timeoutMs);

      try {
        channel = openChannel(opened.url, {
          onMessage(text) {
            if (settled) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              fail(
                "socket_mode_unexpected_event",
                "Socket Mode から JSON 以外のメッセージを受信しました"
              );
              return;
            }
            const obj = (parsed ?? {}) as { type?: unknown };
            if (obj.type === "hello") {
              const helloEvent =
                parsed as SlackSocketModeVerificationResponse["helloEvent"];
              settle(() => resolve({ url: opened.url, helloEvent }));
              return;
            }
            fail(
              "socket_mode_unexpected_event",
              `Socket Mode の最初のイベントが hello ではありませんでした (type=${
                typeof obj.type === "string" ? obj.type : "unknown"
              })`
            );
          },
          onError(reason) {
            fail(
              "socket_mode_failed",
              `Socket Mode WebSocket でエラーが発生しました: ${reason}`
            );
          },
          onClose(code, reason) {
            fail(
              "socket_mode_closed_before_hello",
              `Socket Mode WebSocket が hello より前に切断されました (code=${code}${
                reason ? `, reason=${reason}` : ""
              })`
            );
          },
        });
      } catch (err) {
        if (err instanceof SlackApiError) {
          settle(() => reject(err));
        } else {
          fail(
            "socket_mode_failed",
            `Socket Mode WebSocket を開けませんでした: ${(err as Error).message}`
          );
        }
      }
    }
  );
}

export interface SlackPostMessageResponse {
  ok: true;
  channel: string;
  ts: string;
}

export interface SlackPostMessageOptions {
  threadTs?: string;
  fetchImpl?: SlackFetch;
}

/**
 * `chat.postMessage` でテストメッセージを送信する。失敗 (channel_not_found 等)
 * は `SlackApiError` で throw される。
 */
export async function postSlackMessage(
  botToken: string,
  channelId: string,
  text: string,
  optionsOrFetch: SlackFetch | SlackPostMessageOptions = {}
): Promise<SlackPostMessageResponse> {
  const options =
    typeof optionsOrFetch === "function"
      ? { fetchImpl: optionsOrFetch }
      : optionsOrFetch;
  const fetchImpl =
    options.fetchImpl ?? ((globalThis as { fetch?: SlackFetch }).fetch as SlackFetch);
  if (typeof fetchImpl !== "function") {
    throw new SlackApiError(
      "chat.postMessage",
      0,
      null,
      "fetch が利用できません (Node 22+ で実行してください)"
    );
  }
  return await callSlackApi<SlackPostMessageResponse>(
    "chat.postMessage",
    botToken,
    {
      channel: channelId,
      text,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    },
    fetchImpl
  );
}

/**
 * `oauth_tokens.metadata` (JSON 列) に保存する Slack 固有の非機微メタ。
 * 平文トークンや signing secret はここに **入れない** — それらは ciphertext 列の役割。
 */
export interface SlackInstallationMetadata {
  teamId: string;
  teamName: string;
  botUserId: string;
  botUser: string;
  notificationChannelId: string;
  /**
   * 直近 Socket Mode 接続テストの結果 (ISO timestamp)。`addroid auth slack` で
   * 接続テストが ok だったタイミングを記録する。worker 側の継続接続状態は
   * 本フィールドではなく `socketLastSeenAt` 系のフィールドが追加実装され次第
   * そちらで管理する。
   */
  lastSocketModeTestAt: string;
  /** 直近テストメッセージ送信成功時刻 (ISO timestamp)。失敗時は更新しない。 */
  lastTestMessageAt?: string;
}

export function buildSlackInstallationMetadata(input: {
  authTest: SlackAuthTestResponse;
  notificationChannelId: string;
  socketModeOkAt: Date;
  testMessageOkAt: Date | null;
}): SlackInstallationMetadata {
  const { authTest, notificationChannelId, socketModeOkAt, testMessageOkAt } =
    input;
  const out: SlackInstallationMetadata = {
    teamId: authTest.team_id,
    teamName: authTest.team,
    botUserId: authTest.user_id,
    botUser: authTest.user,
    notificationChannelId,
    lastSocketModeTestAt: socketModeOkAt.toISOString(),
  };
  if (testMessageOkAt) out.lastTestMessageAt = testMessageOkAt.toISOString();
  return out;
}

/**
 * 表示用に末尾 4 文字以外を `[REDACTED]` に置換する。CLI / UI から `oauth_tokens` を
 * humanly 見せるときに使う。トークンが 8 文字未満なら全置換 (短すぎる文字列は
 * tail を見せない)。
 */
export function redactSecretTail(value: string): string {
  if (typeof value !== "string" || value.length < 8) return "[REDACTED]";
  return `[REDACTED]…${value.slice(-4)}`;
}

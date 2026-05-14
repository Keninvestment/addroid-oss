// AdDroid OSS — Codex app-server backed LLM provider.
//
// This is the supported Codex route. It uses the local Codex app-server and
// the user's existing Codex/ChatGPT login instead of sending Codex tokens
// to api.openai.com.

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import { estimateCostUsd } from "./pricing.js";
import {
  LLMNotImplementedError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
  type LLMAuthKind,
  type LLMBeginOAuthResult,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMConnectionMeta,
  type LLMEmbedRequest,
  type LLMEmbedResult,
  type LLMImageRequest,
  type LLMImageResult,
  type LLMProvider,
  type LLMProviderName,
  type LLMRefreshResult,
} from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexLLMAppServerRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexLLMAppServerRpcClient {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  onNotification(handler: (msg: CodexLLMAppServerRpcNotification) => void): () => void;
  close(): void;
}

export interface CodexLLMAppServerHandle {
  url: string;
  child: ChildProcess | null;
  rpc: CodexLLMAppServerRpcClient;
}

export interface CodexAppServerLLMProviderOptions {
  defaultModel?: string;
  externalServerUrl?: string | null;
  codexBin?: string;
  cwd?: string;
  timeoutMs?: number;
  serverFactory?: () => Promise<CodexLLMAppServerHandle>;
  now?: () => Date;
}

export interface CodexAppServerLoginOptions {
  openUrl?: (url: string) => void;
  timeoutMs?: number;
  useDeviceCode?: boolean;
}

const DEFAULT_MODEL = "codex-app-server";
const DEFAULT_TIMEOUT_MS = 600_000;

export class CodexAppServerLLMProvider implements LLMProvider {
  readonly name: LLMProviderName = "codex";
  readonly authKind: LLMAuthKind = "app_server";
  readonly defaultModel: string;

  private readonly externalServerUrl: string | null;
  private readonly codexBin: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly serverFactory?: () => Promise<CodexLLMAppServerHandle>;
  private readonly now: () => Date;
  private serverPromise: Promise<CodexLLMAppServerHandle> | null = null;
  private exitHookInstalled = false;

  constructor(opts: CodexAppServerLLMProviderOptions = {}) {
    this.defaultModel = opts.defaultModel?.trim() || DEFAULT_MODEL;
    this.externalServerUrl =
      opts.externalServerUrl ??
      process.env.ADDROID_CODEX_APP_SERVER_URL ??
      process.env.CODEX_APP_SERVER_URL ??
      null;
    this.codexBin = opts.codexBin ?? process.env.CODEX_BIN ?? "codex";
    this.cwd = opts.cwd ?? process.env.ADDROID_CODEX_CWD ?? process.cwd();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.serverFactory = opts.serverFactory;
    this.now = opts.now ?? (() => new Date());
  }

  async beginOAuth(): Promise<LLMBeginOAuthResult> {
    const { rpc } = await this.ensureServer();
    const login = await rpc.request<CodexLoginStartResult>("account/login/start", {
      type: "chatgpt",
    });
    return {
      authorizationUrl: login.authUrl,
      state: login.loginId,
    };
  }

  async completeOAuth(): Promise<LLMConnectionMeta> {
    throw new LLMNotImplementedError("codex", "completeOAuth");
  }

  async refreshToken(): Promise<LLMRefreshResult> {
    const conn = await this.getConnection();
    if (!conn) throw new LLMProviderUnauthenticatedError("codex", "refresh the app-server session");
    return {
      provider: "codex",
      accountIdentifier: conn.accountIdentifier,
      refreshedAt: this.now().toISOString(),
      expiresAt: null,
    };
  }

  async disconnect(): Promise<boolean> {
    this.close();
    return false;
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    const account = await this.readAccount();
    if (!account) return null;
    return accountToConnection(account, this.defaultModel, this.now());
  }

  async ensureLoggedIn(opts: CodexAppServerLoginOptions = {}): Promise<LLMConnectionMeta> {
    const existing = await this.getConnection();
    if (existing) return existing;

    const { rpc } = await this.ensureServer();
    const login = opts.useDeviceCode
      ? await rpc.request<CodexDeviceLoginStartResult>("account/login/start", {
          type: "chatgptDeviceCode",
        })
      : await rpc.request<CodexLoginStartResult>("account/login/start", {
          type: "chatgpt",
        });

    if (login.type === "chatgpt") {
      opts.openUrl?.(login.authUrl);
      await this.waitForLogin(login.loginId, opts.timeoutMs ?? 180_000);
    } else {
      throw new LLMProviderError(
        "codex",
        `device login requested; open ${login.verificationUrl} and enter code ${login.userCode}`
      );
    }

    const connected = await this.getConnection();
    if (!connected) {
      throw new LLMProviderUnauthenticatedError("codex", "complete app-server login");
    }
    return connected;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new LLMProviderError("codex", "complete: messages must be a non-empty array");
    }
    const account = await this.readAccount();
    if (!account) throw new LLMProviderUnauthenticatedError("codex", "complete a request");

    const { rpc } = await this.ensureServer();
    const thread = await rpc.request<CodexThreadStartResult>("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = thread.thread.id;
    const model = typeof thread.model === "string" && thread.model.trim().length > 0
      ? thread.model.trim()
      : this.defaultModel;
    const prompt = messagesToCodexPrompt(req.messages);
    const input = messagesToCodexInput(req.messages, prompt);

    const result = await new Promise<{ content: string; status: string; inputTokens: number; outputTokens: number }>(
      (resolve, reject) => {
        let settled = false;
        let content = "";
        let inputTokens = 0;
        let outputTokens = 0;
        let off: (() => void) | null = null;
        const timeout = setTimeout(() => {
          settleError(new LLMProviderError("codex", `timeout waiting for app-server turn after ${Math.round(this.timeoutMs / 1000)}s`));
        }, this.timeoutMs);

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          off?.();
        };
        const settleError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const settleSuccess = (status: string) => {
          cleanup();
          resolve({ content, status, inputTokens, outputTokens });
        };

        off = rpc.onNotification((msg) => {
          const params = msg.params ?? {};
          if (params.threadId !== threadId) return;
          if (msg.method === "item/agentMessage/delta") {
            const delta = params.delta;
            if (typeof delta === "string") content += delta;
            return;
          }
          if (msg.method === "item/completed") {
            const item = isRecord(params.item) ? params.item : null;
            if (item?.type === "agentMessage") {
              const text = item.text ?? item.result;
              if (typeof text === "string" && text.length > 0) content = text;
            }
            return;
          }
          if (msg.method === "thread/tokenUsage/updated") {
            const usage = isRecord(params.tokenUsage) ? params.tokenUsage : isRecord(params.usage) ? params.usage : params;
            inputTokens = numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens) ?? inputTokens;
            outputTokens = numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens) ?? outputTokens;
            return;
          }
          if (msg.method === "turn/completed") {
            const turn = isRecord(params.turn) ? params.turn : {};
            const status = typeof turn.status === "string" ? turn.status : "completed";
            settleSuccess(status);
          }
        });

        rpc.request("turn/start", {
          threadId,
          input,
        }).catch((err) => settleError(asProviderError(err)));
      }
    );

    return {
      content: result.content,
      finishReason: result.status === "completed" ? "stop" : "other",
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      meta: {
        provider: "codex",
        model,
        requestId: threadId,
        accountIdentifier: account.email ?? account.planType ?? "codex-app-server",
      },
      costUsd: estimateCostUsd("codex", model, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      }),
    };
  }

  async generateImage(_req: LLMImageRequest): Promise<LLMImageResult> {
    throw new LLMNotImplementedError("codex", "generateImage");
  }

  async embed(_req: LLMEmbedRequest): Promise<LLMEmbedResult> {
    throw new LLMNotImplementedError("codex", "embed");
  }

  close(): void {
    const current = this.serverPromise;
    this.serverPromise = null;
    current
      ?.then((server) => {
        server.rpc.close();
        if (server.child && server.child.exitCode === null) server.child.kill("SIGTERM");
      })
      .catch(() => undefined);
  }

  private async readAccount(): Promise<CodexAccount | null> {
    const { rpc } = await this.ensureServer();
    const result = await rpc.request<CodexAccountReadResult>("account/read", {
      refreshToken: false,
    });
    return result.account ?? null;
  }

  private async waitForLogin(loginId: string, timeoutMs: number): Promise<void> {
    const { rpc } = await this.ensureServer();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        settle(new LLMProviderError("codex", "timed out waiting for Codex browser login"));
      }, timeoutMs);
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
        if (err) reject(err);
        else resolve();
      };
      off = rpc.onNotification((msg) => {
        if (msg.method !== "account/login/completed") return;
        const params = msg.params ?? {};
        if (params.loginId !== loginId) return;
        if (params.success === true) settle();
        else settle(new LLMProviderError("codex", String(params.error ?? "Codex login was not completed")));
      });
    });
  }

  private ensureServer(): Promise<CodexLLMAppServerHandle> {
    if (!this.serverPromise) {
      this.serverPromise = this.startServer().catch((err) => {
        this.serverPromise = null;
        throw err;
      });
    }
    return this.serverPromise;
  }

  private async startServer(): Promise<CodexLLMAppServerHandle> {
    if (this.serverFactory) return this.serverFactory();

    if (this.externalServerUrl) {
      assertLoopbackWebSocketUrl(this.externalServerUrl);
      const rpc = createCodexAppServerRpc(this.externalServerUrl);
      await initializeRpc(rpc);
      return { url: this.externalServerUrl, child: null, rpc };
    }

    const port = await findFreePort();
    const url = `ws://127.0.0.1:${port}`;
    const child = spawn(
      this.codexBin,
      ["-c", "mcp_servers={}", "app-server", "--listen", url],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    child.stdout?.on("data", (chunk) => process.stderr.write(`[codex-app-server] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[codex-app-server] ${chunk}`));
    child.on("exit", () => {
      this.serverPromise = null;
    });
    this.installExitHook(child);
    await waitForReady(url, child, () => spawnError);
    const rpc = createCodexAppServerRpc(url);
    await initializeRpc(rpc);
    return { url, child, rpc };
  }

  private installExitHook(child: ChildProcess): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    const kill = () => {
      try {
        if (child.exitCode === null) child.kill("SIGTERM");
      } catch {
        // Best-effort cleanup only.
      }
    };
    process.once("exit", kill);
    process.once("SIGINT", kill);
    process.once("SIGTERM", kill);
  }
}

interface CodexAccount {
  type?: string;
  email?: string;
  planType?: string;
}

interface CodexAccountReadResult {
  account: CodexAccount | null;
  requiresOpenaiAuth?: boolean;
}

interface CodexLoginStartResult {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

interface CodexDeviceLoginStartResult {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

interface CodexThreadStartResult {
  thread: { id: string };
  model?: string;
}

function accountToConnection(
  account: CodexAccount,
  defaultModel: string,
  connectedAt: Date
): LLMConnectionMeta {
  return {
    provider: "codex",
    accountIdentifier: account.email ?? account.planType ?? "codex-app-server",
    scopes: ["codex-app-server"],
    connectedAt: connectedAt.toISOString(),
    expiresAt: null,
    defaultModel,
  };
}

function messagesToCodexPrompt(messages: LLMCompletionRequest["messages"]): string {
  return messages
    .map((m) => {
      const role = m.role === "system" ? "System" : m.role === "assistant" ? "Assistant" : "User";
      return `${role}:\n${contentToPlainText(m.content)}`;
    })
    .join("\n\n");
}

function messagesToCodexInput(
  messages: LLMCompletionRequest["messages"],
  prompt: string
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt, text_elements: [] }];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "image") continue;
      if (part.localPath) {
        input.push({ type: "localImage", path: part.localPath });
      } else if (part.url) {
        input.push({ type: "image", image_url: part.url });
      }
    }
  }
  return input;
}

function contentToPlainText(content: LLMCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.type === "text" ? part.text : `[image: ${part.sourceRef ?? part.url ?? part.localPath ?? "inline"}]`)
    .join("\n");
}

async function initializeRpc(rpc: CodexLLMAppServerRpcClient): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: {
      name: "addroid-codex-llm",
      title: "AdDroid Codex LLM provider",
      version: "0.1.0",
    },
    capabilities: null,
  });
}

function createCodexAppServerRpc(url: string): CodexLLMAppServerRpcClient {
  assertLoopbackWebSocketUrl(url);
  if (typeof globalThis.WebSocket !== "function") {
    throw new LLMProviderError("codex", "global WebSocket is not available in this Node runtime");
  }
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const handlers: Array<(msg: CodexLLMAppServerRpcNotification) => void> = [];
  const ws = new globalThis.WebSocket(url);

  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new LLMProviderError("codex", `websocket error connecting to ${url}`));
  });

  ws.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as { id?: number; error?: unknown; result?: unknown; method?: string; params?: Record<string, unknown> };
    if (message.id && pending.has(message.id)) {
      const req = pending.get(message.id)!;
      pending.delete(message.id);
      clearTimeout(req.timer);
      if (message.error) req.reject(new LLMProviderError("codex", JSON.stringify(message.error)));
      else req.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of handlers) handler(message as CodexLLMAppServerRpcNotification);
    }
  };

  return {
    async request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      await opened;
      const id = nextId;
      nextId += 1;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new LLMProviderError("codex", `timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });
      });
    },
    onNotification(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    close() {
      ws.close();
    },
  };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error("failed to allocate a local port"));
        else resolve(port);
      });
    });
  });
}

async function waitForReady(
  url: string,
  child: ChildProcess | null,
  childError?: () => Error | null
): Promise<void> {
  const readyUrl =
    url.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/?$/, "/") +
    "readyz";
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const spawnError = childError?.();
    if (spawnError) {
      throw new LLMProviderError("codex", `failed to start codex app-server: ${spawnError.message}`);
    }
    if (child && child.exitCode !== null) {
      throw new LLMProviderError(
        "codex",
        `codex app-server exited before becoming ready with code ${child.exitCode}`
      );
    }
    try {
      const response = await fetch(readyUrl);
      if (response.ok) return;
      lastError = new Error(`readyz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new LLMProviderError("codex", `timed out waiting for local codex app-server: ${reason}`);
}

function assertLoopbackWebSocketUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LLMProviderError("codex", "Codex app-server URL is not a valid URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new LLMProviderError("codex", "Codex app-server URL must use ws:// or wss://");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!loopback) {
    throw new LLMProviderError("codex", "Codex app-server URL must point to localhost / loopback");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asProviderError(err: unknown): Error {
  return err instanceof Error ? err : new LLMProviderError("codex", String(err));
}

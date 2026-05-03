// AdDroid OSS — Codex app-server ImageProvider.
//
// Routes image generation through a local Codex app-server instead of the
// OpenAI Images API. This is intended for OAuth-backed Codex setups where the
// app-server owns the authenticated session. The WebSocket endpoint is
// restricted to loopback hosts to avoid turning image generation into an
// arbitrary network exfiltration path.

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";

import {
  ImageProviderError,
  ImageProviderInvalidRequestError,
  validateImageGenerateRequest,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImageProvider,
  type ImageProviderName,
  type ImageVariationCondition,
} from "./image-provider.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerRpcClient {
  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs?: number
  ): Promise<T>;
  onNotification(handler: (msg: CodexAppServerRpcNotification) => void): () => void;
  close(): void;
}

export interface CodexAppServerRpcNotification {
  method: string;
  params?: {
    threadId?: string;
    item?: {
      type?: string;
      id?: string;
      status?: string;
      savedPath?: string | null;
      result?: string | null;
      revisedPrompt?: string | null;
    };
    turn?: {
      status?: string;
    };
  };
}

export interface CodexAppServerHandle {
  url: string;
  child: ChildProcess | null;
  rpc: CodexAppServerRpcClient;
}

export interface CodexAppServerImageProviderOptions {
  defaultModel?: string;
  externalServerUrl?: string | null;
  codexBin?: string;
  cwd?: string;
  parallel?: number;
  timeoutMs?: number;
  serverFactory?: () => Promise<CodexAppServerHandle>;
  readFileImpl?: (path: string) => Promise<Uint8Array>;
}

const DEFAULT_MODEL = "local/codex-image";
const DEFAULT_TIMEOUT_MS = 600_000;

export class CodexAppServerImageProvider implements ImageProvider {
  readonly name: ImageProviderName = "codex";
  readonly defaultModel: string;
  readonly enabled = true;

  private readonly limit: ReturnType<typeof createLimiter>;
  private readonly cwd: string;
  private readonly externalServerUrl: string | null;
  private readonly codexBin: string;
  private readonly timeoutMs: number;
  private readonly serverFactory?: () => Promise<CodexAppServerHandle>;
  private readonly readFileImpl: (path: string) => Promise<Uint8Array>;
  private serverPromise: Promise<CodexAppServerHandle> | null = null;
  private exitHookInstalled = false;

  constructor(opts: CodexAppServerImageProviderOptions = {}) {
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.cwd = opts.cwd ?? process.env.ADDROID_CODEX_IMAGE_CWD ?? "/private/tmp";
    this.externalServerUrl =
      opts.externalServerUrl ??
      process.env.ADDROID_CODEX_APP_SERVER_URL ??
      process.env.CODEX_APP_SERVER_URL ??
      null;
    this.codexBin = opts.codexBin ?? process.env.CODEX_BIN ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.limit = createLimiter(normalizeParallel(opts.parallel));
    this.serverFactory = opts.serverFactory;
    this.readFileImpl = opts.readFileImpl ?? ((path) => readFile(path));
  }

  async generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    validateImageGenerateRequest(this.name, req);
    const model = req.model?.trim() || this.defaultModel;
    const normalizedConditions = normalizeVariationConditions(req);
    validateCodexConditions(this.name, normalizedConditions);

    const generatedAt = new Date().toISOString();
    const requestIds: string[] = [];
    const assets: ImageGeneratedAsset[] = [];

    for (const cond of normalizedConditions) {
      const generated = await this.limit(() =>
        this.callCodex({
          prompt: buildWorkerPrompt(req.prompt, cond),
          width: cond.width,
          height: cond.height,
        })
      );
      requestIds.push(generated.threadId);
      const bytes = new Uint8Array(await this.readFileImpl(generated.savedPath));
      assets.push({
        variantKey: cond.variantKey!,
        bytes,
        mimeType: "image/png",
        width: cond.width,
        height: cond.height,
        byteSize: bytes.byteLength,
      });
    }

    return {
      assets,
      meta: {
        provider: this.name,
        model,
        requestId: requestIds.length > 0 ? requestIds.join(",") : null,
        generatedAt,
        prompt: req.prompt,
        parameters: {
          variationConditions: normalizedConditions,
          purpose: req.purpose ?? null,
          variantCount: normalizedConditions.length,
        },
        qaResult: null,
      },
      costUsd: 0,
    };
  }

  private async callCodex(params: {
    prompt: string;
    width: number;
    height: number;
  }): Promise<{ threadId: string; savedPath: string }> {
    const { rpc } = await this.ensureServer();
    interface ThreadStartResult {
      thread: { id: string };
    }
    const thread = await rpc.request<ThreadStartResult>("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = thread.thread.id;
    const input = [
      {
        type: "text",
        text: params.prompt,
        text_elements: [],
      },
    ];

    const savedPath = await new Promise<string>((resolve, reject) => {
      let imageSeen: string | null = null;
      let settled = false;
      let off: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        off?.();
      };
      const settleSuccess = (value: string) => {
        cleanup();
        resolve(value);
      };
      const settleError = (err: Error) => {
        cleanup();
        reject(err);
      };

      timeout = setTimeout(() => {
        settleError(
          new ImageProviderError(
            this.name,
            `timeout waiting for codex image generation after ${Math.round(this.timeoutMs / 1000)}s`
          )
        );
      }, this.timeoutMs);

      off = rpc.onNotification((msg) => {
        if (msg.params?.threadId !== threadId) return;
        if (
          msg.method === "item/completed" &&
          msg.params.item?.type === "imageGeneration" &&
          !imageSeen
        ) {
          if (msg.params.item.savedPath) {
            imageSeen = msg.params.item.savedPath;
          } else {
            settleError(
              new ImageProviderError(
                this.name,
                "codex imageGeneration item completed without savedPath"
              )
            );
          }
          return;
        }
        if (msg.method === "turn/completed") {
          const status = msg.params.turn?.status ?? "unknown";
          if (status !== "completed") {
            settleError(new ImageProviderError(this.name, `codex turn ended with status ${status}`));
            return;
          }
          if (!imageSeen) {
            settleError(
              new ImageProviderError(
                this.name,
                "codex turn completed without an imageGeneration item"
              )
            );
            return;
          }
          settleSuccess(imageSeen);
        }
      });

      rpc.request("turn/start", { threadId, input }).catch((err) => {
        settleError(
          err instanceof ImageProviderError
            ? err
            : new ImageProviderError(this.name, `codex turn/start failed: ${(err as Error).message}`)
        );
      });
    });

    return { threadId, savedPath };
  }

  private ensureServer(): Promise<CodexAppServerHandle> {
    if (!this.serverPromise) {
      this.serverPromise = this.startServer().catch((err) => {
        this.serverPromise = null;
        throw err;
      });
    }
    return this.serverPromise;
  }

  private async startServer(): Promise<CodexAppServerHandle> {
    if (this.serverFactory) return this.serverFactory();

    if (this.externalServerUrl) {
      assertLoopbackWebSocketUrl(this.externalServerUrl);
      const rpc = createRpc(this.externalServerUrl);
      await this.initializeRpc(rpc);
      return { url: this.externalServerUrl, child: null, rpc };
    }

    const port = await findFreePort();
    const url = `ws://127.0.0.1:${port}`;
    const child = spawn(
      this.codexBin,
      ["-c", "mcp_servers={}", "app-server", "--listen", url],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout?.on("data", (chunk) =>
      process.stderr.write(`[codex-image] ${chunk}`)
    );
    child.stderr?.on("data", (chunk) =>
      process.stderr.write(`[codex-image] ${chunk}`)
    );
    child.on("exit", () => {
      this.serverPromise = null;
    });
    this.installExitHook(child);
    await waitForReady(url, child);
    const rpc = createRpc(url);
    await this.initializeRpc(rpc);
    return { url, child, rpc };
  }

  private async initializeRpc(rpc: CodexAppServerRpcClient): Promise<void> {
    await rpc.request("initialize", {
      clientInfo: {
        name: "addroid-codex-image",
        title: "AdDroid Codex image provider",
        version: "0.1.0",
      },
      capabilities: null,
    });
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

function normalizeParallel(value: number | undefined): number {
  const raw = value ?? Number(process.env.ADDROID_CODEX_IMAGE_PARALLEL ?? "5");
  return Number.isInteger(raw) && raw > 0 ? raw : 5;
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    job();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
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

async function waitForReady(url: string, child: ChildProcess | null): Promise<void> {
  const readyUrl =
    url.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/?$/, "/") +
    "readyz";
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new ImageProviderError(
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
  throw new ImageProviderError("codex", `timed out waiting for local codex app-server: ${reason}`);
}

function createRpc(url: string): CodexAppServerRpcClient {
  assertLoopbackWebSocketUrl(url);
  if (typeof globalThis.WebSocket !== "function") {
    throw new ImageProviderError("codex", "global WebSocket is not available in this Node runtime");
  }
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const handlers: Array<(msg: CodexAppServerRpcNotification) => void> = [];
  const ws = new globalThis.WebSocket(url);

  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new ImageProviderError("codex", `websocket error connecting to ${url}`));
  });

  ws.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const req = pending.get(message.id)!;
      pending.delete(message.id);
      clearTimeout(req.timer);
      if (message.error) req.reject(new ImageProviderError("codex", JSON.stringify(message.error)));
      else req.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of handlers) handler(message as CodexAppServerRpcNotification);
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
          reject(new ImageProviderError("codex", `timeout waiting for ${method}`));
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

function assertLoopbackWebSocketUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageProviderInvalidRequestError("codex", "Codex app-server URL is not a valid URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ImageProviderInvalidRequestError("codex", "Codex app-server URL must use ws:// or wss://");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!loopback) {
    throw new ImageProviderInvalidRequestError(
      "codex",
      "Codex app-server URL must point to localhost / loopback"
    );
  }
}

function normalizeVariationConditions(req: ImageGenerateRequest): ImageVariationCondition[] {
  return req.variationConditions.map((cond, idx) => {
    const out: ImageVariationCondition = {
      width: cond.width,
      height: cond.height,
      format: cond.format ?? "png",
      variantKey: cond.variantKey ?? `variant-${idx}`,
    };
    if (cond.styleNotes !== undefined) out.styleNotes = cond.styleNotes;
    if (cond.negativePrompt !== undefined) out.negativePrompt = cond.negativePrompt;
    return out;
  });
}

function validateCodexConditions(
  providerName: ImageProviderName,
  conditions: ImageVariationCondition[]
): void {
  for (let i = 0; i < conditions.length; i += 1) {
    const fmt = conditions[i]!.format ?? "png";
    if (fmt !== "png") {
      throw new ImageProviderInvalidRequestError(
        providerName,
        `variationConditions[${i}].format='${fmt}' is not supported by Codex app-server image generation (PNG only)`
      );
    }
  }
}

function buildWorkerPrompt(basePrompt: string, cond: ImageVariationCondition): string {
  const extras: string[] = [];
  if (cond.styleNotes?.trim()) extras.push(`Style notes: ${cond.styleNotes.trim()}`);
  if (cond.negativePrompt?.trim()) extras.push(`Avoid: ${cond.negativePrompt.trim()}`);
  const suffix = extras.length > 0 ? `\n\n${extras.join("\n")}` : "";
  return `${basePrompt.trim()}${suffix}

Use Codex image generation exactly once for this advertising creative.
Target image dimensions: ${cond.width}x${cond.height} (aspect ratio is the primary signal; exact pixel size does not need to match).
Do not browse the web. Do not create or edit files yourself; the runner will copy the generated image.
Final response: one short sentence.`;
}

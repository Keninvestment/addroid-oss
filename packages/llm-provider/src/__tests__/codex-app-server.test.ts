import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexAppServerLLMProvider,
  LLMNotImplementedError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
  type CodexLLMAppServerRpcClient,
  type CodexLLMAppServerRpcNotification,
} from "../index.js";

function makeRpc(opts: {
  account?: { email: string; planType?: string } | null;
  turnNotifications?: CodexLLMAppServerRpcNotification[];
} = {}) {
  const handlers: Array<(msg: CodexLLMAppServerRpcNotification) => void> = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: CodexLLMAppServerRpcClient = {
    async request<T = unknown>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "account/read") {
        return { account: opts.account ?? null, requiresOpenaiAuth: true } as T;
      }
      if (method === "account/login/start") {
        return { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example.test/" } as T;
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-5.5-codex-local" } as T;
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const h of handlers) {
            for (const notification of opts.turnNotifications ?? [
              {
                method: "item/agentMessage/delta",
                params: { threadId: "thread-1", turnId: "turn-1", delta: "OK" },
              },
              {
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: { id: "turn-1", status: "completed" },
                },
              },
            ]) h(notification);
          }
        });
        return { turn: { id: "turn-1", status: "inProgress" } } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    onNotification(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    close() {},
  };
  return { rpc, calls };
}

test("CodexAppServerLLMProvider.getConnection reads the local app-server account", async () => {
  const { rpc } = makeRpc({ account: { email: "owner@example.test", planType: "pro" } });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
    now: () => new Date("2026-05-08T00:00:00Z"),
  });
  assert.equal(provider.authKind, "app_server");
  const conn = await provider.getConnection();
  assert.equal(conn?.provider, "codex");
  assert.equal(conn?.accountIdentifier, "owner@example.test");
  assert.equal(conn?.defaultModel, "codex-app-server");
  assert.deepEqual(conn?.scopes, ["codex-app-server"]);
});

test("CodexAppServerLLMProvider.complete runs a turn through app-server", async () => {
  const { rpc, calls } = makeRpc({ account: { email: "owner@example.test" } });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });
  const result = await provider.complete({
    messages: [
      { role: "system", content: "Return short answers." },
      { role: "user", content: "Say OK." },
    ],
  });
  assert.equal(result.content, "OK");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.meta.provider, "codex");
  assert.equal(result.meta.model, "gpt-5.5-codex-local");
  assert.equal(result.meta.requestId, "thread-1");
  assert.ok(calls.some((c) => c.method === "thread/start"));
  assert.ok(calls.some((c) => c.method === "turn/start"));
});

test("CodexAppServerLLMProvider.complete rejects a non-retrying error notification", async () => {
  const secret = "sk-test-codex-secret";
  const { rpc } = makeRpc({
    account: { email: "owner@example.test" },
    turnNotifications: [{
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: `provider failed with ${secret} ${"x".repeat(600)}` },
      },
    }],
  });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });

  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "x" }] }),
    (err: unknown) => {
      assert.ok(err instanceof LLMProviderError);
      assert.match(err.message, /provider failed with sk-\[REDACTED\]/);
      assert.doesNotMatch(err.message, new RegExp(secret));
      assert.ok(err.message.length <= 500);
      return true;
    }
  );
});

test("CodexAppServerLLMProvider.complete keeps waiting after a retrying error", async () => {
  const { rpc } = makeRpc({
    account: { email: "owner@example.test" },
    turnNotifications: [
      {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
          error: { message: "temporary failure" },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "RECOVERED" },
      },
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      },
    ],
  });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });

  const result = await provider.complete({ messages: [{ role: "user", content: "x" }] });
  assert.equal(result.content, "RECOVERED");
  assert.equal(result.finishReason, "stop");
});

test("CodexAppServerLLMProvider.complete rejects a failed completed turn with its error", async () => {
  const { rpc } = makeRpc({
    account: { email: "owner@example.test" },
    turnNotifications: [{
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "sandbox initialization failed" },
        },
      },
    }],
  });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });

  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "x" }] }),
    (err: unknown) => {
      assert.ok(err instanceof LLMProviderError);
      assert.match(err.message, /status failed: sandbox initialization failed/);
      return true;
    }
  );
});

test("CodexAppServerLLMProvider.complete rejects a completed turn with empty assistant text", async () => {
  const { rpc } = makeRpc({
    account: { email: "owner@example.test" },
    turnNotifications: [{
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    }],
  });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });

  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "x" }] }),
    /codex turn completed with empty assistant message/
  );
});

test("CodexAppServerLLMProvider.complete forwards local image input to app-server", async () => {
  const { rpc, calls } = makeRpc({ account: { email: "owner@example.test" } });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });
  await provider.complete({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "この参照画像を読んでください。" },
          {
            type: "image",
            mimeType: "image/png",
            localPath: "/tmp/addroid-reference.png",
            sourceRef: "storage://wins/ref.png",
          },
        ],
      },
    ],
  });
  const turnStart = calls.find((c) => c.method === "turn/start");
  assert.ok(turnStart);
  const params = turnStart.params as { input?: Array<Record<string, unknown>> };
  assert.ok(params.input?.some((item) =>
    item.type === "localImage" && item.path === "/tmp/addroid-reference.png"
  ));
});

test("CodexAppServerLLMProvider.complete requires an app-server account", async () => {
  const { rpc } = makeRpc({ account: null });
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });
  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "x" }] }),
    LLMProviderUnauthenticatedError
  );
});

test("CodexAppServerLLMProvider keeps OAuth token exchange unsupported", async () => {
  const { rpc } = makeRpc();
  const provider = new CodexAppServerLLMProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:1", child: null, rpc }),
  });
  await assert.rejects(
    () => provider.completeOAuth(),
    LLMNotImplementedError
  );
});

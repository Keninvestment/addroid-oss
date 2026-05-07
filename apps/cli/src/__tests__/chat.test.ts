import test from "node:test";
import assert from "node:assert/strict";

import { runChatCommand } from "../commands/chat.js";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
} from "@addroid/llm-provider";

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture(
  fn: () => Promise<number>
): Promise<{ code: number; out: Captured }> {
  const out: Captured = { stdout: "", stderr: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    out.stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    out.stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function fakeProvider(content: string): LLMProvider {
  return {
    name: "mock",
    authKind: "oauth",
    defaultModel: "mock-small",
    async beginOAuth() {
      return { authorizationUrl: "https://example.invalid", state: "s" };
    },
    async completeOAuth() {
      throw new Error("not used");
    },
    async refreshToken() {
      throw new Error("not used");
    },
    async disconnect() {
      return true;
    },
    async getConnection() {
      return {
        provider: "mock",
        accountIdentifier: "mock-user",
        scopes: [],
        connectedAt: new Date(0).toISOString(),
        expiresAt: null,
        defaultModel: "mock-small",
      };
    },
    async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
      return {
        content,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        meta: {
          provider: "mock",
          model: "mock-small",
          requestId: "mock-req",
          accountIdentifier: "mock-user",
        },
        costUsd: 0,
      };
    },
    async generateImage() {
      throw new Error("not used");
    },
    async embed() {
      throw new Error("not used");
    },
  };
}

test("chat --help は使い方と例を表示する", async () => {
  const { code, out } = await capture(() => runChatCommand(["--help"]));
  assert.equal(code, 0);
  assert.match(out.stdout, /addroid chat/);
  assert.match(out.stdout, /日次レポート/);
});

test("chat --once は LLM の command plan を addroid command として実行する", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const provider = fakeProvider(
    JSON.stringify({
      type: "commands",
      summary: "日次レポートを実行します。",
      commands: [{ command: "cron", args: ["run", "daily_report"], why: "レポート取得" }],
    })
  );
  const { code, out } = await capture(() =>
    runChatCommand(["--once", "日次レポートを取得", "--yes"], {
      provider,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    })
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /addroid cron run daily_report/);
  assert.deepEqual(calls, [{ command: "cron", args: ["run", "daily_report"] }]);
});

test("chat は plan に --dry-run を強制する", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const provider = fakeProvider(
    JSON.stringify({
      type: "commands",
      commands: [{ command: "plan", args: [], why: "入稿前チェック" }],
    })
  );
  const { code } = await capture(() =>
    runChatCommand(["--once", "入稿前チェック"], {
      provider,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    })
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ command: "plan", args: ["--dry-run"] }]);
});

test("chat は副作用のある command を確認なしに実行しない", async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider(
    JSON.stringify({
      type: "commands",
      commands: [{ command: "auth", args: ["github"], why: "GitHub 接続" }],
    })
  );
  const { code, out } = await capture(() =>
    runChatCommand(["--once", "GitHubを接続"], {
      provider,
      confirm: async () => false,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    })
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /skipped/);
  assert.deepEqual(calls, []);
});


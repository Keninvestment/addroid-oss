import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

import {
  __testReadChatLine,
  __testReadChatSessionSelection,
  runChatCommand,
} from "../commands/chat.js";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
} from "@addroid/llm-provider";

interface Captured {
  stdout: string;
  stderr: string;
}

class FakeTtyInput extends PassThrough {
  isTTY = true;
  rawMode = false;
  setRawMode(value: boolean): this {
    this.rawMode = value;
    return this;
  }
}

class FakeTtyOutput extends Writable {
  isTTY = true;
  columns = 80;
  output = "";
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    callback();
  }
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

test("rich chat prompt は Shift+Enter を改行、Enter を送信として扱う", async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const answerPromise = __testReadChatLine(input, output);

  input.write("hello");
  input.write("\u001b[13;2u");
  input.write("world");
  input.write("\r");

  assert.equal(await answerPromise, "hello\nworld");
  assert.equal(input.rawMode, false);
});

test("rich chat prompt は /re の候補に resume と report を表示する", async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const answerPromise = __testReadChatLine(input, output);

  input.write("/re");
  await Promise.resolve();

  assert.match(output.output, /\/resume/);
  assert.match(output.output, /\/report/);

  input.write("\r");
  assert.equal(await answerPromise, "/resume");
  assert.equal(input.rawMode, false);
});

test("resume selector は上下キーで会話を選択して Enter で確定する", async () => {
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const sessions = [
    {
      id: "session-a",
      title: "cli: 最初の会話",
      updatedAt: "2026-05-16T10:00:00.000Z",
      count: 1,
    },
    {
      id: "session-b",
      title: "dashboard: 次の会話",
      updatedAt: "2026-05-16T11:00:00.000Z",
      count: 2,
    },
  ];
  const selectionPromise = __testReadChatSessionSelection(sessions, input, output);

  input.write("\u001b[B");
  input.write("\r");

  assert.deepEqual(await selectionPromise, sessions[1]);
  assert.match(output.output, /dashboard: 次の会話/);
  assert.equal(input.rawMode, false);
});

test("chat --once は LLM の command plan を addroid command として実行する", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const provider = fakeProvider(
    JSON.stringify({
      message: "日次レポートを実行します。",
      tools: [{ name: "get_report", args: { kind: "daily" }, why: "レポート取得" }],
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
  assert.match(out.stdout, /addroid report daily/);
  assert.deepEqual(calls, [{ command: "report", args: ["daily"] }]);
});

test("chat は入稿前チェックを submit にまとめる", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const provider = fakeProvider(
    JSON.stringify({
      message: "入稿前チェックを実行します。",
      tools: [{ name: "check_submission", args: {}, why: "入稿前チェック" }],
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
  assert.deepEqual(calls, [{ command: "submit", args: [] }]);
});

test("chat は副作用のある tool も確認なしで実行する", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const provider = fakeProvider(
    JSON.stringify({
      message: "GitHub 接続を開始します。",
      tools: [{ name: "connect_service", args: { service: "github" }, why: "GitHub 接続" }],
    })
  );
  const { code, out } = await capture(() =>
    runChatCommand(["--once", "GitHubを接続"], {
      provider,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    })
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /addroid connect github/);
  assert.deepEqual(calls, [{ command: "connect", args: ["github"] }]);
});

test("chat は危険 tool をコード側 policy で拒否する", async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider(
    JSON.stringify({
      message: "DB を復元します。",
      tools: [{ name: "restore_db", args: { file: "backup.dump" }, why: "復元" }],
    })
  );
  const { code, out } = await capture(() =>
    runChatCommand(["--once", "前の状態に戻して"], {
      provider,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    })
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /denied: restore_db/);
  assert.deepEqual(calls, []);
});

test("chat は本番配信に影響する direct activation を実行しない", async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider(
    JSON.stringify({
      message: "直接の配信開始は実行しません。",
      tools: [{ name: "start_delivery", args: { hierarchyId: "cmp_1" }, why: "配信開始" }],
    })
  );
  const { code, out } = await capture(() =>
    runChatCommand(["--once", "このキャンペーンを配信開始して"], {
      provider,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    })
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /unsupported tool: start_delivery/);
  assert.deepEqual(calls, []);
});

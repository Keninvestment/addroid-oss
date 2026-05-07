import assert from "node:assert/strict";
import test from "node:test";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMConnectionMeta,
  LLMProvider,
} from "@addroid/llm-provider";
import { runAgentTurn } from "../runtime.js";

test("runAgentTurn falls back to a safe daily report tool when LLM returns 429", async () => {
  const provider = new ThrowingProvider("chat completions endpoint returned HTTP 429", 429);
  const result = await runAgentTurn({
    input: "日次レポートを取得して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
  });

  assert.match(result.message, /定型操作として実行します/);
  assert.equal(result.toolResults.length, 1);
  const tool = result.toolResults[0]!;
  assert.equal(tool.status, "ready");
  if (tool.status === "ready") {
    assert.equal(tool.tool, "get_report");
    assert.deepEqual(tool.toolArgs, { kind: "daily" });
  }
});

class ThrowingProvider implements LLMProvider {
  readonly name = "codex";
  readonly authKind = "oauth";
  readonly defaultModel = "gpt-4.1";

  constructor(
    private readonly message: string,
    private readonly status: number
  ) {}

  async beginOAuth(): Promise<never> {
    throw new Error("not implemented");
  }

  async completeOAuth(): Promise<never> {
    throw new Error("not implemented");
  }

  async refreshToken(): Promise<never> {
    throw new Error("not implemented");
  }

  async disconnect(): Promise<boolean> {
    return false;
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    return {
      provider: "codex",
      accountIdentifier: "test",
      scopes: [],
      connectedAt: new Date(0).toISOString(),
      expiresAt: null,
      defaultModel: this.defaultModel,
    };
  }

  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const err = new Error(`[codex] ${this.message}`) as Error & { status: number };
    err.status = this.status;
    throw err;
  }

  async generateImage(): Promise<never> {
    throw new Error("not implemented");
  }

  async embed(): Promise<never> {
    throw new Error("not implemented");
  }
}

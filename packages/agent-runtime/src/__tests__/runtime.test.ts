import assert from "node:assert/strict";
import test from "node:test";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMConnectionMeta,
  LLMProvider,
} from "@addroid/llm-provider";
import {
  buildAgentSystemPrompt,
  evaluateAgentToolPolicy,
  runAgentTurn,
} from "../runtime.js";

test("runAgentTurn does not infer natural-language tools when LLM returns 429", async () => {
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

  assert.match(result.message, /操作は実行しませんでした/);
  assert.equal(result.toolResults.length, 0);
});

test("query_meta_ads policy allows read-only catalog/product queries and denies mutations", () => {
  assert.equal(
    evaluateAgentToolPolicy("query_meta_ads", { resource: "product_feed", action: "list", catalogId: "123" }).allowed,
    true
  );
  assert.equal(
    evaluateAgentToolPolicy("query_meta_ads", { resource: "catalog", action: "get", id: "123" }).allowed,
    true
  );
  const denied = evaluateAgentToolPolicy("query_meta_ads", {
    resource: "campaign",
    action: "update",
    id: "123",
    status: "ACTIVE",
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /read-only/);
});

test("system prompt exposes scheduled task creation to chat surfaces only", () => {
  const context = {
    content: "test agent context",
    webUrl: "http://127.0.0.1:3000",
    loadedDocs: ["test"],
  };
  assert.match(
    buildAgentSystemPrompt(context, "cli-chat"),
    /create_scheduled_agent_task/
  );
  assert.doesNotMatch(
    buildAgentSystemPrompt(context, "scheduled-agent"),
    /create_scheduled_agent_task/
  );
});

test("runAgentTurn resolves create_scheduled_agent_task on cli-chat", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "設定します。",
      tools: [
        {
          name: "create_scheduled_agent_task",
          args: {
            prompt: "前日分の日次レポートを作成して要約する",
            cron: "0 9 * * *",
          },
          why: "毎朝の定期レポート",
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "毎朝9時に前日のレポートを作って",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "cli-chat",
  });
  assert.equal(result.toolResults[0]?.status, "ready");
  const tool = result.toolResults[0];
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "create_scheduled_agent_task");
  assert.equal(tool.command, null);
  assert.equal(tool.toolArgs.cron, "0 9 * * *");
});

test("runAgentTurn denies unavailable tools on scheduled-agent surface", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "設定します。",
      tools: [
        {
          name: "create_scheduled_agent_task",
          args: { prompt: "x", cron: "0 9 * * *" },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "さらに毎朝実行して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "scheduled-agent",
  });
  assert.equal(result.toolResults[0]?.status, "unsupported");
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

class StaticProvider implements LLMProvider {
  readonly name = "mock";
  readonly authKind = "oauth";
  readonly defaultModel = "mock-small";

  constructor(private readonly content: string) {}

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
    return null;
  }

  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    return {
      content: this.content,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      meta: {
        provider: "mock",
        model: this.defaultModel,
        requestId: "static-req",
        accountIdentifier: "static-user",
      },
      costUsd: 0,
    };
  }

  async generateImage(): Promise<never> {
    throw new Error("not implemented");
  }

  async embed(): Promise<never> {
    throw new Error("not implemented");
  }
}

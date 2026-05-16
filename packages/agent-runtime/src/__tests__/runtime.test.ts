import assert from "node:assert/strict";
import test from "node:test";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMConnectionMeta,
  LLMProvider,
} from "@addroid/llm-provider";
import {
  buildAgentLoopInput,
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

test("system prompt exposes read-only Meta query and GitOps proposal to scheduled agents", () => {
  const context = {
    content: "test agent context",
    webUrl: "http://127.0.0.1:3000",
    loadedDocs: ["test"],
  };
  const prompt = buildAgentSystemPrompt(context, "scheduled-agent");
  assert.match(prompt, /query_meta_ads/);
  assert.match(prompt, /propose_ops_change/);
  assert.doesNotMatch(prompt, /^- start_delivery:/m);
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

test("runAgentTurn resolves approval decisions on interactive chat surfaces only", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "承認します。",
      tools: [
        {
          name: "decide_approval",
          args: { prNumber: 12, decision: "approve" },
          why: "ユーザーがPR承認を依頼したため",
        },
      ],
    })
  );
  const context = {
    content: "test agent context",
    webUrl: "http://127.0.0.1:3000",
    loadedDocs: ["test"],
  };
  const interactive = await runAgentTurn({
    input: "PR #12 を承認して",
    provider,
    agentContext: context,
    purpose: "test",
    surface: "cli-chat",
  });
  const tool = interactive.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "decide_approval");
  assert.equal(tool.command, null);
  assert.equal(tool.toolArgs.prNumber, 12);

  const scheduled = await runAgentTurn({
    input: "PR #12 を承認して",
    provider,
    agentContext: context,
    purpose: "test",
    surface: "scheduled-agent",
  });
  assert.equal(scheduled.toolResults[0]?.status, "unsupported");
});

test("runAgentTurn keeps nested proposal args and rejects direct activation on chat surfaces", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "PRを作成します。",
      tools: [
        {
          name: "propose_ops_change",
          args: {
            intent: "pause",
            accountKey: "act_123",
            targets: [{ level: "campaign", id: "cmp_1" }],
            desiredChanges: { initialState: "PAUSED", budget: { dailyBudget: 10 } },
            rationale: "CV0のため",
          },
        },
        {
          name: "start_delivery",
          args: { hierarchyId: "cmp_2" },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "CV0のキャンペーンを止めて",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "cli-chat",
  });

  const proposal = result.toolResults[0];
  assert.equal(proposal?.status, "ready");
  if (proposal?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(proposal.tool, "propose_ops_change");
  assert.deepEqual(proposal.toolArgs.targets, [{ level: "campaign", id: "cmp_1" }]);
  assert.deepEqual(proposal.toolArgs.desiredChanges, {
    initialState: "PAUSED",
    budget: { dailyBudget: 10 },
  });
  assert.equal(result.toolResults[1]?.status, "unsupported");
});

test("runAgentTurn resolves creative submission as a GitOps PR tool", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "入稿PRを作成します。",
      tools: [
        {
          name: "propose_creative_submission",
          args: {
            accountKey: "act_123",
            creativeName: "spring-sale",
            adName: "春セール広告",
            headline: "春だけの特典",
            primaryText: "新商品を今すぐ確認できます。",
            campaignId: "cmp_1",
            adsetId: "as_1",
            localMediaPaths: ["/tmp/spring.png"],
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "この画像でMeta広告に入稿して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "cli-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "propose_creative_submission");
  assert.equal(tool.command, null);
  assert.deepEqual(tool.toolArgs.localMediaPaths, ["/tmp/spring.png"]);
});

test("runAgentTurn resolves creative generation as a library-only tool on chat surfaces", async () => {
  for (const surface of ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"] as const) {
    const provider = new StaticProvider(
      JSON.stringify({
        message: "生成します。",
        tools: [
          {
            name: "generate_creatives",
            args: {
              accountKey: "act_123",
              prompt: "添付画像と既存広告を参考に新しいクリエイティブを生成",
              referenceImagePaths: ["/tmp/ref.png"],
            },
          },
        ],
      })
    );
    const result = await runAgentTurn({
      input: "この画像を参考に新しいクリエイティブを生成して",
      provider,
      agentContext: {
        content: "test agent context",
        webUrl: "http://127.0.0.1:3000",
        loadedDocs: ["test"],
      },
      purpose: "test",
      surface,
    });
    const tool = result.toolResults[0];
    assert.equal(tool?.status, "ready");
    if (tool?.status !== "ready") throw new Error(`expected ready tool for ${surface}`);
    assert.equal(tool.tool, "generate_creatives");
    assert.equal(tool.command, null);
    assert.deepEqual(tool.toolArgs.referenceImagePaths, ["/tmp/ref.png"]);
  }
});

test("runAgentTurn keeps creative submission args for new adset placement", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "広告セット作成PRを作成します。",
      tools: [
        {
          name: "propose_creative_submission",
          args: {
            accountKey: "act_123",
            creativeName: "summer-sale",
            adName: "夏セール広告",
            headline: "夏の特典",
            primaryText: "新しい広告セットで配信します。",
            campaignId: "cmp_1",
            adsetName: "JP 25-44",
            countries: ["JP"],
            callToAction: "OPEN_LINK",
            optimizationGoal: "LINK_CLICKS",
            billingEvent: "IMPRESSIONS",
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "既存キャンペーン cmp_1 の下に新しい広告セットを作って入稿して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "slack-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "propose_creative_submission");
  assert.equal(tool.toolArgs.campaignId, "cmp_1");
  assert.equal(tool.toolArgs.adsetName, "JP 25-44");
  assert.deepEqual(tool.toolArgs.countries, ["JP"]);
  assert.equal(tool.toolArgs.callToAction, "OPEN_LINK");
  assert.equal(tool.toolArgs.optimizationGoal, "LINK_CLICKS");
  assert.equal(tool.toolArgs.billingEvent, "IMPRESSIONS");
});

test("buildAgentLoopInput includes prior tool results for multi-step reasoning", () => {
  const input = buildAgentLoopInput("CV0を確認して必要なら止めて", [
    {
      display: "Meta Ads CLI read-only query",
      status: "success",
      message: "2件取得しました",
      data: { rows: [{ campaign_id: "cmp_1", conversions: 0 }] },
    },
  ]);
  assert.match(input, /Original user request:/);
  assert.match(input, /Tool results already executed/);
  assert.match(input, /cmp_1/);
  assert.match(input, /Do not repeat a successful tool call/);
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

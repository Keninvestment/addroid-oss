import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_AGENTS,
  AI_RUN_LINKED_REF_TYPES,
  AI_RUN_STATUSES,
  AI_WORKFLOWS,
  AiRunValidationError,
  buildAiRunCreateInput,
  buildAiRunCreateInputFromCompletion,
  sanitizeAiRunPayload,
  type LLMCompletionResult,
} from "../index.js";

test("contract C agent + workflow + status enums match the spec", () => {
  assert.deepEqual(
    [...AI_AGENTS],
    [
      "strategy",
      "copy",
      "image_prompt",
      "creative_qa",
      "analyst",
      "media_buyer",
      "gitops",
      "audit",
    ]
  );
  assert.deepEqual(
    [...AI_WORKFLOWS],
    ["daily_report", "budget_guard", "improvement_pr", "adhoc"]
  );
  assert.deepEqual([...AI_RUN_STATUSES], ["queued", "running", "succeeded", "failed"]);
  // linkedRefType must cover all entities the UI plan deep-links from /ai/runs/[id].
  for (const t of [
    "performance_snapshot",
    "github_pull_request",
    "cron_run",
    "audit_log",
    "improvement_pr",
  ]) {
    assert.ok(
      (AI_RUN_LINKED_REF_TYPES as readonly string[]).includes(t),
      `missing linkedRefType: ${t}`
    );
  }
});

test("sanitizeAiRunPayload redacts secret-keyed object fields recursively", () => {
  const input = {
    headers: {
      Authorization: "Bearer sk-abcdef0123456789",
      "x-api-key": "sk-real-secret-1234",
    },
    body: {
      access_token: "real-secret-value",
      refresh_token: "another-secret",
      id_token: "eyJ.payload.signature",
      messages: [
        { role: "user", content: "Use Bearer sk-zzz1234567890abcdef to call." },
      ],
    },
    nested: { CLIENT_SECRET: "should-be-dropped", api_key: "still-dropped" },
  };
  const out = sanitizeAiRunPayload(input) as {
    headers: { Authorization: string; "x-api-key": string };
    body: {
      access_token: string;
      refresh_token: string;
      id_token: string;
      messages: { role: string; content: string }[];
    };
    nested: { CLIENT_SECRET: string; api_key: string };
  };
  assert.equal(out.headers.Authorization, "[REDACTED]");
  // x-api-key is a non-standard variant — should not be wholesale-redacted but
  // its sk- value should be string-sanitized.
  assert.equal(out.headers["x-api-key"], "sk-[REDACTED]");
  assert.equal(out.body.access_token, "[REDACTED]");
  assert.equal(out.body.refresh_token, "[REDACTED]");
  assert.equal(out.body.id_token, "[REDACTED]");
  assert.match(out.body.messages[0]!.content, /Bearer \[REDACTED\]/);
  assert.equal(out.nested.CLIENT_SECRET, "[REDACTED]");
  assert.equal(out.nested.api_key, "[REDACTED]");
});

test("sanitizeAiRunPayload preserves benign values (numbers, booleans, structure)", () => {
  const input = {
    workflow: "daily_report",
    metrics: { spend: 12345, ctr: 0.045, paused: false },
    nested: ["a", { ok: true, count: 7 }],
    nullable: null,
  };
  const out = sanitizeAiRunPayload(input);
  assert.deepEqual(out, input);
});

test("sanitizeAiRunPayload redacts env var assignments inside strings", () => {
  const out = sanitizeAiRunPayload({
    note: "OPENAI_API_KEY=sk-deadbeef0123456789 was leaked in a log",
  }) as { note: string };
  assert.match(out.note, /OPENAI_API_KEY=\[REDACTED\]/);
  // The sk- substring must also be sanitized as a defensive second pass.
  assert.ok(!out.note.includes("sk-deadbeef0123456789"));
});

test("sanitizeAiRunPayload truncates pathologically long strings", () => {
  const long = "x".repeat(50_000);
  const out = sanitizeAiRunPayload({ raw: long }) as { raw: string };
  assert.ok(out.raw.length < long.length);
  assert.match(out.raw, /\[truncated\]$/);
});

test("buildAiRunCreateInput rejects unknown agent", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        // @ts-expect-error — exercising runtime validation
        agent: "unknown-agent",
        workflow: "daily_report",
        provider: "codex",
        model: "gpt-4.1",
        inputs: {},
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput rejects unknown workflow", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        agent: "analyst",
        // @ts-expect-error — exercising runtime validation
        workflow: "creative",
        provider: "codex",
        model: "gpt-4.1",
        inputs: {},
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput rejects unknown provider", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        agent: "analyst",
        workflow: "daily_report",
        // @ts-expect-error — exercising runtime validation
        provider: "gemini",
        model: "gpt-4.1",
        inputs: {},
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput rejects empty workspaceId / model", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "",
        agent: "analyst",
        workflow: "daily_report",
        provider: "codex",
        model: "gpt-4.1",
        inputs: {},
      }),
    AiRunValidationError
  );
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        agent: "analyst",
        workflow: "daily_report",
        provider: "codex",
        model: "",
        inputs: {},
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput rejects out-of-range or non-finite confidence", () => {
  for (const c of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        buildAiRunCreateInput({
          workspaceId: "ws-1",
          agent: "analyst",
          workflow: "daily_report",
          provider: "codex",
          model: "gpt-4.1",
          inputs: {},
          confidence: c,
        }),
      AiRunValidationError,
      `confidence ${c} should be rejected`
    );
  }
});

test("buildAiRunCreateInput accepts confidence=0 and confidence=1", () => {
  const lo = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    provider: "codex",
    model: "gpt-4.1",
    inputs: {},
    confidence: 0,
  });
  assert.equal(lo.confidence, 0);
  const hi = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    provider: "codex",
    model: "gpt-4.1",
    inputs: {},
    confidence: 1,
  });
  assert.equal(hi.confidence, 1);
});

test("buildAiRunCreateInput requires linkedRefId when linkedRefType is set", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        agent: "analyst",
        workflow: "daily_report",
        provider: "codex",
        model: "gpt-4.1",
        inputs: {},
        linkedRefType: "performance_snapshot",
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput requires linkedRefType when linkedRefId is set", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        agent: "analyst",
        workflow: "daily_report",
        provider: "codex",
        model: "gpt-4.1",
        inputs: {},
        linkedRefId: "snapshot-1",
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput rejects unknown linkedRefType", () => {
  assert.throws(
    () =>
      buildAiRunCreateInput({
        workspaceId: "ws-1",
        agent: "analyst",
        workflow: "daily_report",
        provider: "codex",
        model: "gpt-4.1",
        inputs: {},
        // @ts-expect-error — exercising runtime validation
        linkedRefType: "creative",
        linkedRefId: "foo",
      }),
    AiRunValidationError
  );
});

test("buildAiRunCreateInput estimates costUsd from usage when not provided", () => {
  const created = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    provider: "codex",
    model: "gpt-4.1",
    inputs: {},
    usage: { inputTokens: 1000, outputTokens: 500 },
  });
  // codex/gpt-4.1: input $0.005/1k + output $0.015/1k → 0.005 + 0.0075 = 0.0125
  assert.equal(created.costUsd, 0.0125);
  assert.equal(created.inputTokens, 1000);
  assert.equal(created.outputTokens, 500);
});

test("buildAiRunCreateInput respects an explicit costUsd over the estimator", () => {
  const created = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    provider: "codex",
    model: "gpt-4.1",
    inputs: {},
    usage: { inputTokens: 1000, outputTokens: 500 },
    costUsd: 0.02,
  });
  assert.equal(created.costUsd, 0.02);
});

test("buildAiRunCreateInput sanitizes prompt / inputs / outputs / requestId", () => {
  const created = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "copy",
    workflow: "improvement_pr",
    provider: "codex",
    model: "gpt-4.1",
    inputs: { adAccountId: "act_123", note: "Bearer sk-secret-input-1234" },
    prompt: [{ role: "user", content: "Authorization: Bearer sk-prompt-secret-1234567" }],
    outputs: { rawHeader: "x-api-key: sk-output-secret-12345" },
    requestId: "req_xyz Bearer sk-leaked-rid-12345",
  });
  const promptStr = JSON.stringify(created.prompt);
  const inputsStr = JSON.stringify(created.inputs);
  const outputsStr = JSON.stringify(created.outputs);
  assert.ok(!promptStr.includes("sk-prompt-secret-1234567"));
  assert.ok(!inputsStr.includes("sk-secret-input-1234"));
  assert.ok(!outputsStr.includes("sk-output-secret-12345"));
  assert.ok(created.requestId);
  assert.ok(!created.requestId!.includes("sk-leaked-rid-12345"));
});

test("buildAiRunCreateInput defaults: status=queued, costUsd=0, tokens=0, nullable refs", () => {
  const created = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "audit",
    workflow: "adhoc",
    provider: "mock",
    model: "mock-small",
    inputs: { reason: "smoke test" },
  });
  assert.equal(created.status, "queued");
  assert.equal(created.inputTokens, 0);
  assert.equal(created.outputTokens, 0);
  assert.equal(created.costUsd, 0);
  assert.equal(created.confidence, null);
  assert.equal(created.decision, null);
  assert.equal(created.outputs, null);
  assert.equal(created.prompt, null);
  assert.equal(created.linkedRefType, null);
  assert.equal(created.linkedRefId, null);
  assert.equal(created.requestId, null);
});

test("buildAiRunCreateInputFromCompletion fills provider/model/usage/cost/requestId from result", () => {
  const result: LLMCompletionResult = {
    content: "This is the response.",
    finishReason: "stop",
    usage: { inputTokens: 200, outputTokens: 100 },
    meta: {
      provider: "codex",
      model: "gpt-4.1",
      requestId: "req_xyz",
      accountIdentifier: "user@example.com",
    },
    costUsd: 0.0025,
  };
  const created = buildAiRunCreateInputFromCompletion({
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    prompt: [
      { role: "system", content: "You are an analyst." },
      { role: "user", content: "Summarize the period." },
    ],
    inputs: { period: "2026-04-30" },
    result,
    decision: "report_only",
    confidence: 0.78,
    linkedRefType: "performance_snapshot",
    linkedRefId: "snapshot-1",
  });
  assert.equal(created.provider, "codex");
  assert.equal(created.model, "gpt-4.1");
  assert.equal(created.requestId, "req_xyz");
  assert.equal(created.inputTokens, 200);
  assert.equal(created.outputTokens, 100);
  assert.equal(created.costUsd, 0.0025);
  assert.equal(created.decision, "report_only");
  assert.equal(created.confidence, 0.78);
  assert.equal(created.linkedRefType, "performance_snapshot");
  assert.equal(created.linkedRefId, "snapshot-1");
  assert.equal(created.status, "succeeded");
  // outputs should preserve content + finishReason as a sanitize-safe object.
  assert.deepEqual(created.outputs, {
    content: "This is the response.",
    finishReason: "stop",
  });
});

test("buildAiRunCreateInput clamps negative / non-finite token counts to 0", () => {
  const created = buildAiRunCreateInput({
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    provider: "codex",
    model: "gpt-4.1",
    inputs: {},
    usage: { inputTokens: -10, outputTokens: Number.NaN as unknown as number },
  });
  assert.equal(created.inputTokens, 0);
  assert.equal(created.outputTokens, 0);
  assert.equal(created.costUsd, 0);
});

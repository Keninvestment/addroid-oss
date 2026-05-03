// `@addroid/config` slack-notifications のユニットテスト。
// fetch を注入できるシグネチャを持っているので、Slack に出ずに送信パスまで網羅する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSlackNotificationMessage,
  dispatchResultToError,
  dispatchSlackNotification,
  sanitizeForSlack,
  type NotificationAuditInput,
  type NotificationAuditWriter,
  type SlackBlockKitBlock,
  type SlackBlockKitMessage,
  type SlackFetch,
  type SlackNotificationPayload,
} from "../index.js";

// ---- helpers --------------------------------------------------------------

function blockTexts(message: SlackBlockKitMessage): string[] {
  const out: string[] = [];
  for (const b of message.blocks) {
    switch (b.type) {
      case "header":
        out.push(b.text.text);
        break;
      case "section":
        if (b.text) out.push(b.text.text);
        if (b.fields) for (const f of b.fields) out.push(f.text);
        break;
      case "context":
        for (const e of b.elements) out.push(e.text);
        break;
      case "actions":
        for (const e of b.elements) out.push(e.text.text + (e.url ?? ""));
        break;
      case "divider":
        break;
    }
  }
  return out;
}

function findHeader(blocks: SlackBlockKitBlock[]): string | null {
  for (const b of blocks) if (b.type === "header") return b.text.text;
  return null;
}

function fakePostMessageFetch(response: {
  ok?: boolean;
  status?: number;
  payload: unknown;
  capture?: { url?: string; body?: string; auth?: string };
}): SlackFetch {
  return async (url, init) => {
    if (response.capture) {
      response.capture.url = url;
      response.capture.body = init.body;
      response.capture.auth = init.headers["Authorization"];
    }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.payload,
    };
  };
}

// =====================================================================
// Sanitizer
// =====================================================================

test("sanitizeForSlack は xoxb / xapp / xoxp / sk- / EAA / Bearer / env を redact する", () => {
  const input = [
    "bot=xoxb-1234567890-abcdefghij",
    "app=xapp-1234567890-abcdefghij",
    "user=xoxp-1234567890-abcdefghij",
    "openai=sk-abcdefghij1234567890",
    "meta=EAAabcdefghijklmnopqrstuvwx",
    "header=Bearer eyJhbGc.aaa.bbb",
    "META_ACCESS_TOKEN=eyJhbGc.aaa.bbb",
    "OPENAI_API_KEY=sk-real-key-aaaaaa",
    "SLACK_BOT_TOKEN=xoxb-aaaaaaaaaa",
    "SLACK_SIGNING_SECRET=somesigning",
    'json={"access_token":"eyJh.bbbbb.cccc"}',
  ].join(" ");
  const out = sanitizeForSlack(input);
  assert.ok(!out.includes("xoxb-1234567890"));
  assert.ok(!out.includes("xapp-1234567890"));
  assert.ok(!out.includes("xoxp-1234567890"));
  assert.ok(!out.includes("sk-abcdefghij"));
  assert.ok(!out.includes("EAAabcdefghij"));
  assert.ok(!out.includes("Bearer eyJ"));
  assert.ok(out.includes("xoxb-[REDACTED]"));
  assert.ok(out.includes("xapp-[REDACTED]"));
  assert.ok(out.includes("xoxp-[REDACTED]"));
  assert.ok(out.includes("sk-[REDACTED]"));
  assert.ok(out.includes("EAA[REDACTED]"));
  assert.ok(out.includes("Bearer [REDACTED]"));
  assert.ok(out.includes("META_ACCESS_TOKEN=[REDACTED]"));
  assert.ok(out.includes("OPENAI_API_KEY=[REDACTED]"));
  assert.ok(out.includes("SLACK_BOT_TOKEN=[REDACTED]"));
  assert.ok(out.includes("SLACK_SIGNING_SECRET=[REDACTED]"));
  assert.ok(out.includes('"access_token":"[REDACTED]"'));
});

test("sanitizeForSlack は超長文字列を truncate する", () => {
  const big = "a".repeat(10000);
  const out = sanitizeForSlack(big);
  assert.ok(out.length < big.length);
  assert.ok(out.endsWith("…[truncated]"));
});

test("sanitizeForSlack は string 以外を空文字に正規化する", () => {
  // 型上は string だが、ランタイム侵入を想定して防御。
  assert.equal(sanitizeForSlack(undefined as unknown as string), "");
  assert.equal(sanitizeForSlack(null as unknown as string), "");
  assert.equal(sanitizeForSlack(123 as unknown as string), "");
});

// =====================================================================
// Builders — header / kind 一致
// =====================================================================

test("buildSlackNotificationMessage は 13 種別すべての header を返す", () => {
  const cases: SlackNotificationPayload[] = [
    {
      kind: "pr.opened",
      data: {
        prNumber: 42,
        prTitle: "test PR",
        prUrl: "https://github.com/example/ops/pull/42",
        repoFullName: "example/ops",
      },
    },
    {
      kind: "daily_report.completed",
      data: {
        reportId: "rpt_abc",
        adAccountKey: "demo-account",
        metricDate: "2026-05-01",
      },
    },
    {
      kind: "daily_report.failed",
      data: {
        adAccountKey: "demo-account",
        metricDate: "2026-05-01",
        errorMessage: "analyst agent failed",
      },
    },
    {
      kind: "budget_guard.alert",
      data: {
        adAccountKey: "demo-account",
        rule: "daily_spend_limit",
        evaluationTime: "2026-05-02T00:00:00.000Z",
      },
    },
    {
      kind: "budget_guard.auto_paused",
      data: {
        adAccountKey: "demo-account",
        rule: "daily_spend_limit",
        evaluationTime: "2026-05-02T00:00:00.000Z",
        pausedTargets: ["campaign:promo", "adset:cold-traffic"],
      },
    },
    {
      kind: "budget_guard.failed",
      data: {
        adAccountKey: "demo-account",
        errorMessage: "audit agent failed",
      },
    },
    {
      kind: "improvement_pr.opened",
      data: {
        prNumber: 99,
        prTitle: "improve creative copy",
        prUrl: "https://github.com/example/ops/pull/99",
        repoFullName: "example/ops",
        adAccountKey: "demo-account",
        riskLabel: "requires_approval",
      },
    },
    {
      kind: "improvement_pr.failed",
      data: {
        adAccountKey: "demo-account",
        failureStage: "ai",
        errorMessage: "media_buyer agent failed",
      },
    },
    {
      kind: "apply.completed",
      data: {
        applyJobId: "apply_xyz",
        adAccountKey: "demo-account",
      },
    },
    {
      kind: "apply.failed",
      data: {
        applyJobId: "apply_xyz",
        adAccountKey: "demo-account",
        errorMessage: "Meta API returned 400",
      },
    },
    {
      kind: "cron.failed",
      data: {
        cronName: "daily_report",
        errorMessage: "unexpected null reference",
      },
    },
    {
      kind: "rate_limit.warning",
      data: {
        state: "approaching",
        observedAt: "2026-05-02T00:00:00.000Z",
      },
    },
    {
      kind: "auth.revoked",
      data: {
        provider: "meta",
        observedAt: "2026-05-02T00:00:00.000Z",
      },
    },
  ];

  for (const payload of cases) {
    const msg = buildSlackNotificationMessage(payload);
    const headerText = findHeader(msg.blocks);
    assert.ok(headerText, `kind=${payload.kind} should have header`);
    assert.ok(headerText!.length > 0);
    assert.ok(msg.text.length > 0, `kind=${payload.kind} should have fallback text`);
    assert.ok(msg.blocks.length >= 2, `kind=${payload.kind} should have multiple blocks`);
  }
});

// =====================================================================
// Builders — sanitize 適用 (defense in depth)
// =====================================================================

test("buildSlackNotificationMessage は本文に侵入したトークンを redact する", () => {
  const msg = buildSlackNotificationMessage({
    kind: "pr.opened",
    data: {
      prNumber: 7,
      prTitle: "leak xoxb-1234567890-leakedtoken from title",
      prUrl: "https://github.com/example/ops/pull/7",
      repoFullName: "example/ops",
    },
  });
  for (const t of blockTexts(msg)) {
    assert.ok(!t.includes("xoxb-1234567890-leakedtoken"), `block must not contain leaked token: ${t}`);
  }
  assert.ok(!msg.text.includes("xoxb-1234567890-leakedtoken"));
});

test("buildSlackNotificationMessage は apply.failed の error message を redact する", () => {
  const msg = buildSlackNotificationMessage({
    kind: "apply.failed",
    data: {
      applyJobId: "apply_xyz",
      adAccountKey: "demo-account",
      errorMessage: "Bearer eyJsensitive.aa.bb expired",
    },
  });
  for (const t of blockTexts(msg)) {
    assert.ok(!t.includes("eyJsensitive"));
  }
});

test("buildSlackNotificationMessage は不正な PR URL をリンク化しない", () => {
  const msg = buildSlackNotificationMessage({
    kind: "pr.opened",
    data: {
      prNumber: 1,
      prTitle: "evil",
      prUrl: "javascript:alert(1)",
      repoFullName: "example/ops",
    },
  });
  for (const t of blockTexts(msg)) {
    assert.ok(!t.includes("javascript:"));
  }
  // actions ブロックに追加されないこと
  const actions = msg.blocks.find((b) => b.type === "actions");
  if (actions && actions.type === "actions") {
    for (const e of actions.elements) {
      assert.ok(!e.url || /^https?:\/\//i.test(e.url));
    }
  }
});

test("buildSlackNotificationMessage は dangerous categories を本文に含める", () => {
  const msg = buildSlackNotificationMessage({
    kind: "improvement_pr.opened",
    data: {
      prNumber: 100,
      prTitle: "raise budget",
      prUrl: "https://github.com/example/ops/pull/100",
      repoFullName: "example/ops",
      adAccountKey: "demo-account",
      riskLabel: "dangerous",
      dangerousCategories: ["budget_increase", "automation_rule_change"],
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("budget_increase"));
  assert.ok(all.includes("automation_rule_change"));
});

test("buildSlackNotificationMessage は budget_guard.auto_paused の対象を最大 10 件 + tail で表示する", () => {
  const targets = Array.from({ length: 14 }, (_, i) => `campaign:t${i}`);
  const msg = buildSlackNotificationMessage({
    kind: "budget_guard.auto_paused",
    data: {
      adAccountKey: "demo-account",
      rule: "daily_spend_limit",
      evaluationTime: "2026-05-02T00:00:00.000Z",
      pausedTargets: targets,
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("campaign:t0"));
  assert.ok(all.includes("campaign:t9"));
  assert.ok(!all.includes("campaign:t10"));
  assert.ok(all.includes("+4 more"));
});

test("buildSlackNotificationMessage は daily_report の top improvements を最大 5 件で並べる", () => {
  const msg = buildSlackNotificationMessage({
    kind: "daily_report.completed",
    data: {
      reportId: "rpt_abc",
      adAccountKey: "demo-account",
      metricDate: "2026-05-01",
      topImprovements: ["a", "b", "c", "d", "e", "f", "g"],
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("1. a"));
  assert.ok(all.includes("5. e"));
  assert.ok(!all.includes("6. f"));
});

test("buildSlackNotificationMessage は pr.opened に承認導線の context を含める", () => {
  const msg = buildSlackNotificationMessage({
    kind: "pr.opened",
    data: {
      prNumber: 1,
      prTitle: "x",
      prUrl: "https://github.com/example/ops/pull/1",
      repoFullName: "example/ops",
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("/approvals"));
  assert.ok(all.includes("Slack では PR の承認操作は提供されません"));
});

test("buildSlackNotificationMessage は apply.failed の context に GitOps 影響なしを明示する", () => {
  const msg = buildSlackNotificationMessage({
    kind: "apply.failed",
    data: {
      applyJobId: "apply_xyz",
      adAccountKey: "demo-account",
      errorMessage: "boom",
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("GitOps polling"));
  assert.ok(all.includes("通常通り稼働"));
});

// regression fix: 4 つの failure 種別がそれぞれ
//   1) error message 本文を含み (= 運用者がコンテキストを掴める)
//   2) "GitOps polling / Apply / Cron は通常通り稼働" を context に明示し
//   3) error message に紛れたトークンを redact する
// ことを確認する。

test("buildSlackNotificationMessage: daily_report.failed は error と GitOps 不影響と redact を満たす", () => {
  const msg = buildSlackNotificationMessage({
    kind: "daily_report.failed",
    data: {
      adAccountKey: "demo-account",
      metricDate: "2026-05-01",
      errorMessage: "analyst failed: Bearer eyJleak.aa.bb returned 500",
      mode: "proposal",
      aiRunId: "run_xyz",
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("analyst failed"));
  assert.ok(all.includes("通常通り稼働"));
  assert.ok(all.includes("demo-account"));
  for (const t of blockTexts(msg)) {
    assert.ok(!t.includes("eyJleak"));
  }
});

test("buildSlackNotificationMessage: budget_guard.failed は error と GitOps 不影響と redact を満たす", () => {
  const msg = buildSlackNotificationMessage({
    kind: "budget_guard.failed",
    data: {
      adAccountKey: "demo-account",
      errorMessage: "audit failed: META_ACCESS_TOKEN=eyJleak expired",
      mode: "auto_apply",
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("audit failed"));
  assert.ok(all.includes("通常通り稼働"));
  assert.ok(all.includes("demo-account"));
  for (const t of blockTexts(msg)) {
    assert.ok(!t.includes("eyJleak"));
  }
});

test("buildSlackNotificationMessage: improvement_pr.failed は failureStage と GitOps 不影響と redact を満たす", () => {
  const msgPr = buildSlackNotificationMessage({
    kind: "improvement_pr.failed",
    data: {
      adAccountKey: "demo-account",
      failureStage: "pr",
      errorMessage: "github push failed xoxb-1234567890-leakedtoken",
    },
  });
  const allPr = blockTexts(msgPr).join("\n");
  assert.ok(allPr.includes("pr_failed"));
  assert.ok(allPr.includes("通常通り稼働"));
  for (const t of blockTexts(msgPr)) {
    assert.ok(!t.includes("xoxb-1234567890-leakedtoken"));
  }

  const msgAi = buildSlackNotificationMessage({
    kind: "improvement_pr.failed",
    data: {
      adAccountKey: "demo-account",
      failureStage: "ai",
      errorMessage: "analyst failed",
    },
  });
  const allAi = blockTexts(msgAi).join("\n");
  assert.ok(allAi.includes("ai_failed"));
});

test("buildSlackNotificationMessage: cron.failed は cronName と GitOps 不影響と redact を満たす", () => {
  const msg = buildSlackNotificationMessage({
    kind: "cron.failed",
    data: {
      cronName: "daily_report",
      errorMessage: "TypeError: undefined is not a function sk-leakedopenaikey9999",
      cronRunId: "cr_xyz",
    },
  });
  const all = blockTexts(msg).join("\n");
  assert.ok(all.includes("daily_report"));
  assert.ok(all.includes("通常通り稼働"));
  assert.ok(all.includes("cr_xyz"));
  for (const t of blockTexts(msg)) {
    assert.ok(!t.includes("sk-leakedopenaikey9999"));
  }
});

// =====================================================================
// Dispatcher
// =====================================================================

test("dispatchSlackNotification は botToken 未指定で skipped_no_slack を返す", async () => {
  const result = await dispatchSlackNotification(
    {
      kind: "pr.opened",
      data: {
        prNumber: 1,
        prTitle: "x",
        prUrl: "https://github.com/example/ops/pull/1",
        repoFullName: "example/ops",
      },
    },
    {
      channelId: "C012ABC",
      fetchImpl: () => {
        throw new Error("must not fetch");
      },
    }
  );
  assert.equal(result.state, "skipped_no_slack");
  assert.equal(result.kind, "pr.opened");
});

test("dispatchSlackNotification は channelId 未指定で skipped_no_slack を返す", async () => {
  const result = await dispatchSlackNotification(
    {
      kind: "apply.completed",
      data: { applyJobId: "j1", adAccountKey: "demo" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      fetchImpl: () => {
        throw new Error("must not fetch");
      },
    }
  );
  assert.equal(result.state, "skipped_no_slack");
});

test("dispatchSlackNotification は botToken の prefix が xoxb- でないとき skipped_no_slack を返す", async () => {
  const result = await dispatchSlackNotification(
    {
      kind: "apply.completed",
      data: { applyJobId: "j1", adAccountKey: "demo" },
    },
    {
      botToken: "xoxp-not-a-bot-token",
      channelId: "C012ABC",
      fetchImpl: () => {
        throw new Error("must not fetch");
      },
    }
  );
  assert.equal(result.state, "skipped_no_slack");
});

test("dispatchSlackNotification は chat.postMessage を Bearer 付きで呼び sent を返す", async () => {
  const capture: { url?: string; body?: string; auth?: string } = {};
  const fetchImpl = fakePostMessageFetch({
    payload: { ok: true, channel: "C012ABC", ts: "1700000000.000100" },
    capture,
  });
  const result = await dispatchSlackNotification(
    {
      kind: "pr.opened",
      data: {
        prNumber: 1,
        prTitle: "x",
        prUrl: "https://github.com/example/ops/pull/1",
        repoFullName: "example/ops",
      },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
      now: () => new Date("2026-05-02T00:00:00.000Z"),
    }
  );
  assert.equal(result.state, "sent");
  assert.equal(result.ts, "1700000000.000100");
  assert.equal(result.channel, "C012ABC");
  assert.equal(result.preparedAt, "2026-05-02T00:00:00.000Z");
  assert.equal(result.sentAt, "2026-05-02T00:00:00.000Z");

  assert.ok(capture.url?.endsWith("/chat.postMessage"));
  assert.equal(capture.auth, "Bearer xoxb-1234567890-abc");
  const parsed = JSON.parse(capture.body!);
  assert.equal(parsed.channel, "C012ABC");
  assert.ok(typeof parsed.text === "string" && parsed.text.length > 0);
  assert.ok(Array.isArray(parsed.blocks) && parsed.blocks.length >= 2);
});

test("dispatchSlackNotification は Slack ok=false を failed として返し throw しない", async () => {
  const fetchImpl = fakePostMessageFetch({
    payload: { ok: false, error: "channel_not_found" },
  });
  const result = await dispatchSlackNotification(
    {
      kind: "auth.revoked",
      data: { provider: "meta", observedAt: "2026-05-02T00:00:00.000Z" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
    }
  );
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "channel_not_found");
  assert.ok(result.errorMessage?.includes("channel_not_found"));
});

test("dispatchSlackNotification は HTTP エラーを failed として返す", async () => {
  const fetchImpl: SlackFetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  });
  const result = await dispatchSlackNotification(
    {
      kind: "rate_limit.warning",
      data: { state: "throttled", observedAt: "2026-05-02T00:00:00.000Z" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
    }
  );
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "http_503");
});

test("dispatchSlackNotification は network error を failed として返し例外伝播しない", async () => {
  const fetchImpl: SlackFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await dispatchSlackNotification(
    {
      kind: "apply.failed",
      data: {
        applyJobId: "j1",
        adAccountKey: "demo",
        errorMessage: "boom",
      },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
    }
  );
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "network_error");
  assert.ok(result.errorMessage?.includes("ECONNREFUSED"));
});

test("dispatchSlackNotification は invalid JSON を failed として返す", async () => {
  const fetchImpl: SlackFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
  });
  const result = await dispatchSlackNotification(
    {
      kind: "apply.completed",
      data: { applyJobId: "j1", adAccountKey: "demo" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
    }
  );
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "invalid_json");
});

// =====================================================================
// Audit writer (implementation item)
//
// dispatchSlackNotification は dispatch 終了時に audit writer を 1 回呼び、
// slack_message_ts (= chat.postMessage 応答の `ts`) と channel / state /
// errorCode を含めて記録する。
// =====================================================================

class FakeAudit implements NotificationAuditWriter {
  calls: NotificationAuditInput[] = [];
  shouldThrow = false;
  async recordNotificationDispatch(input: NotificationAuditInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("audit boom xoxb-1234567890-leak");
    }
    this.calls.push(input);
  }
}

test("dispatchSlackNotification: sent のとき audit に slackMessageTs と channel を渡す", async () => {
  const fetchImpl = fakePostMessageFetch({
    payload: { ok: true, channel: "C012ABC", ts: "1700000000.000200" },
  });
  const audit = new FakeAudit();
  const result = await dispatchSlackNotification(
    {
      kind: "pr.opened",
      data: {
        prNumber: 1,
        prTitle: "x",
        prUrl: "https://github.com/example/ops/pull/1",
        repoFullName: "example/ops",
      },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
      audit,
      now: () => new Date("2026-05-02T00:00:00.000Z"),
    }
  );
  assert.equal(result.state, "sent");
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  assert.equal(call.kind, "pr.opened");
  assert.equal(call.state, "sent");
  assert.equal(call.slackMessageTs, "1700000000.000200");
  assert.equal(call.channelId, "C012ABC");
  assert.equal(call.preparedAt, "2026-05-02T00:00:00.000Z");
  assert.equal(call.sentAt, "2026-05-02T00:00:00.000Z");
  assert.equal(call.errorCode, undefined);
});

test("dispatchSlackNotification: skipped_no_slack のとき audit に slackMessageTs なしで記録", async () => {
  const audit = new FakeAudit();
  const result = await dispatchSlackNotification(
    {
      kind: "apply.completed",
      data: { applyJobId: "j1", adAccountKey: "demo" },
    },
    {
      // botToken 未指定 → skipped
      channelId: "C012ABC",
      audit,
      now: () => new Date("2026-05-02T00:00:00.000Z"),
    }
  );
  assert.equal(result.state, "skipped_no_slack");
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  assert.equal(call.state, "skipped_no_slack");
  assert.equal(call.slackMessageTs, undefined);
  // 入力で渡された channel は audit metadata に残す (誰宛にスキップされたかが分かるように)
  assert.equal(call.channelId, "C012ABC");
});

test("dispatchSlackNotification: failed (Slack ok=false) のとき audit に errorCode を渡す", async () => {
  const fetchImpl = fakePostMessageFetch({
    payload: { ok: false, error: "channel_not_found" },
  });
  const audit = new FakeAudit();
  const result = await dispatchSlackNotification(
    {
      kind: "auth.revoked",
      data: { provider: "meta", observedAt: "2026-05-02T00:00:00.000Z" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
      audit,
    }
  );
  assert.equal(result.state, "failed");
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  assert.equal(call.state, "failed");
  assert.equal(call.errorCode, "channel_not_found");
  assert.ok(call.errorMessage?.includes("channel_not_found"));
  assert.equal(call.slackMessageTs, undefined);
});

test("dispatchSlackNotification: audit writer が throw しても dispatch 結果は変わらない", async () => {
  const fetchImpl = fakePostMessageFetch({
    payload: { ok: true, channel: "C012ABC", ts: "1700000000.000300" },
  });
  const audit = new FakeAudit();
  audit.shouldThrow = true;
  const result = await dispatchSlackNotification(
    {
      kind: "apply.completed",
      data: { applyJobId: "j1", adAccountKey: "demo" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
      audit,
    }
  );
  assert.equal(result.state, "sent");
  assert.equal(result.ts, "1700000000.000300");
});

test("dispatchSlackNotification: audit option 未指定なら writer は呼ばれない", async () => {
  // audit を渡さなくても dispatch は通常通り完了する
  const fetchImpl = fakePostMessageFetch({
    payload: { ok: true, channel: "C012ABC", ts: "1700000000.000400" },
  });
  const result = await dispatchSlackNotification(
    {
      kind: "apply.completed",
      data: { applyJobId: "j1", adAccountKey: "demo" },
    },
    {
      botToken: "xoxb-1234567890-abc",
      channelId: "C012ABC",
      fetchImpl,
    }
  );
  assert.equal(result.state, "sent");
});

test("dispatchResultToError は failed のときだけ SlackApiError を返す", () => {
  const sent = dispatchResultToError({
    kind: "pr.opened",
    state: "sent",
    preparedAt: "2026-05-02T00:00:00.000Z",
    sentAt: "2026-05-02T00:00:00.000Z",
  });
  assert.equal(sent, null);

  const skipped = dispatchResultToError({
    kind: "pr.opened",
    state: "skipped_no_slack",
    preparedAt: "2026-05-02T00:00:00.000Z",
  });
  assert.equal(skipped, null);

  const failed = dispatchResultToError({
    kind: "pr.opened",
    state: "failed",
    errorCode: "channel_not_found",
    errorMessage: "Slack channel missing",
    preparedAt: "2026-05-02T00:00:00.000Z",
  });
  assert.ok(failed);
  assert.equal(failed!.slackError, "channel_not_found");
});

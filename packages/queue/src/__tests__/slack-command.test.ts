// AdDroid OSS — /adops slash command boundary unit tests (Implementation item).
//
// pg-boss / Prisma / Slack を一切起動せず、`slack-command.ts` のロジックだけを
// in-memory fake で検証する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  SLACK_COMMAND_JOB_NAME,
  SLACK_SLASH_COMMAND,
  SLACK_SLASH_SUBCOMMANDS,
  buildAckMessage,
  buildSlackCommandSingletonKey,
  enqueueSlackCommandJob,
  parseSlashCommand,
  postSlackResponse,
  runSlackCommandJob,
  sanitizeText,
  type ParsedSlashCommand,
  type RawSlackSlashCommandRequest,
  type SlackCommandAuditInput,
  type SlackCommandAuditWriter,
  type SlackCommandBoss,
  type SlackCommandJobPayload,
  type SlackCommandSendOptions,
  type SlackResponseFetch,
  type SlashCommandHandlers,
  type SlashHandlerInput,
  type SlashHandlerOutcome,
} from "../index.js";

// =====================================================================
// 0) Slack manifest と queue 側定数の対称性
//
// `@addroid/queue` は dependency manifest 制約のため `@addroid/config` を
// 直接 import できない。両側でドリフトが起きないように、Slack 側の契約
// (`/adops` + 6 subcommand) を literal で固定する: 片方を変えたら必ず
// 両側を変えなければビルドが落ちる構造になる。
// =====================================================================

test("queue 側 SLACK_SLASH_COMMAND は /adops 固定", () => {
  assert.equal(SLACK_SLASH_COMMAND, "/adops");
});

test("queue 側 SLACK_SLASH_SUBCOMMANDS は manifest と同集合 (6 件)", () => {
  assert.deepEqual(
    [...SLACK_SLASH_SUBCOMMANDS].sort(),
    ["accounts", "activate", "budget", "improve", "report", "status"]
  );
});

// =====================================================================
// 1) parseSlashCommand
// =====================================================================

function rawReq(
  partial: Partial<RawSlackSlashCommandRequest> = {}
): RawSlackSlashCommandRequest {
  return {
    command: "/adops",
    text: "",
    user_id: "U012ABC",
    user_name: "alice",
    channel_id: "C012ABC",
    team_id: "T012ABC",
    response_url: "https://hooks.slack.com/commands/T1/123/abc",
    trigger_id: "trig",
    ...partial,
  };
}

test("parseSlashCommand: report (引数なし) を受理する", () => {
  const r = parseSlashCommand(rawReq({ text: "report" }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.subcommand, "report");
    assert.equal(r.target, "");
    assert.deepEqual(r.rest, []);
  }
});

test("parseSlashCommand: 大文字 / 余計な空白も正規化", () => {
  const r = parseSlashCommand(rawReq({ text: "  STATUS  " }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.subcommand, "status");
});

test("parseSlashCommand: activate には対象が必須", () => {
  const r = parseSlashCommand(rawReq({ text: "activate" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "activate_missing_target");
    assert.match(r.message, /activate <ads_hierarchy_id>/);
  }
});

test("parseSlashCommand: activate <id> を target に詰める", () => {
  const r = parseSlashCommand(rawReq({ text: "activate hier-7" }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.subcommand, "activate");
    assert.equal(r.target, "hier-7");
  }
});

test("parseSlashCommand: 未対応 subcommand は unknown_subcommand", () => {
  const r = parseSlashCommand(rawReq({ text: "delete-everything" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "unknown_subcommand");
    assert.match(r.message, /未対応/);
  }
});

test("parseSlashCommand: text が空のときは empty_subcommand", () => {
  const r = parseSlashCommand(rawReq({ text: "" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "empty_subcommand");
});

test("parseSlashCommand: command が /adops 以外なら wrong_command", () => {
  const r = parseSlashCommand(rawReq({ command: "/adversary", text: "report" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "wrong_command");
});

// =====================================================================
// 2) buildAckMessage
// =====================================================================

test("buildAckMessage: 成功時は subcommand 別の説明文を含む", () => {
  for (const sub of SLACK_SLASH_SUBCOMMANDS) {
    const text = sub === "activate" ? `${sub} hier-1` : sub;
    const parsed = parseSlashCommand(rawReq({ text }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const ack = buildAckMessage(parsed);
    assert.equal(ack.response_type, "ephemeral");
    assert.match(ack.text, new RegExp(`/adops ${sub}`));
    assert.match(ack.text, /受け付けました/);
  }
});

test("buildAckMessage: 失敗時は usage / エラー文をそのまま返す", () => {
  const parsed = parseSlashCommand(rawReq({ text: "" }));
  const ack = buildAckMessage(parsed);
  assert.equal(ack.response_type, "ephemeral");
  assert.match(ack.text, /subcommand が指定されていません/);
});

test("buildAckMessage は I/O を伴わずに即時 return する (3 秒以内 ack 契約)", () => {
  // 純粋関数であることを観測する: 1000 回呼んでも 100ms 以内 (= 1 秒以内 ack 余裕)
  const parsed = parseSlashCommand(rawReq({ text: "report" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const start = Date.now();
  for (let i = 0; i < 1000; i++) buildAckMessage(parsed);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `buildAckMessage が遅すぎます: ${elapsed}ms`);
});

// =====================================================================
// 3) buildSlackCommandSingletonKey
// =====================================================================

test("singletonKey: report は subcommand+user で 1 並列", () => {
  const k1 = buildSlackCommandSingletonKey({
    subcommand: "report",
    slackUserId: "U1",
  });
  const k2 = buildSlackCommandSingletonKey({
    subcommand: "report",
    slackUserId: "U1",
  });
  assert.equal(k1, k2);
  assert.equal(k1, "slack_command:report:U1");
});

test("singletonKey: activate は target 単位で隔離", () => {
  const k1 = buildSlackCommandSingletonKey({
    subcommand: "activate",
    slackUserId: "U1",
    target: "hier-7",
  });
  const k2 = buildSlackCommandSingletonKey({
    subcommand: "activate",
    slackUserId: "U1",
    target: "hier-9",
  });
  assert.notEqual(k1, k2);
  assert.equal(k1, "slack_command:activate:U1:hier-7");
});

test("singletonKey: ASCII safe にサニタイズされる", () => {
  const k = buildSlackCommandSingletonKey({
    subcommand: "activate",
    slackUserId: "U user/danger",
    target: "id with space",
  });
  assert.match(k, /^slack_command:activate:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
});

// =====================================================================
// 4) enqueueSlackCommandJob
// =====================================================================

class FakeBoss implements SlackCommandBoss {
  sent: { name: string; data: unknown; options?: SlackCommandSendOptions }[] = [];
  defaultJobId: string | null = "pgboss-cmd-1";
  rejectDuplicateSingletons = false;
  async send(
    name: string,
    data: unknown,
    options?: SlackCommandSendOptions
  ): Promise<string | null> {
    if (
      this.rejectDuplicateSingletons &&
      options?.singletonKey &&
      this.sent.some((s) => s.options?.singletonKey === options.singletonKey)
    ) {
      this.sent.push({ name, data, ...(options ? { options } : {}) });
      return null;
    }
    this.sent.push({ name, data, ...(options ? { options } : {}) });
    return this.defaultJobId;
  }
}

test("enqueueSlackCommandJob: pg-boss に slack_command を送出し、payload を保存する", async () => {
  const boss = new FakeBoss();
  const parsed = parseSlashCommand(
    rawReq({ text: "report" })
  ) as ParsedSlashCommand;
  assert.equal(parsed.ok, true);
  const r = await enqueueSlackCommandJob({
    boss,
    parsed,
    request: rawReq({ text: "report" }),
    now: () => new Date("2026-05-02T00:00:00Z"),
  });
  assert.equal(r.jobId, "pgboss-cmd-1");
  assert.equal(boss.sent.length, 1);
  assert.equal(boss.sent[0]!.name, SLACK_COMMAND_JOB_NAME);
  assert.equal(r.singletonKey, "slack_command:report:U012ABC");
  assert.equal(boss.sent[0]!.options?.singletonKey, r.singletonKey);

  const p = boss.sent[0]!.data as SlackCommandJobPayload;
  assert.equal(p.subcommand, "report");
  assert.equal(p.target, "");
  assert.equal(p.slackUserId, "U012ABC");
  assert.equal(p.slackUserName, "alice");
  assert.equal(p.slackChannelId, "C012ABC");
  assert.equal(
    p.responseUrl,
    "https://hooks.slack.com/commands/T1/123/abc"
  );
  assert.equal(p.enqueuedAt, "2026-05-02T00:00:00.000Z");
});

test("enqueueSlackCommandJob: 同 user / 同 subcommand の二重連打を pg-boss singletonKey で抑止", async () => {
  const boss = new FakeBoss();
  boss.rejectDuplicateSingletons = true;
  const parsed = parseSlashCommand(
    rawReq({ text: "report" })
  ) as ParsedSlashCommand;
  const first = await enqueueSlackCommandJob({
    boss,
    parsed,
    request: rawReq({ text: "report" }),
  });
  const second = await enqueueSlackCommandJob({
    boss,
    parsed,
    request: rawReq({ text: "report" }),
  });
  assert.notEqual(first.jobId, null);
  assert.equal(second.jobId, null, "二重 enqueue は singletonKey で reject される");
});

// =====================================================================
// 5) postSlackResponse
// =====================================================================

function fakeFetch(opts: {
  ok?: boolean;
  status?: number;
  capture?: { url?: string; body?: string };
  throwError?: Error;
}): SlackResponseFetch {
  return async (url, init) => {
    if (opts.throwError) throw opts.throwError;
    if (opts.capture) {
      opts.capture.url = url;
      opts.capture.body = init.body;
    }
    return { ok: opts.ok ?? true, status: opts.status ?? 200 };
  };
}

test("postSlackResponse: https の response_url に POST し、JSON を渡す", async () => {
  const cap: { url?: string; body?: string } = {};
  const r = await postSlackResponse({
    responseUrl: "https://hooks.slack.com/commands/T1/2/abc",
    message: { response_type: "ephemeral", text: "done" },
    fetchImpl: fakeFetch({ ok: true, capture: cap }),
  });
  assert.equal(r.ok, true);
  assert.equal(cap.url, "https://hooks.slack.com/commands/T1/2/abc");
  const parsed = JSON.parse(cap.body!);
  assert.equal(parsed.text, "done");
  assert.equal(parsed.response_type, "ephemeral");
});

test("postSlackResponse: 非 https の URL は invalid_response_url で拒否", async () => {
  const r = await postSlackResponse({
    responseUrl: "http://attacker.example/x",
    message: { response_type: "ephemeral", text: "x" },
    fetchImpl: fakeFetch({}),
  });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "invalid_response_url");
});

test("postSlackResponse: HTTP 5xx 応答は failed で返り、throw しない", async () => {
  const r = await postSlackResponse({
    responseUrl: "https://hooks.slack.com/x",
    message: { response_type: "ephemeral", text: "x" },
    fetchImpl: fakeFetch({ ok: false, status: 503 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "http_503");
});

test("postSlackResponse: network error も throw せず failed で返す", async () => {
  const r = await postSlackResponse({
    responseUrl: "https://hooks.slack.com/x",
    message: { response_type: "ephemeral", text: "x" },
    fetchImpl: fakeFetch({ throwError: new Error("ECONNRESET") }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "network_error");
});

test("postSlackResponse: text と blocks をサニタイズしてから POST する", async () => {
  const cap: { url?: string; body?: string } = {};
  await postSlackResponse({
    responseUrl: "https://hooks.slack.com/x",
    message: {
      response_type: "ephemeral",
      text: "leak xoxb-1234567890-secret here",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: 'env META_ACCESS_TOKEN=ABCDEF and "api_key":"sk-abcdefghij1234567890"',
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open" },
              url: "https://example.com/x",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "bad" },
              url: "javascript:alert(1)",
            },
          ],
        },
      ],
    },
    fetchImpl: fakeFetch({ ok: true, capture: cap }),
  });
  const body = cap.body!;
  // body は JSON.stringify されているため inner double-quote は \" にエスケープされる。
  assert.match(body, /xoxb-\[REDACTED\]/);
  assert.match(body, /META_ACCESS_TOKEN=\[REDACTED\]/);
  // JSON-pair 用の redactor が "api_key" のリテラル値を [REDACTED] に置換する。
  // (sk- 自体の置換より JSON-pair の方が文脈的に強い置換であり、優先される。)
  assert.match(body, /\\"api_key\\":\\"\[REDACTED\]\\"/);
  // javascript: の button URL は除去される
  assert.doesNotMatch(body, /javascript:/);
  // 元のシークレット値が body のどこにも残っていない
  assert.doesNotMatch(body, /xoxb-1234567890/);
  assert.doesNotMatch(body, /sk-abcdefghij1234567890/);
  assert.doesNotMatch(body, /META_ACCESS_TOKEN=ABCDEF/);
});

// =====================================================================
// 6) sanitizeText (ユニット)
// =====================================================================

test("sanitizeText: xoxb / xapp / sk- / Bearer / META_*_TOKEN を redact", () => {
  const input =
    "xoxb-1234567890-abcdef xapp-1234567890-abcdef sk-abcdefghij12 EAAabcdefghijklmnopqrstuvwxyz Bearer abc.def.ghi META_PIXEL_TOKEN=xyz";
  const out = sanitizeText(input);
  for (const fragment of [
    "xoxb-[REDACTED]",
    "xapp-[REDACTED]",
    "sk-[REDACTED]",
    "EAA[REDACTED]",
    "Bearer [REDACTED]",
    "META_PIXEL_TOKEN=[REDACTED]",
  ])
    assert.match(out, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// =====================================================================
// 7) runSlackCommandJob (orchestrator)
// =====================================================================

function makeHandlers(
  overrides: Partial<SlashCommandHandlers> = {}
): { handlers: SlashCommandHandlers; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const def = (
    name: keyof SlashCommandHandlers,
    out: SlashHandlerOutcome
  ): SlashCommandHandlers[typeof name] =>
    (async (_input: SlashHandlerInput) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return out;
    });
  const handlers: SlashCommandHandlers = {
    report: def("report", { state: "succeeded", text: "report ok" }),
    budget: def("budget", { state: "succeeded", text: "budget ok" }),
    improve: def("improve", { state: "succeeded", text: "improve ok" }),
    status: def("status", { state: "succeeded", text: "status ok" }),
    accounts: def("accounts", { state: "succeeded", text: "accounts ok" }),
    activate: def("activate", { state: "succeeded", text: "activate ok" }),
    ...overrides,
  };
  return { handlers, calls };
}

function makePayload(
  overrides: Partial<SlackCommandJobPayload> = {}
): SlackCommandJobPayload {
  return {
    subcommand: "report",
    target: "",
    rest: [],
    rawText: "report",
    slackUserId: "U1",
    slackUserName: "alice",
    slackChannelId: "C1",
    slackTeamId: "T1",
    responseUrl: "https://hooks.slack.com/commands/T1/2/abc",
    enqueuedAt: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

test("runSlackCommandJob: 該当 handler を 1 回だけ呼び response_url に POST する", async () => {
  const { handlers, calls } = makeHandlers();
  const cap: { url?: string; body?: string } = {};
  const r = await runSlackCommandJob({
    payload: makePayload({ subcommand: "budget" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true, capture: cap }),
  });
  assert.equal(calls.budget, 1);
  assert.equal(calls.report ?? 0, 0);
  assert.equal(r.state, "succeeded");
  assert.equal(r.postedToResponseUrl, true);
  assert.match(JSON.parse(cap.body!).text, /\/adops budget/);
  assert.match(JSON.parse(cap.body!).text, /完了しました/);
});

test("runSlackCommandJob: handler が throw しても failed で response_url に通知する", async () => {
  const { handlers } = makeHandlers({
    report: async () => {
      throw new Error("boom xoxb-1234567890-secret");
    },
  });
  const cap: { url?: string; body?: string } = {};
  const r = await runSlackCommandJob({
    payload: makePayload({ subcommand: "report" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true, capture: cap }),
  });
  assert.equal(r.state, "failed");
  assert.match(r.handlerError ?? "", /boom xoxb-\[REDACTED\]/);
  assert.match(JSON.parse(cap.body!).text, /失敗しました/);
  // sanitize: token が漏れていない
  assert.doesNotMatch(cap.body!, /xoxb-1234567890/);
});

test("runSlackCommandJob: handler が state=failed を返した場合 errorCode が文脈付きで Slack に出る", async () => {
  const { handlers } = makeHandlers({
    activate: async () => ({
      state: "failed",
      text: "Activate rejected: not_paused",
      errorCode: "not_paused",
    }),
  });
  const cap: { url?: string; body?: string } = {};
  const r = await runSlackCommandJob({
    payload: makePayload({ subcommand: "activate", target: "hier-7" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true, capture: cap }),
  });
  assert.equal(r.state, "failed");
  const body = JSON.parse(cap.body!);
  assert.match(body.text, /\/adops activate hier-7/);
  // errorCode は context block にも出る
  const blocks = body.blocks as { type: string }[];
  assert.ok(
    blocks.some(
      (b) =>
        b.type === "context" &&
        JSON.stringify(b).includes("error_code: not_paused")
    )
  );
});

test("runSlackCommandJob: detailUrl があれば actions block にボタンが出る", async () => {
  const { handlers } = makeHandlers({
    status: async () => ({
      state: "succeeded",
      text: "status ok",
      detailUrl: "https://localhost/dashboard",
    }),
  });
  const cap: { url?: string; body?: string } = {};
  await runSlackCommandJob({
    payload: makePayload({ subcommand: "status" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true, capture: cap }),
  });
  const body = JSON.parse(cap.body!);
  const actions = (body.blocks as { type: string }[]).find(
    (b) => b.type === "actions"
  );
  assert.ok(actions, "actions block が含まれていない");
  assert.match(cap.body!, /https:\/\/localhost\/dashboard/);
});

test("runSlackCommandJob: response_url POST 失敗でも throw せず result を返す", async () => {
  const { handlers } = makeHandlers();
  const r = await runSlackCommandJob({
    payload: makePayload({ subcommand: "accounts" }),
    handlers,
    fetchImpl: fakeFetch({ ok: false, status: 500 }),
  });
  // ハンドラ自体は成功している
  assert.equal(r.handlerOutcome?.state, "succeeded");
  assert.equal(r.postedToResponseUrl, false);
  assert.equal(r.postError, "Slack response_url が HTTP 500 を返しました");
});

test("runSlackCommandJob: 全 subcommand で対応 handler が呼ばれる", async () => {
  for (const sub of SLACK_SLASH_SUBCOMMANDS) {
    const { handlers, calls } = makeHandlers();
    await runSlackCommandJob({
      payload: makePayload({
        subcommand: sub,
        target: sub === "activate" ? "hier-1" : "",
      }),
      handlers,
      fetchImpl: fakeFetch({ ok: true }),
    });
    assert.equal(calls[sub], 1, `${sub} handler not invoked`);
  }
});

// =====================================================================
// 8) audit writer (implementation item)
//
// 1 回の slash command 実行で audit_logs に 1 行残す境界。actor は
// `slack:<user_id>`、metadata に slack_user_id / response_url 利用結果 /
// durationMs を含める。
// =====================================================================

class FakeAuditWriter implements SlackCommandAuditWriter {
  calls: SlackCommandAuditInput[] = [];
  shouldThrow = false;
  async recordSlashCommandExecution(input: SlackCommandAuditInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("audit boom xoxb-1234567890-shouldnotleak");
    }
    this.calls.push(input);
  }
}

test("runSlackCommandJob: 成功時 audit writer を 1 回呼び actor=slack:<user_id> を渡す", async () => {
  const { handlers } = makeHandlers();
  const audit = new FakeAuditWriter();
  await runSlackCommandJob({
    payload: makePayload({
      subcommand: "report",
      slackUserId: "U012ABC",
      slackChannelId: "C012ABC",
    }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
    audit,
    now: () => new Date("2026-05-02T00:00:00.000Z"),
  });
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  assert.equal(call.actor, "slack:U012ABC");
  assert.equal(call.action, "slash_command.completed");
  assert.equal(call.target, "slack_command:report");
  assert.equal(call.ref, "report");
  assert.equal(call.subcommand, "report");
  assert.equal(call.subcommandTarget, "");
  assert.equal(call.slackUserId, "U012ABC");
  assert.equal(call.slackChannelId, "C012ABC");
  assert.equal(call.state, "succeeded");
  assert.equal(call.handlerState, "succeeded");
  assert.equal(call.postedToResponseUrl, true);
  assert.equal(call.postError, undefined);
  assert.equal(call.handlerError, undefined);
  assert.ok(typeof call.durationMs === "number");
  assert.equal(call.finishedAt, "2026-05-02T00:00:00.000Z");
});

test("runSlackCommandJob: activate の成功は activate.via_slack で記録される", async () => {
  const { handlers } = makeHandlers();
  const audit = new FakeAuditWriter();
  await runSlackCommandJob({
    payload: makePayload({
      subcommand: "activate",
      target: "hier-7",
      slackUserId: "U777",
    }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
    audit,
  });
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  assert.equal(call.action, "activate.via_slack");
  assert.equal(call.target, "slack_command:activate");
  assert.equal(call.ref, "activate hier-7");
  assert.equal(call.subcommandTarget, "hier-7");
  assert.equal(call.actor, "slack:U777");
});

test("runSlackCommandJob: handler 失敗時は slash_command.failed + sanitize 済み handlerError を残す", async () => {
  const { handlers } = makeHandlers({
    report: async () => {
      throw new Error("boom xoxb-1234567890-leak");
    },
  });
  const audit = new FakeAuditWriter();
  await runSlackCommandJob({
    payload: makePayload({ subcommand: "report" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
    audit,
  });
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  assert.equal(call.action, "slash_command.failed");
  assert.equal(call.state, "failed");
  assert.equal(call.handlerState, null);
  assert.match(call.handlerError ?? "", /xoxb-\[REDACTED\]/);
  assert.doesNotMatch(call.handlerError ?? "", /1234567890-leak/);
});

test("runSlackCommandJob: response_url POST 失敗は postedToResponseUrl=false + postError を残す", async () => {
  const { handlers } = makeHandlers();
  const audit = new FakeAuditWriter();
  await runSlackCommandJob({
    payload: makePayload({ subcommand: "status" }),
    handlers,
    fetchImpl: fakeFetch({ ok: false, status: 500 }),
    audit,
  });
  assert.equal(audit.calls.length, 1);
  const call = audit.calls[0]!;
  // handler は succeeded、しかし response_url POST が失敗した状態を audit に残す
  assert.equal(call.handlerState, "succeeded");
  assert.equal(call.postedToResponseUrl, false);
  assert.match(call.postError ?? "", /HTTP 500/);
});

test("runSlackCommandJob: handler が state=failed + errorCode を返したケース", async () => {
  const { handlers } = makeHandlers({
    activate: async () => ({
      state: "failed",
      text: "not paused",
      errorCode: "not_paused",
    }),
  });
  const audit = new FakeAuditWriter();
  await runSlackCommandJob({
    payload: makePayload({ subcommand: "activate", target: "hier-1" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
    audit,
  });
  const call = audit.calls[0]!;
  assert.equal(call.action, "slash_command.failed");
  assert.equal(call.state, "failed");
  assert.equal(call.handlerState, "failed");
  assert.equal(call.errorCode, "not_paused");
});

test("runSlackCommandJob: audit writer が throw しても result は通常通り返り job は失敗扱いにならない", async () => {
  const { handlers } = makeHandlers();
  const audit = new FakeAuditWriter();
  audit.shouldThrow = true;
  const r = await runSlackCommandJob({
    payload: makePayload({ subcommand: "accounts" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
    audit,
  });
  assert.equal(r.state, "succeeded");
  assert.equal(r.postedToResponseUrl, true);
});

test("runSlackCommandJob: slackUserId が空のとき actor=slack:_ にフォールバック", async () => {
  const { handlers } = makeHandlers();
  const audit = new FakeAuditWriter();
  await runSlackCommandJob({
    payload: makePayload({ subcommand: "status", slackUserId: "" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
    audit,
  });
  assert.equal(audit.calls[0]!.actor, "slack:_");
});

test("runSlackCommandJob: audit option 未指定なら audit を呼ばない", async () => {
  const { handlers } = makeHandlers();
  // audit を渡さなくても result は通常通り返る (テスト経路で副作用ゼロ)
  const r = await runSlackCommandJob({
    payload: makePayload({ subcommand: "report" }),
    handlers,
    fetchImpl: fakeFetch({ ok: true }),
  });
  assert.equal(r.state, "succeeded");
});

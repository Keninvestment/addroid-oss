// AdDroid OSS — CliActivateExecutor / MockActivateExecutor / resolveActivateExecutor
// テスト.
//
// 子プロセスを起動せず、`MetaCliRunner.spawnImpl` を fake に差し替えて end-to-end で
// 検証する。the current implementation 受入要件のうち以下を直接的にカバーする:
//   - "Meta Ads CLI adapter executes through a single sanitized runner interface and
//      never places access tokens in command-line arguments or logs."
//   - "CLI exit codes are classified into success, auth error, API/rate-limit error,
//      and unknown failure with matching retry or notification behavior."
//   - "Activate is separate from Apply ... before changing PAUSED to ACTIVE."

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import type {
  MetaAccessTokenLease,
  MetaAdAccount,
  MetaAdapter,
  MetaBeginOAuthResult,
  MetaBusiness,
  MetaOAuthConnection,
  MetaRefreshResult,
} from "@addroid/meta-adapter";
import { MetaCliRunner, MetaTokenExpiredError } from "@addroid/meta-adapter";
import type { ActivateNodeSnapshot } from "@addroid/queue";

import {
  CliActivateExecutor,
  MockActivateExecutor,
  resolveActivateExecutor,
} from "../activate-meta-executor.js";

// ---------------------------------------------------------------------
// fake spawn (apply-meta-executor.test.ts と同じパターン)
// ---------------------------------------------------------------------

interface SpawnLog {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

interface ScriptedRun {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  delayMs?: number;
}

class FakeChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  killed = false;
  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function makeSpawn(scripts: ScriptedRun[], log: SpawnLog[]) {
  return ((cmd: string, args?: readonly string[], opts?: Record<string, unknown>) => {
    log.push({
      command: cmd,
      args: args ? Array.from(args) : [],
      options: (opts ?? {}) as Record<string, unknown>,
    });
    const child = new FakeChildProcess();
    const script = scripts.shift();
    if (!script) throw new Error("fake spawn: no scripted run remaining");
    const delay = script.delayMs ?? 1;
    setTimeout(() => {
      if (script.stdout) child.stdout.push(Buffer.from(script.stdout, "utf8"));
      if (script.stderr) child.stderr.push(Buffer.from(script.stderr, "utf8"));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", script.exitCode, script.signal ?? null);
    }, delay);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

// ---------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------

const TOKEN = "EAA-activate-token-1234567890ABCDEFGH";

function pausedCampaign(): ActivateNodeSnapshot {
  return {
    hierarchyId: "node-1",
    workspaceId: "ws-1",
    accountId: "acct-1",
    accountKey: "primary",
    metaAccountId: "act_111111",
    nodeType: "campaign",
    nodeKey: "fall",
    displayName: "Fall",
    status: "paused",
    externalId: "cmp_777",
  };
}

function makeRunner(scripts: ScriptedRun[], log: SpawnLog[]): MetaCliRunner {
  return new MetaCliRunner({
    binaryPath: "/usr/local/bin/meta-ads-cli",
    spawnImpl: makeSpawn(scripts, log),
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    baseEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
  });
}

// ---------------------------------------------------------------------
// CliActivateExecutor — success path
// ---------------------------------------------------------------------

test("CliActivateExecutor: success で argv に token が乗らず、env のみで token を渡す", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: "ok\n", stderr: "", exitCode: 0 }],
    log
  );
  const executor = new CliActivateExecutor({ runner });
  const result = await executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });

  assert.equal(result.status, "success");
  assert.equal(result.externalId, "cmp_777");

  // sanitized command starts with official `<binary> ads campaign activate`
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.exitClass, "success");
  assert.ok(
    (payload.sanitizedCommand as string).startsWith(
      "/usr/local/bin/meta-ads-cli ads campaign activate"
    )
  );
  const sanitizedArgs = payload.sanitizedArgs as string[];
  assert.deepEqual(sanitizedArgs, [
    "ads",
    "campaign",
    "activate",
    "--id",
    "cmp_777",
  ]);

  // token/account id は argv に乗らず env のみで渡る
  assert.equal(log.length, 1);
  const spawned = log[0]!;
  assert.ok(!spawned.args.some((a) => a.includes(TOKEN)));
  const env = (spawned.options as { env?: Record<string, string> }).env ?? {};
  assert.equal(env.ACCESS_TOKEN, TOKEN);
  assert.equal(env.AD_ACCOUNT_ID, "act_111111");
  assert.equal(env.META_ACCESS_TOKEN, undefined);
  assert.equal(env.META_PRIMARY_ACCESS_TOKEN, undefined);
  assert.equal(env.META_PRIMARY_AD_ACCOUNT_ID, undefined);
});

// ---------------------------------------------------------------------
// CliActivateExecutor — auth_error notify hint
// ---------------------------------------------------------------------

test("CliActivateExecutor: auth_error は status と notify (oauth.meta.reauth_required) を返す", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr: '{"error":{"message":"Error validating access token","code":190}}',
        exitCode: 2,
      },
    ],
    log
  );
  const executor = new CliActivateExecutor({ runner });
  const result = await executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });

  assert.equal(result.status, "auth_error");
  assert.equal(result.retry, undefined);
  assert.ok(result.notify);
  assert.equal(result.notify!.auditAction, "oauth.meta.reauth_required");
});

// ---------------------------------------------------------------------
// CliActivateExecutor — rate_limit retry hint (exponential backoff)
// ---------------------------------------------------------------------

test("CliActivateExecutor: rate_limit_error は exponential backoff retry hint を付ける", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr: '{"error":{"message":"User request limit reached","code":17}}',
        exitCode: 3,
      },
    ],
    log
  );
  const executor = new CliActivateExecutor({ runner });
  const result = await executor.executeActivate({
    node: pausedCampaign(),
    attempt: 1,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });

  assert.equal(result.status, "rate_limit_error");
  assert.ok(result.retry);
  assert.equal(result.retry!.maxAttempts, 3);
  // attempt=1 → 5_000 * 2^1 = 10_000 (apply 経路と同じ exponent)
  assert.equal(result.retry!.delayMs, 10_000);
});

// ---------------------------------------------------------------------
// CliActivateExecutor — token never leaks even if CLI echoes it
// ---------------------------------------------------------------------

test("CliActivateExecutor: CLI が token を echo しても logPayload には [REDACTED] 化済みで残る", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: `activated with token ${TOKEN}\n`,
        stderr: "",
        exitCode: 0,
      },
    ],
    log
  );
  const executor = new CliActivateExecutor({ runner });
  const result = await executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });
  const payload = result.logPayload as Record<string, unknown>;
  const stdout = payload.stdout as string;
  assert.ok(!stdout.includes(TOKEN));
  assert.ok(stdout.includes("[REDACTED]"));
});

// ---------------------------------------------------------------------
// CliActivateExecutor — no external_id → skipped (CLI 起動しない)
// ---------------------------------------------------------------------

test("CliActivateExecutor: external_id が null のノードは spawn せず skipped を返す", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([], log); // scripts なし — 呼ばれたら fail する
  const executor = new CliActivateExecutor({ runner });
  const node: ActivateNodeSnapshot = { ...pausedCampaign(), externalId: null };
  const result = await executor.executeActivate({
    node,
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });
  assert.equal(result.status, "skipped");
  assert.equal(log.length, 0);
});

// ---------------------------------------------------------------------
// MockActivateExecutor — fail-closed when CLI bin not configured
// (regression fix: Activate must never mock-succeed because PAUSED→ACTIVE
//  has real-money side effects)
// ---------------------------------------------------------------------

test("MockActivateExecutor: CLI 未設定時は unknown_error + meta.cli_unknown_error notify を返し、appliedRemotely を立てない", async () => {
  const executor = new MockActivateExecutor();
  const result = await executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });

  assert.equal(result.status, "unknown_error");
  assert.equal(result.appliedRemotely, undefined);
  assert.ok(result.notify);
  assert.equal(result.notify!.auditAction, "meta.cli_unknown_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.mode, "mock");
  assert.equal(payload.stage, "resolve_executor");
  assert.equal(payload.reason, "cli_not_configured");
  assert.ok(
    (payload.sanitizedCommand as string).startsWith("meta-ads-cli ads campaign activate")
  );
});

// regression fix: MockActivateExecutor の fail-closed payload も spawned 経路
// (toExecutionLogInput) と同じ canonical command-evidence shape を含めること。
// stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/throttleHeaders/
// exitClass/recommendedAction を null/empty/zero 値で正規化することで、
// execution_logs を横断するコンシューマ (UI / log analytics) が mock fail-closed
// パスを特別扱いしなくて済む。
test("MockActivateExecutor: fail-closed payload includes canonical CLI evidence shape", async () => {
  const executor = new MockActivateExecutor();
  const result = await executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });
  assert.equal(result.status, "unknown_error");
  const payload = result.logPayload as Record<string, unknown>;

  // canonical evidence fields
  assert.equal(payload.exitClass, "unknown_error");
  assert.equal(payload.exitCode, null, "fail-closed exitCode must be null");
  assert.equal(payload.signal, null);
  assert.equal(payload.stdout, "", "fail-closed stdout must be empty");
  assert.equal(typeof payload.stderr, "string");
  assert.ok(
    (payload.stderr as string).includes(
      "ADDROID_META_CLI_BIN is not configured"
    ),
    "fail-closed stderr should mention CLI 未設定"
  );
  assert.equal(payload.timedOut, false);
  assert.equal(payload.durationMs, 0);
  assert.equal(typeof payload.startedAt, "string");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(payload.throttleHeaders, null);
  assert.ok(
    payload.recommendedAction && typeof payload.recommendedAction === "object",
    "recommendedAction must be present for unknown_error class"
  );
  assert.equal(payload.accountKey, "primary");
  assert.equal(payload.binary, null);

  // 既存の identity フィールドも引き続き保持される (回帰防止)。
  assert.equal(payload.mode, "mock");
  assert.equal(payload.stage, "resolve_executor");
  assert.equal(payload.reason, "cli_not_configured");
  assert.equal(payload.resource, "campaigns");
});

test("MockActivateExecutor: external_id 欠落は skipped", async () => {
  const executor = new MockActivateExecutor();
  const result = await executor.executeActivate({
    node: { ...pausedCampaign(), externalId: null },
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });
  assert.equal(result.status, "skipped");
});

// ---------------------------------------------------------------------
// resolveActivateExecutor — env / Meta OAuth 状態による分岐
// ---------------------------------------------------------------------

class FakeMetaAdapter implements MetaAdapter {
  constructor(private readonly lease: MetaAccessTokenLease | null) {}
  async beginOAuth(): Promise<MetaBeginOAuthResult> {
    throw new Error("not used");
  }
  async completeOAuth(): Promise<MetaOAuthConnection> {
    throw new Error("not used");
  }
  async refreshLongLivedToken(): Promise<MetaRefreshResult> {
    throw new Error("not used");
  }
  async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
    return this.lease;
  }
  async fetchBusinesses(): Promise<MetaBusiness[]> {
    return [];
  }
  async fetchAdAccounts(): Promise<MetaAdAccount[]> {
    return [];
  }
}

test("resolveActivateExecutor: ADDROID_META_CLI_BIN 未設定 → fail-closed MockActivateExecutor", async () => {
  const sel = await resolveActivateExecutor({
    env: {} as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
  });
  assert.equal(sel.mode, "mock");
  assert.ok(sel.executor instanceof MockActivateExecutor);
  assert.match(sel.reason, /ADDROID_META_CLI_BIN is not set/);
  assert.match(sel.reason, /fail closed/i);

  // regression fix: mock 経路は success を返さず、必ず fail-closed
  // unknown_error + meta.cli_unknown_error notify を返すこと。
  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });
  assert.equal(result.status, "unknown_error");
  assert.equal(result.appliedRemotely, undefined);
  assert.equal(result.notify?.auditAction, "meta.cli_unknown_error");
});

// regression fix: token 未連携でも CLI bin が設定済みなら CliActivateExecutor を
// 返し、executeActivate が auth_error + oauth.meta.reauth_required notify を
// 返す (mock fallback で success を返してはならない)。
test("resolveActivateExecutor: CLI bin 設定済みで token 未連携 → CliActivateExecutor が auth_error/reauth を返す", async () => {
  const spawnLog: SpawnLog[] = [];
  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter(null),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "cli");
  assert.ok(sel.executor instanceof CliActivateExecutor);

  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });
  assert.equal(result.status, "auth_error");
  assert.equal(result.appliedRemotely, undefined);
  assert.ok(result.notify);
  assert.equal(result.notify!.auditAction, "oauth.meta.reauth_required");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.stage, "load_token");
  assert.equal(payload.errorName, "MetaCliMissingTokenError");
  // Meta API には一切 spawn しない (token が無いまま実 CLI を起動しないこと)。
  assert.equal(spawnLog.length, 0);
});

// regression fix: adapter が token を保持しつつも期限切れ等で例外を投げる場合も
// auth_error + reauth notify として返す (Mock fallback ではない)。
test("resolveActivateExecutor: token loader が MetaTokenExpiredError を投げる → auth_error/reauth_required", async () => {
  const spawnLog: SpawnLog[] = [];
  class ExpiringAdapter extends FakeMetaAdapter {
    constructor() {
      super(null);
    }
    override async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
      throw new MetaTokenExpiredError(new Date(Date.now() - 60_000));
    }
  }

  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new ExpiringAdapter(),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "cli");

  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });
  assert.equal(result.status, "auth_error");
  assert.equal(result.appliedRemotely, undefined);
  assert.equal(result.notify?.auditAction, "oauth.meta.reauth_required");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.errorName, "MetaTokenExpiredError");
  assert.equal(spawnLog.length, 0);
});

test("resolveActivateExecutor: CLI bin + Meta token 揃えば CliActivateExecutor", async () => {
  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "cli");
  assert.ok(sel.executor instanceof CliActivateExecutor);
  assert.equal(sel.versionVerification?.ok, true);
});

// regression fix: CLI binary/version 未検証時は Activate も fail-closed で
// unknown_error を返し、Meta API には一切リクエストを送らない。

test("resolveActivateExecutor: verifyVersion fails → executeActivate returns unknown_error with cli_unknown_error notify and never spawns", async () => {
  const spawnLog: SpawnLog[] = [];
  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => {
      throw new Error("ENOENT: meta-ads-cli not installed");
    },
  });
  assert.equal(sel.mode, "cli");
  assert.equal(sel.versionVerification?.ok, false);
  assert.match(sel.reason, /failed version verification/);

  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });
  assert.equal(result.status, "unknown_error");
  assert.equal(result.retry, undefined);
  assert.ok(result.notify);
  assert.equal(result.notify!.auditAction, "meta.cli_unknown_error");

  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.stage, "verify_version");
  assert.equal(payload.errorName, "MetaCliVersionUnverifiedError");

  // Activate も spawn を呼ばずに fail-closed
  assert.equal(spawnLog.length, 0);
});

// regression fix: CliActivateExecutor の pre-spawn 失敗 (version_unverified /
// load_token) も spawned 経路 (toExecutionLogInput) と同じ canonical
// command-evidence shape (stdout/stderr/exitCode/signal/timestamps/durationMs/
// timedOut/throttleHeaders/exitClass/recommendedAction) を logPayload に含める。
// null/empty/zero 値で正規化することで、execution_logs を横断するコンシューマが
// pre-spawn 失敗パスを特別扱いせずに済む。
test("CliActivateExecutor: version_unverified pre-spawn failure payload includes canonical CLI evidence shape", async () => {
  const spawnLog: SpawnLog[] = [];
  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => {
      throw new Error("ENOENT: meta-ads-cli not installed");
    },
  });
  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });
  assert.equal(result.status, "unknown_error");
  const payload = result.logPayload as Record<string, unknown>;

  // canonical evidence fields
  assert.equal(payload.exitClass, "unknown_error");
  assert.equal(payload.exitCode, null, "pre-spawn exitCode must be null");
  assert.equal(payload.signal, null);
  assert.equal(payload.stdout, "", "pre-spawn stdout must be empty");
  assert.equal(typeof payload.stderr, "string");
  assert.ok(
    (payload.stderr as string).length > 0,
    "pre-spawn stderr should carry the failure detail"
  );
  assert.equal(payload.timedOut, false);
  assert.equal(payload.durationMs, 0);
  assert.equal(typeof payload.startedAt, "string");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(payload.throttleHeaders, null);
  assert.ok(
    payload.recommendedAction && typeof payload.recommendedAction === "object",
    "recommendedAction must be present for unknown_error class"
  );
  assert.equal(payload.accountKey, "primary");
  assert.equal(payload.binary, null);
  assert.ok(
    (payload.sanitizedCommand as string).startsWith(
      "meta-ads-cli ads campaign activate"
    )
  );
  assert.deepEqual(payload.sanitizedArgs, [
    "ads",
    "campaign",
    "activate",
    "--id",
    "cmp_777",
  ]);

  // 既存の identity フィールドも保持される (回帰防止)。
  assert.equal(payload.mode, "cli");
  assert.equal(payload.stage, "verify_version");
  assert.equal(payload.errorName, "MetaCliVersionUnverifiedError");
  assert.equal(payload.resource, "campaigns");

  // pre-spawn 失敗なので spawn は呼ばれていない。
  assert.equal(spawnLog.length, 0);
});

test("CliActivateExecutor: load_token (missing/expired) pre-spawn failure payload includes canonical CLI evidence shape", async () => {
  const spawnLog: SpawnLog[] = [];
  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter(null),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:web-ui", source: "web" },
  });
  assert.equal(result.status, "auth_error");
  const payload = result.logPayload as Record<string, unknown>;

  // canonical evidence fields
  assert.equal(payload.exitClass, "auth_error");
  assert.equal(payload.exitCode, null);
  assert.equal(payload.signal, null);
  assert.equal(payload.stdout, "");
  assert.equal(typeof payload.stderr, "string");
  assert.ok(
    (payload.stderr as string).length > 0,
    "pre-spawn stderr should carry the failure detail"
  );
  assert.equal(payload.timedOut, false);
  assert.equal(payload.durationMs, 0);
  assert.equal(typeof payload.startedAt, "string");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(payload.throttleHeaders, null);
  assert.ok(
    payload.recommendedAction && typeof payload.recommendedAction === "object",
    "recommendedAction must be present for auth_error class"
  );
  assert.equal(payload.accountKey, "primary");
  assert.equal(payload.binary, null);
  assert.ok(
    (payload.sanitizedCommand as string).startsWith(
      "meta-ads-cli ads campaign activate"
    )
  );
  assert.deepEqual(payload.sanitizedArgs, [
    "ads",
    "campaign",
    "activate",
    "--id",
    "cmp_777",
  ]);

  // 既存の identity フィールドも保持される (回帰防止)。
  assert.equal(payload.mode, "cli");
  assert.equal(payload.stage, "load_token");
  assert.equal(payload.errorName, "MetaCliMissingTokenError");
  assert.equal(payload.resource, "campaigns");

  // pre-spawn 失敗なので spawn は呼ばれていない。
  assert.equal(spawnLog.length, 0);
});

test("resolveActivateExecutor: verifyVersion returns older-than-min version → executeActivate unknown_error", async () => {
  const spawnLog: SpawnLog[] = [];
  const sel = await resolveActivateExecutor({
    env: { ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => "meta-ads-cli 0.4.0",
  });
  assert.equal(sel.versionVerification?.ok, false);
  assert.equal(sel.versionVerification?.actualVersion, "0.4.0");

  const result = await sel.executor.executeActivate({
    node: pausedCampaign(),
    attempt: 0,
    request: { hierarchyId: "node-1", actor: "user:cli", source: "cli" },
  });
  assert.equal(result.status, "unknown_error");
  assert.equal(result.notify!.auditAction, "meta.cli_unknown_error");
  assert.equal(spawnLog.length, 0);
});

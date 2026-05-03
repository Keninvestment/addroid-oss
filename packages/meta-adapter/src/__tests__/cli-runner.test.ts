// AdDroid OSS — Meta Ads CLI execution adapter tests.
//
// 子プロセスの本物の spawn は使わず、`spawnImpl` を fake EventEmitter ChildProcess に
// 差し替える。ノードレベル CLI 実装に依存せず、runner のロジック (env 注入、redact、
// exit 分類、throttle 抽出、version 検証) を網羅検証する。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  META_CLI_SUPPORTED_OPERATIONS,
  MetaCliBinaryNotConfiguredError,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliUnsupportedOperationError,
  MetaCliVersionUnverifiedError,
  classifyExit,
  isSupportedMetaCliOperation,
  parseSemver,
  parseThrottleHeaders,
  recommendActionForExit,
  redactArgv,
  redactEnvForLog,
  redactSecrets,
  semverGte,
  toExecutionLogInput,
} from "../index.js";

// ---------------------------------------------------------------------
// Fake ChildProcess machinery
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
  /** spawn 時にすぐエラー (ENOENT 相当) を出す。 */
  spawnError?: Error;
  /** stdout/stderr emit から close までの遅延 (ms)。 */
  delayMs?: number;
}

class FakeChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  killed = false;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signalCode = signal;
    return true;
  }
}

function makeSpawn(
  scripts: ScriptedRun[],
  log: SpawnLog[]
): (cmd: string, args?: readonly string[], opts?: Record<string, unknown>) => FakeChildProcess {
  return (cmd, args = [], opts = {}) => {
    log.push({
      command: cmd,
      args: Array.from(args),
      options: opts as Record<string, unknown>,
    });
    const child = new FakeChildProcess();
    const script = scripts.shift();
    if (!script) {
      throw new Error(`fake spawn: no scripted run remaining for ${cmd}`);
    }
    const delay = script.delayMs ?? 1;
    if (script.spawnError) {
      setTimeout(() => child.emit("error", script.spawnError), delay);
      return child;
    }
    setTimeout(() => {
      if (script.stdout) child.stdout.push(Buffer.from(script.stdout, "utf8"));
      if (script.stderr) child.stderr.push(Buffer.from(script.stderr, "utf8"));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", script.exitCode, script.signal ?? null);
    }, delay);
    return child;
  };
}

const TOKEN = "EAAabcdefghijklmnopqrstuvwxyz1234567890";

function makeRunner(
  scripts: ScriptedRun[],
  log: SpawnLog[],
  override?: { binaryPath?: string; minVersion?: string; baseEnv?: NodeJS.ProcessEnv }
): MetaCliRunner {
  return new MetaCliRunner({
    binaryPath: override?.binaryPath ?? "/opt/meta-ads-cli/bin/meta-ads-cli",
    loadTokenForAccount: async (key) =>
      key === "missing" ? null : { accessToken: TOKEN },
    spawnImpl: makeSpawn(scripts, log) as unknown as typeof import("node:child_process").spawn,
    baseEnv: override?.baseEnv ?? {
      PATH: "/usr/bin",
      HOME: "/home/user",
      ACCESS_TOKEN: "leaked-from-host-env-must-be-stripped",
      AD_ACCOUNT_ID: "act_host_should_be_stripped",
      BUSINESS_ID: "biz_host_should_be_stripped",
      META_ACCESS_TOKEN: "leaked-from-host-env-must-be-stripped",
      META_LEGACY_ACCESS_TOKEN: "leaked-from-host-env-must-be-stripped",
    },
    ...(override?.minVersion ? { minVersion: override.minVersion } : {}),
  });
}

// ---------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------

test("redactSecrets removes literal token, EAA-style tokens, access_token=, Bearer", () => {
  const txt = `req: access_token=${TOKEN}&fields=id\nAuth: Bearer ${TOKEN}\nappToken=123456|abcdefghij1234567890`;
  const sanitized = redactSecrets(txt, [TOKEN]);
  assert.ok(!sanitized.includes(TOKEN));
  assert.match(sanitized, /access_token=\[REDACTED\]/);
  assert.match(sanitized, /Bearer \[REDACTED\]/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("redactSecrets ignores empty / too-short secrets to avoid mass-redaction", () => {
  const out = redactSecrets("hello world", ["", "ab"]);
  assert.equal(out, "hello world");
});

test("redactArgv replaces token in any arg position", () => {
  const args = ["ads", "campaign", "list", "--access-token", TOKEN];
  const out = redactArgv(args, [TOKEN]);
  assert.ok(!out.some((a) => a.includes(TOKEN)));
  assert.equal(out[4], "[REDACTED]");
});

test("redactEnvForLog redacts official/META/FB/ADDROID access-token vars", () => {
  const env = {
    PATH: "/usr/bin",
    ACCESS_TOKEN: "secret-0",
    META_ACCESS_TOKEN: "secret",
    META_BRANDX_ACCESS_TOKEN: "secret-2",
    FB_ACCESS_TOKEN: "secret-3",
    ADDROID_META_BRANDX_ACCESS_TOKEN: "secret-4",
    UNRELATED: "ok",
  };
  const out = redactEnvForLog(env);
  assert.equal(out.ACCESS_TOKEN, "[REDACTED]");
  assert.equal(out.META_ACCESS_TOKEN, "[REDACTED]");
  assert.equal(out.META_BRANDX_ACCESS_TOKEN, "[REDACTED]");
  assert.equal(out.FB_ACCESS_TOKEN, "[REDACTED]");
  assert.equal(out.ADDROID_META_BRANDX_ACCESS_TOKEN, "[REDACTED]");
  assert.equal(out.UNRELATED, "ok");
  assert.equal(out.PATH, "/usr/bin");
});

test("classifyExit returns success on exit 0", () => {
  assert.equal(
    classifyExit({ exitCode: 0, signal: null, stderr: "", stdout: "ok", timedOut: false }),
    "success"
  );
});

test("classifyExit detects auth error from Meta error code 190", () => {
  const stderr = `{"error":{"message":"Error validating access token","type":"OAuthException","code":190}}`;
  assert.equal(
    classifyExit({ exitCode: 1, signal: null, stderr, stdout: "", timedOut: false }),
    "auth_error"
  );
});

test("classifyExit detects rate_limit_error from Meta error code 17", () => {
  const stderr = `error code=17 user_too_many_calls`;
  assert.equal(
    classifyExit({ exitCode: 4, signal: null, stderr, stdout: "", timedOut: false }),
    "rate_limit_error"
  );
});

test("classifyExit detects rate_limit_error from text patterns", () => {
  const stderr = "User request limit reached";
  assert.equal(
    classifyExit({ exitCode: 1, signal: null, stderr, stdout: "", timedOut: false }),
    "rate_limit_error"
  );
});

test("classifyExit returns unknown_error for unrecognized non-zero exits", () => {
  assert.equal(
    classifyExit({
      exitCode: 99,
      signal: null,
      stderr: "Mystery failure",
      stdout: "",
      timedOut: false,
    }),
    "unknown_error"
  );
});

test("classifyExit returns api_error for non-auth/non-rate Meta error code (#100 invalid parameter)", () => {
  const stderr = `{"error":{"message":"Invalid parameter","type":"GraphMethodException","code":100,"fbtrace_id":"abc"}}`;
  assert.equal(
    classifyExit({ exitCode: 5, signal: null, stderr, stdout: "", timedOut: false }),
    "api_error"
  );
});

test("classifyExit returns api_error from GraphMethodException text without explicit code", () => {
  const stderr = "GraphMethodException: missing required field campaign_id";
  assert.equal(
    classifyExit({ exitCode: 1, signal: null, stderr, stdout: "", timedOut: false }),
    "api_error"
  );
});

test("classifyExit returns api_error from generic Meta error JSON block (Permissions error)", () => {
  const stderr =
    '{"error":{"message":"(#200) Permissions error","type":"OAuthException","code":200}}';
  // 200 は META_AUTH_ERROR_CODES にも入っているので auth_error 優先 (このケースは auth)
  assert.equal(
    classifyExit({ exitCode: 1, signal: null, stderr, stdout: "", timedOut: false }),
    "auth_error"
  );

  // Permissions error テキストだけで code が auth でも rate でもない場合は api_error
  const stderr2 = '{"error":{"message":"Permissions error","code":275}}';
  assert.equal(
    classifyExit({ exitCode: 1, signal: null, stderr: stderr2, stdout: "", timedOut: false }),
    "api_error"
  );
});

test("classifyExit keeps unknown_error for non-Meta runtime failures (segfault stays unknown)", () => {
  // 「segfault」だけのメッセージは Meta 由来パターンに一致せず unknown_error のまま。
  assert.equal(
    classifyExit({
      exitCode: 139,
      signal: null,
      stderr: "segfault",
      stdout: "",
      timedOut: false,
    }),
    "unknown_error"
  );
});

test("parseThrottleHeaders extracts X-Business-Use-Case-Usage from stdout", () => {
  const out = parseThrottleHeaders(
    `X-Business-Use-Case-Usage: {"act_1":[{"type":"ads_management","call_count":80,"total_time":40,"total_cputime":50}]}`,
    ""
  );
  assert.ok(out);
  assert.match(out!.businessUseCase ?? "", /ads_management/);
});

test("parseThrottleHeaders returns null when no header present", () => {
  assert.equal(parseThrottleHeaders("just stdout", "just stderr"), null);
});

test("parseSemver / semverGte handle common shapes", () => {
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("meta-ads-cli 0.5.1 (build abcd)"), [0, 5, 1]);
  assert.deepEqual(parseSemver("0.5"), [0, 5, 0]);
  assert.equal(parseSemver("nope"), null);
  assert.equal(semverGte("0.5.0", "0.4.9"), true);
  assert.equal(semverGte("0.5.0", "0.5.0"), true);
  assert.equal(semverGte("0.5.0", "0.5.1"), false);
  assert.equal(semverGte("nope", "0.5.0"), false);
});

// ---------------------------------------------------------------------
// MetaCliRunner constructor / wiring
// ---------------------------------------------------------------------

test("MetaCliRunner constructor rejects empty binaryPath", () => {
  assert.throws(
    () =>
      new MetaCliRunner({
        binaryPath: "",
        loadTokenForAccount: async () => ({ accessToken: TOKEN }),
      }),
    MetaCliBinaryNotConfiguredError
  );
});

test("MetaCliRunner.run throws MetaCliMissingTokenError when token loader returns null", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([], log);
  await assert.rejects(
    () => runner.run({ accountKey: "missing", args: ["ads", "campaign", "list"] }),
    MetaCliMissingTokenError
  );
  assert.equal(log.length, 0, "spawn must not be invoked when token is missing");
});

// ---------------------------------------------------------------------
// MetaCliRunner.run — env injection / argv sanitization
// ---------------------------------------------------------------------

test("MetaCliRunner.run injects token via env only and never via argv", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: "ok\n", stderr: "", exitCode: 0 }],
    log
  );
  const result = await runner.run({
    accountKey: "brandX",
    adAccountId: "act_1",
    args: ["ads", "campaign", "list"],
  });

  assert.equal(log.length, 1);
  const call = log[0]!;
  // argv に token は含まれない
  for (const a of call.args) assert.ok(!a.includes(TOKEN), `arg leaked token: ${a}`);
  // env に公式 CLI 名で token/account id が乗る
  const env = call.options.env as Record<string, string>;
  assert.equal(env.ACCESS_TOKEN, TOKEN);
  assert.equal(env.AD_ACCOUNT_ID, "act_1");
  assert.equal(env.META_ACCESS_TOKEN, undefined);
  assert.equal(env.META_BRANDX_ACCESS_TOKEN, undefined);
  assert.equal(env.META_BRANDX_AD_ACCOUNT_ID, undefined);
  // baseEnv に紛れ込んでいた他社 Meta CLI 設定は剥がされる
  assert.equal(env.META_LEGACY_ACCESS_TOKEN, undefined);
  assert.equal(env.BUSINESS_ID, undefined);
  // PATH は通る
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitClass, "success");
});

test("MetaCliRunner.run scrubs token if it accidentally appears in argv", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: "ok\n", stderr: "", exitCode: 0 }],
    log
  );
  await runner.run({
    accountKey: "b",
    args: ["ads", "campaign", "list", "--access-token", TOKEN],
  });
  const call = log[0]!;
  assert.ok(!call.args.some((a) => a.includes(TOKEN)));
  assert.ok(call.args.includes("[REDACTED]"));
});

test("MetaCliRunner.run merges extraEnv but token keys override", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: "", stderr: "", exitCode: 0 }],
    log
  );
  await runner.run({
    accountKey: "b",
    args: ["ads", "adaccount", "list"],
    adAccountId: "act_2",
    extraEnv: {
      ACCESS_TOKEN: "must-not-win",
      AD_ACCOUNT_ID: "act_must_not_win",
      META_ACCESS_TOKEN: "must-not-win",
      META_API_VERSION: "v19.0",
      FOO: "bar",
    },
  });
  const env = log[0]!.options.env as Record<string, string>;
  assert.equal(env.META_API_VERSION, "v19.0");
  assert.equal(env.FOO, "bar");
  assert.equal(env.ACCESS_TOKEN, TOKEN);
  assert.equal(env.AD_ACCOUNT_ID, "act_2");
  assert.equal(env.META_ACCESS_TOKEN, undefined);
});

// ---------------------------------------------------------------------
// MetaCliRunner.run — exit classification
// ---------------------------------------------------------------------

test("MetaCliRunner.run classifies success", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: '{"data":[]}', stderr: "", exitCode: 0 }],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "success");
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
});

test("MetaCliRunner.run classifies auth_error from OAuthException stderr", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr: '{"error":{"type":"OAuthException","code":190,"message":"Error validating access token"}}',
        exitCode: 2,
      },
    ],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "auth_error");
  assert.equal(r.exitCode, 2);
});

test("MetaCliRunner.run classifies rate_limit_error and exposes throttle header", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr:
          'X-Business-Use-Case-Usage: {"act_1":[{"type":"ads_management","call_count":100}]}\n' +
          '{"error":{"code":17,"message":"User request limit reached"}}\n',
        exitCode: 4,
      },
    ],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "rate_limit_error");
  assert.ok(r.throttleHeaders);
  assert.match(r.throttleHeaders!.businessUseCase ?? "", /ads_management/);
});

test("MetaCliRunner.run classifies unknown_error when no auth/rate-limit signal", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: "", stderr: "segfault", exitCode: 139 }],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "unknown_error");
});

test("MetaCliRunner.run captures spawn error (ENOENT) without leaking token", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ exitCode: null, spawnError: new Error("spawn ENOENT") }],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "unknown_error");
  assert.match(r.stderr, /spawn error/);
  assert.ok(!r.stderr.includes(TOKEN));
});

// ---------------------------------------------------------------------
// MetaCliRunner.run — token scrubbing in stdout/stderr
// ---------------------------------------------------------------------

test("MetaCliRunner.run redacts token if it ever appears in stdout/stderr", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: `request: access_token=${TOKEN}\n`,
        stderr: `error: Bearer ${TOKEN} expired`,
        exitCode: 1,
      },
    ],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.ok(!r.stdout.includes(TOKEN));
  assert.ok(!r.stderr.includes(TOKEN));
  assert.match(r.stdout, /access_token=\[REDACTED\]/);
  assert.match(r.stderr, /Bearer \[REDACTED\]/);
  assert.ok(!r.sanitizedCommand.includes(TOKEN));
});

// ---------------------------------------------------------------------
// MetaCliRunner.run — timeout
// ---------------------------------------------------------------------

test("MetaCliRunner.run kills child on timeout and marks timedOut=true", async () => {
  // この script は close を発火しない (3 秒) のでタイムアウトで kill する。
  const slowSpawn = (
    _cmd: string,
    _args?: readonly string[],
    _opts?: Record<string, unknown>
  ): FakeChildProcess => {
    const child = new FakeChildProcess();
    // タイムアウト後 kill されたら close を発火する
    const origKill = child.kill.bind(child);
    child.kill = (sig: NodeJS.Signals = "SIGTERM") => {
      const r = origKill(sig);
      setTimeout(() => {
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", null, sig);
      }, 1);
      return r;
    };
    return child;
  };
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: slowSpawn as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    defaultTimeoutMs: 30,
  });
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitClass, "unknown_error");
});

// ---------------------------------------------------------------------
// MetaCliRunner.verifyVersion
// ---------------------------------------------------------------------

test("verifyVersion returns ok=true when meta-ads-cli >= minVersion via versionResolver", async () => {
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    versionResolver: async () => "meta-ads-cli 0.6.0",
    minVersion: "0.5.0",
    baseEnv: { PATH: "/usr/bin" },
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, true);
  assert.equal(v.actualVersion, "0.6.0");
  assert.equal(v.minVersion, "0.5.0");
});

test("verifyVersion returns ok=false when actual < minVersion", async () => {
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    versionResolver: async () => "0.4.9",
    minVersion: "0.5.0",
    baseEnv: { PATH: "/usr/bin" },
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, false);
  assert.match(v.detail, /older than required 0\.5\.0/);
});

test("verifyVersion returns ok=false when --version is unparseable", async () => {
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    versionResolver: async () => "preview-build",
    minVersion: "0.5.0",
    baseEnv: { PATH: "/usr/bin" },
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, false);
  assert.equal(v.actualVersion, "preview-build");
});

test("verifyVersion returns ok=false when CLI is unrunnable (binary missing)", async () => {
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/missing-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: makeSpawn(
      [{ exitCode: null, spawnError: new Error("spawn ENOENT") }],
      log
    ) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, false);
  assert.match(v.detail, /not runnable/);
});

test("verifyVersion via spawn parses --version stdout", async () => {
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: makeSpawn(
      [{ stdout: "meta-ads-cli 1.2.3\n", stderr: "", exitCode: 0 }],
      log
    ) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    minVersion: "1.0.0",
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, true);
  assert.equal(v.actualVersion, "1.2.3");
  assert.deepEqual(log[0]?.args, ["--version"]);
});

// ---------------------------------------------------------------------
// toExecutionLogInput
// ---------------------------------------------------------------------

test("toExecutionLogInput produces info-level success entry", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: '{"data":[]}', stderr: "", exitCode: 0 }],
    log
  );
  const r = await runner.run({ accountKey: "brandX", args: ["ads", "campaign", "list"] });
  const e = toExecutionLogInput(r, { refType: "apply_job", refId: "apply-123" });
  assert.equal(e.kind, "meta_cli");
  assert.equal(e.level, "info");
  assert.equal(e.refType, "apply_job");
  assert.equal(e.refId, "apply-123");
  assert.equal(e.payload.exitClass, "success");
  assert.equal(e.payload.accountKey, "brandX");
  assert.match(e.payload.sanitizedCommand, /meta-ads-cli/);
  assert.ok(!e.payload.sanitizedCommand.includes(TOKEN));
});

test("toExecutionLogInput uses warn level for rate_limit_error and error level for auth_error", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      { stdout: "", stderr: '{"error":{"code":17,"message":"limit"}}', exitCode: 4 },
      { stdout: "", stderr: '{"error":{"code":190,"message":"expired"}}', exitCode: 2 },
    ],
    log
  );
  const r1 = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  const r2 = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  const e1 = toExecutionLogInput(r1);
  const e2 = toExecutionLogInput(r2);
  assert.equal(e1.level, "warn");
  assert.equal(e2.level, "error");
});

test("toExecutionLogInput preserves PR / approval refs in payload", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: "ok", stderr: "", exitCode: 0 }],
    log
  );
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "create"] });
  const e = toExecutionLogInput(r, {
    refType: "approval_record",
    refId: "appr-1",
    pullRequestNumber: 42,
    approvalRecordId: "appr-1",
  });
  assert.equal(e.payload.pullRequestNumber, 42);
  assert.equal(e.payload.approvalRecordId, "appr-1");
});

// ---------------------------------------------------------------------
// recommendActionForExit — declarative retry / notification policy
// ---------------------------------------------------------------------

test("recommendActionForExit: success → no retry, no notify, info", () => {
  const a = recommendActionForExit("success");
  assert.equal(a.kind, "none");
  assert.equal(a.retry, false);
  assert.equal(a.notify, "none");
  assert.equal(a.logLevel, "info");
});

test("recommendActionForExit: auth_error → notify_reauth, no retry, error level", () => {
  const a = recommendActionForExit("auth_error");
  assert.equal(a.kind, "notify_reauth");
  assert.equal(a.retry, false);
  assert.equal(a.notify, "reauth_required");
  assert.equal(a.logLevel, "error");
  if (a.kind === "notify_reauth") {
    assert.equal(a.auditAction, "oauth.meta.reauth_required");
  } else {
    assert.fail("expected notify_reauth shape");
  }
});

test("recommendActionForExit: rate_limit_error → exponential backoff retry, warn level", () => {
  const a = recommendActionForExit("rate_limit_error");
  assert.equal(a.kind, "retry_with_backoff");
  assert.equal(a.retry, true);
  assert.equal(a.notify, "throttled");
  assert.equal(a.logLevel, "warn");
  if (a.kind === "retry_with_backoff") {
    assert.equal(a.backoffStrategy, "exponential");
    assert.ok(a.maxAttempts >= 2, "must retry at least once");
    assert.ok(a.initialBackoffMs > 0);
    assert.ok(a.maxBackoffMs >= a.initialBackoffMs);
  } else {
    assert.fail("expected retry_with_backoff shape");
  }
});

test("recommendActionForExit: unknown_error → fail_fast_notify, operator alert", () => {
  const a = recommendActionForExit("unknown_error");
  assert.equal(a.kind, "fail_fast_notify");
  assert.equal(a.retry, false);
  assert.equal(a.notify, "operator_alert");
  assert.equal(a.logLevel, "error");
  if (a.kind === "fail_fast_notify") {
    assert.equal(a.auditAction, "meta.cli_unknown_error");
  } else {
    assert.fail("expected fail_fast_notify shape");
  }
});

test("recommendActionForExit: api_error → notify_api_error, no retry, error level", () => {
  const a = recommendActionForExit("api_error");
  assert.equal(a.kind, "notify_api_error");
  assert.equal(a.retry, false);
  assert.equal(a.notify, "api_error");
  assert.equal(a.logLevel, "error");
  if (a.kind === "notify_api_error") {
    assert.equal(a.auditAction, "meta.api_error");
  } else {
    assert.fail("expected notify_api_error shape");
  }
});

// ---------------------------------------------------------------------
// MetaCliRunner.run + toExecutionLogInput — recommendedAction is persisted
// ---------------------------------------------------------------------

test("MetaCliRunner.run attaches recommendedAction matching exit class", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      { stdout: "ok", stderr: "", exitCode: 0 },
      { stdout: "", stderr: '{"error":{"code":190,"message":"expired"}}', exitCode: 2 },
      { stdout: "", stderr: '{"error":{"code":17,"message":"limit"}}', exitCode: 4 },
      {
        stdout: "",
        stderr: '{"error":{"message":"Invalid parameter","type":"GraphMethodException","code":100}}',
        exitCode: 5,
      },
      { stdout: "", stderr: "segfault", exitCode: 139 },
    ],
    log
  );
  const ok = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  const auth = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  const rl = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  const apiErr = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  const unk = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });

  assert.equal(ok.recommendedAction.kind, "none");
  assert.equal(auth.recommendedAction.kind, "notify_reauth");
  assert.equal(rl.recommendedAction.kind, "retry_with_backoff");
  assert.equal(apiErr.exitClass, "api_error");
  assert.equal(apiErr.recommendedAction.kind, "notify_api_error");
  assert.equal(unk.recommendedAction.kind, "fail_fast_notify");
});

test("toExecutionLogInput persists recommendedAction in payload and uses its logLevel", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      { stdout: "", stderr: '{"error":{"code":17,"message":"limit"}}', exitCode: 4 },
      { stdout: "", stderr: '{"error":{"code":190,"message":"expired"}}', exitCode: 2 },
      { stdout: "", stderr: "segfault", exitCode: 139 },
    ],
    log
  );
  const rl = toExecutionLogInput(await runner.run({ accountKey: "b", args: ["ads", "campaign", "create"] }));
  const auth = toExecutionLogInput(await runner.run({ accountKey: "b", args: ["ads", "campaign", "create"] }));
  const unk = toExecutionLogInput(await runner.run({ accountKey: "b", args: ["ads", "campaign", "create"] }));

  // payload.recommendedAction is the source of truth
  assert.equal(rl.payload.recommendedAction.kind, "retry_with_backoff");
  assert.equal(auth.payload.recommendedAction.kind, "notify_reauth");
  assert.equal(unk.payload.recommendedAction.kind, "fail_fast_notify");

  // log level is derived from recommendedAction (not a parallel switch)
  assert.equal(rl.level, "warn");
  assert.equal(auth.level, "error");
  assert.equal(unk.level, "error");

  // human-readable message tags the chosen action so audit grep works
  assert.match(rl.message, /action=retry_with_backoff/);
  assert.match(auth.message, /action=notify_reauth/);
  assert.match(unk.message, /action=fail_fast_notify/);
});

test("toExecutionLogInput omits action tag for success messages", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([{ stdout: "ok", stderr: "", exitCode: 0 }], log);
  const e = toExecutionLogInput(await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] }));
  assert.equal(e.level, "info");
  assert.equal(e.payload.recommendedAction.kind, "none");
  assert.doesNotMatch(e.message, /action=/);
});

// ---------------------------------------------------------------------
// Verified operation matrix (regression fix) — fail-closed gating
// ---------------------------------------------------------------------

test("META_CLI_SUPPORTED_OPERATIONS enumerates only verified resource/verb pairs", () => {
  // 既知の安全な read-only 操作は含まれる
  assert.ok(
    META_CLI_SUPPORTED_OPERATIONS.some(
      (op) => op.resource === "campaigns" && op.verb === "list" && op.mutates === false
    )
  );
  // mutating 操作も含まれるが PAUSED-by-default の create/update のみ
  assert.ok(
    META_CLI_SUPPORTED_OPERATIONS.some(
      (op) => op.resource === "campaigns" && op.verb === "create" && op.mutates === true
    )
  );
  // delete は別契約での明示的検証が必要 — 現マトリクスには含めない
  assert.equal(
    META_CLI_SUPPORTED_OPERATIONS.some((op) => op.verb === "delete"),
    false
  );
  // activate は release readiness で campaigns/adsets/ads に対し検証済み
  for (const resource of ["campaigns", "adsets", "ads"] as const) {
    const entry = META_CLI_SUPPORTED_OPERATIONS.find(
      (op) => op.resource === resource && op.verb === "activate"
    );
    assert.ok(entry, `activate must be verified for ${resource}`);
    assert.equal(entry?.mutates, true);
  }
});

test("isSupportedMetaCliOperation accepts entries from the default matrix", () => {
  const r1 = isSupportedMetaCliOperation(["ads", "campaign", "list"]);
  assert.equal(r1.supported, true);
  assert.equal(r1.entry?.resource, "campaigns");
  assert.equal(r1.entry?.verb, "list");

  const r2 = isSupportedMetaCliOperation(["ads", "campaign", "create", "--name", "x"]);
  assert.equal(r2.supported, true);
  assert.equal(r2.entry?.resource, "campaigns");
  assert.equal(r2.entry?.mutates, true);

  const r3 = isSupportedMetaCliOperation([
    "--output",
    "json",
    "ads",
    "insights",
    "get",
    "--fields",
    "spend,clicks",
  ]);
  assert.equal(r3.supported, true);
  assert.equal(r3.entry?.resource, "insights");
  assert.equal(r3.entry?.verb, "get");
  assert.equal(r3.entry?.mutates, false);
});

test("isSupportedMetaCliOperation rejects unverified resource/verb combinations", () => {
  // 公式 prefix 不足
  assert.equal(isSupportedMetaCliOperation(["campaigns", "list"]).supported, false);
  // verb 不足
  assert.equal(isSupportedMetaCliOperation(["campaigns"]).supported, false);
  assert.equal(isSupportedMetaCliOperation(["ads", "campaign"]).supported, false);
  // 全く知らないリソース
  assert.equal(isSupportedMetaCliOperation(["sleep", "long"]).supported, false);
  // 知っているリソースだが verb が未承認 (delete はマトリクスに無い)
  assert.equal(isSupportedMetaCliOperation(["ads", "campaign", "delete"]).supported, false);
  // 第 1 引数が flag (positional でない)
  assert.equal(isSupportedMetaCliOperation(["--help"]).supported, false);
  // 第 2 引数が flag — verb として採用しない
  assert.equal(isSupportedMetaCliOperation(["ads", "campaign", "--help"]).supported, false);
  // 空 args
  assert.equal(isSupportedMetaCliOperation([]).supported, false);
});

test("isSupportedMetaCliOperation honors caller-supplied matrix override", () => {
  const matrix = [{ resource: "x", verb: "y", mutates: false }] as const;
  assert.equal(isSupportedMetaCliOperation(["ads", "x", "y"], matrix).supported, true);
  assert.equal(isSupportedMetaCliOperation(["ads", "campaign", "list"], matrix).supported, false);
});

test("MetaCliRunner.run throws MetaCliUnsupportedOperationError before spawning for unverified ops", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([], log);
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["wat", "delete"] }),
    (err: unknown) => {
      assert.ok(err instanceof MetaCliUnsupportedOperationError);
      assert.equal(err.attemptedResource, "wat");
      assert.equal(err.attemptedVerb, "delete");
      assert.match(err.message, /unverified operation/);
      return true;
    }
  );
  assert.equal(log.length, 0, "spawn must not be invoked for unsupported operations");
});

test("MetaCliRunner.run rejects empty / flag-only args without spawning", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([], log);
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: [] }),
    MetaCliUnsupportedOperationError
  );
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["--help"] }),
    MetaCliUnsupportedOperationError
  );
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["ads", "campaign", "--help"] }),
    MetaCliUnsupportedOperationError
  );
  assert.equal(log.length, 0);
});

test("MetaCliRunner.run rejects unsupported op before loading the access token", async () => {
  // token loader を呼んだら fail させる loader を仕込み、support 検査が
  // それより前に走ることを保証する。
  let tokenLoaderCalled = false;
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => {
      tokenLoaderCalled = true;
      return { accessToken: TOKEN };
    },
    spawnImpl: makeSpawn([], log) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
  });
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["nope", "frobnicate"] }),
    MetaCliUnsupportedOperationError
  );
  assert.equal(tokenLoaderCalled, false, "token must not be loaded for unsupported ops");
  assert.equal(log.length, 0);
});

// ---------------------------------------------------------------------
// regression fix: requireVerifiedVersion fail-closed gating
// ---------------------------------------------------------------------

test("MetaCliRunner.run with requireVerifiedVersion throws MetaCliVersionUnverifiedError if verifyVersion was never called", async () => {
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: makeSpawn([], log) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    requireVerifiedVersion: true,
  });
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] }),
    (err: unknown) => {
      assert.ok(err instanceof MetaCliVersionUnverifiedError);
      assert.equal(err.verification, null);
      assert.match(err.message, /version not verified/);
      return true;
    }
  );
  assert.equal(log.length, 0, "spawn must not be invoked when version is unverified");
});

test("MetaCliRunner.run with requireVerifiedVersion throws if verifyVersion returned ok=false", async () => {
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: makeSpawn([], log) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    minVersion: "0.5.0",
    versionResolver: async () => "0.4.9",
    requireVerifiedVersion: true,
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, false);
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] }),
    (err: unknown) => {
      assert.ok(err instanceof MetaCliVersionUnverifiedError);
      assert.equal(err.verification?.ok, false);
      assert.equal(err.verification?.actualVersion, "0.4.9");
      assert.equal(err.verification?.minVersion, "0.5.0");
      return true;
    }
  );
  assert.equal(log.length, 0, "spawn must not be invoked when version verification failed");
});

test("MetaCliRunner.run with requireVerifiedVersion proceeds after verifyVersion returns ok=true", async () => {
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: makeSpawn(
      [{ stdout: "ok\n", stderr: "", exitCode: 0 }],
      log
    ) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    minVersion: "0.5.0",
    versionResolver: async () => "0.5.1",
    requireVerifiedVersion: true,
  });
  const v = await runner.verifyVersion();
  assert.equal(v.ok, true);
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "success");
  assert.equal(log.length, 1, "spawn must be invoked exactly once after version verified");
});

test("MetaCliRunner.run rejects unverified version BEFORE loading the access token", async () => {
  // token loader を呼んだら fail させる loader を仕込み、version 検査が
  // それより前に走ることを保証する。
  let tokenLoaderCalled = false;
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => {
      tokenLoaderCalled = true;
      return { accessToken: TOKEN };
    },
    spawnImpl: makeSpawn([], log) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    requireVerifiedVersion: true,
  });
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] }),
    MetaCliVersionUnverifiedError
  );
  assert.equal(tokenLoaderCalled, false, "token must not be loaded for unverified runners");
  assert.equal(log.length, 0);
});

test("MetaCliRunner with requireVerifiedVersion=false (default) does not gate run() on verifyVersion", async () => {
  // option を指定しない限り verifyVersion を呼ばずに run() しても spawn される。
  const log: SpawnLog[] = [];
  const runner = makeRunner([{ stdout: "ok", stderr: "", exitCode: 0 }], log);
  const r = await runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] });
  assert.equal(r.exitClass, "success");
  assert.equal(log.length, 1);
});

test("MetaCliRunner.getVersionVerification returns null until verifyVersion runs, then caches result", async () => {
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    versionResolver: async () => "0.5.2",
    minVersion: "0.5.0",
    baseEnv: { PATH: "/usr/bin" },
  });
  assert.equal(runner.getVersionVerification(), null);
  const v = await runner.verifyVersion();
  assert.equal(v.ok, true);
  assert.equal(runner.getVersionVerification()?.ok, true);
  assert.equal(runner.getVersionVerification()?.actualVersion, "0.5.2");
});

// ---------------------------------------------------------------------

test("MetaCliRunner constructor accepts supportedOperations override (test seam)", async () => {
  const log: SpawnLog[] = [];
  const runner = new MetaCliRunner({
    binaryPath: "/bin/meta-ads-cli",
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    spawnImpl: makeSpawn(
      [{ stdout: "ok", stderr: "", exitCode: 0 }],
      log
    ) as unknown as typeof import("node:child_process").spawn,
    baseEnv: { PATH: "/usr/bin" },
    supportedOperations: [{ resource: "x", verb: "y", mutates: false }],
  });
  const r = await runner.run({ accountKey: "b", args: ["ads", "x", "y"] });
  assert.equal(r.exitClass, "success");
  // 既定マトリクス側の op はこの override 下では拒否される
  await assert.rejects(
    () => runner.run({ accountKey: "b", args: ["ads", "campaign", "list"] }),
    MetaCliUnsupportedOperationError
  );
});

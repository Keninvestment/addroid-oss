// `addroid up` の境界条件と preflight、そして worker 起動 → SIGTERM cleanup
// までの経路を検証する。
//
// `addroid up` は web (Next.js) と worker (pg-boss) を 1 プロセスで併走する。
// 本物の Next / pg-boss / Postgres を CI で起動するのは現実的でないため、
// `ADDROID_TEST_WORKER_RUNTIME_PATH` / `ADDROID_TEST_NEXT_FACTORY_PATH` の
// 注入ポイントを使って worker と next を fixture mock に差し替え、子プロセス
// として bin を spawn することで以下までを自動化された smoke として担保する:
//
//   1. preflight 通過 (DATABASE_URL + config.yaml が揃う)
//   2. worker 起動 (= startWorker が DATABASE_URL を伝播して呼ばれる)
//   3. pid file が ~/.addroid/run/up.json に書き出される
//   4. SIGTERM で graceful shutdown が走る (worker.stop が呼ばれる)
//   5. pid file が cleanup される (= ファイルが消える)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runUp } from "../commands/up.js";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const FIXTURES_DIR = path.join(HERE, "fixtures");
const FAKE_WORKER = path.join(FIXTURES_DIR, "up-fake-worker.mjs");
const FAKE_NEXT = path.join(FIXTURES_DIR, "up-fake-next.mjs");
const FAKE_SUPERVISED_WORKER = path.join(FIXTURES_DIR, "up-fake-supervised-worker.mjs");
// 子プロセスから src/index.ts を tsx 経由で起動する。bin/addroid.cjs を
// 経由すると `dist/index.mjs` が古いままだとテスト中の `src/commands/up.ts`
// 変更が反映されないため、本テストは tsx で TypeScript ソースを直接実行する。
const SRC_ENTRY = path.resolve(HERE, "..", "index.ts");
const TSX_BIN = path.resolve(HERE, "..", "..", "..", "..", "node_modules", ".bin", "tsx");

const STUB_CONFIG_YAML =
  "# AdDroid OSS test stub config\n" +
  "version: 1\n" +
  "workspace:\n" +
  "  slug: default\n" +
  "  displayName: Default Workspace\n" +
  "  executionMode: proposal\n" +
  "database:\n" +
  "  urlRef: (env)\n" +
  "web:\n" +
  "  hostname: 127.0.0.1\n" +
  "  port: 3000\n" +
  "github: {}\n";

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

async function withCleanHome<T>(
  overrides: Record<string, string | undefined>,
  fn: (home: string) => Promise<T>
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-up-"));
  const keys = ["ADDROID_HOME", "DATABASE_URL", ...Object.keys(overrides)];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];

  process.env.ADDROID_HOME = dir;
  delete process.env.DATABASE_URL;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  try {
    return await fn(dir);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("addroid up", () => {
  it("--help は Usage を出して 0 を返す", async () => {
    await withCleanHome({}, async () => {
      const { code, out } = await capture(() => runUp(["--help"]));
      assert.equal(code, 0);
      assert.match(out.stdout, /Usage:\s+addroid up/);
      assert.match(out.stdout, /--separate-worker/);
      assert.match(out.stdout, /localhost-bound and outbound-only/);
    });
  });

  it("DATABASE_URL 未設定で preflight 失敗 → exit 1 と actionable hint を出す", async () => {
    // DATABASE_URL を外し、ADDROID_HOME には config.yaml を置かない (どちらも欠ける状態)。
    await withCleanHome({}, async () => {
      const { code, out } = await capture(() => runUp([]));
      assert.equal(code, 1);
      assert.match(out.stderr, /\[addroid up\] 起動前チェックに失敗しました/);
      assert.match(out.stderr, /DATABASE_URL/);
      assert.match(out.stderr, /config\.yaml/);
      assert.match(out.stderr, /addroid init/);
    });
  });

  it("DATABASE_URL があっても config.yaml が無ければ preflight で stop する", async () => {
    await withCleanHome(
      { DATABASE_URL: "postgres://localhost:5432/addroid_test" },
      async (home) => {
        // config.yaml 不在を保証
        assert.equal(fs.existsSync(path.join(home, "config.yaml")), false);
        const { code, out } = await capture(() => runUp([]));
        assert.equal(code, 1);
        assert.match(out.stderr, /\[addroid up\] 起動前チェックに失敗しました/);
        assert.match(out.stderr, /config\.yaml/);
        assert.match(out.stderr, /addroid init/);
        // DATABASE_URL は指定済みなので、その項目は preflight に出ない。
        assert.doesNotMatch(out.stderr, /DATABASE_URL が設定されていません/);
      }
    );
  });

  it("未知のフラグは help を出して終了する (起動経路には進まない)", async () => {
    await withCleanHome({}, async () => {
      const { code, out } = await capture(() => runUp(["--bogus-flag"]));
      assert.equal(code, 0);
      assert.match(out.stderr, /unknown argument: --bogus-flag/);
      assert.match(out.stdout, /Usage:\s+addroid up/);
    });
  });

  it("startup guard blocks a new run when health owns a live generation-2 PID", async () => {
    await withCleanHome(
      { DATABASE_URL: "postgres://fixture.invalid/addroid" },
      async (home) => {
        fs.writeFileSync(path.join(home, "config.yaml"), STUB_CONFIG_YAML, "utf8");
        const runDir = path.join(home, "run");
        fs.mkdirSync(runDir, { recursive: true });
        const deadParentPid = 99_999_991;
        fs.writeFileSync(
          path.join(runDir, "up.json"),
          JSON.stringify({
            startedAt: new Date().toISOString(),
            parentPid: deadParentPid,
            workerPid: 99_999_992,
            webUrl: "http://127.0.0.1:1",
            cwd: process.cwd(),
            mode: "separate-worker",
            webStatus: "running",
          }),
          "utf8"
        );
        fs.writeFileSync(
          path.join(runDir, "worker-health.json"),
          JSON.stringify({
            version: 1,
            phase: "ready",
            supervisorPid: deadParentPid,
            generation: 2,
            workerPid: process.pid,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastAttemptAt: new Date().toISOString(),
            readyAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
            restartAttempts: 1,
            maxRestartAttempts: 5,
            heartbeatTimeoutMs: 20_000,
            nextRestartAt: null,
            lastFailure: null,
          }),
          "utf8"
        );

        const { code, out } = await capture(() => runUp([]));
        assert.equal(code, 1);
        assert.match(out.stderr, /既に起動済み/);
        assert.match(out.stderr, new RegExp(`worker pid: ${process.pid}`));
        const retained = JSON.parse(fs.readFileSync(path.join(runDir, "up.json"), "utf8"));
        assert.equal(retained.workerPid, 99_999_992, "guard must not rewrite state on read");
      }
    );
  });

  it("startup guard falls back to a live retained PID when matching backoff health has no worker PID", async () => {
    await withCleanHome(
      { DATABASE_URL: "postgres://fixture.invalid/addroid" },
      async (home) => {
        fs.writeFileSync(path.join(home, "config.yaml"), STUB_CONFIG_YAML, "utf8");
        const runDir = path.join(home, "run");
        fs.mkdirSync(runDir, { recursive: true });
        const deadParentPid = 99_999_991;
        fs.writeFileSync(
          path.join(runDir, "up.json"),
          JSON.stringify({
            startedAt: new Date().toISOString(),
            parentPid: deadParentPid,
            workerPid: process.pid,
            webUrl: "http://127.0.0.1:1",
            cwd: process.cwd(),
            mode: "separate-worker",
            webStatus: "running",
          }),
          "utf8"
        );
        fs.writeFileSync(
          path.join(runDir, "worker-health.json"),
          JSON.stringify({
            version: 1,
            phase: "backoff",
            supervisorPid: deadParentPid,
            generation: 2,
            workerPid: null,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastAttemptAt: new Date().toISOString(),
            readyAt: null,
            lastHeartbeatAt: null,
            restartAttempts: 1,
            maxRestartAttempts: 5,
            heartbeatTimeoutMs: 20_000,
            nextRestartAt: new Date(Date.now() + 1_000).toISOString(),
            lastFailure: {
              at: new Date().toISOString(),
              reason: "ready-timeout",
              message: "fixture worker is retiring",
              exitCode: null,
              signal: "SIGTERM",
            },
          }),
          "utf8"
        );

        const { code, out } = await capture(() => runUp([]));
        assert.equal(code, 1);
        assert.match(out.stderr, /既に起動済み/);
        assert.match(out.stderr, new RegExp(`worker pid: ${process.pid}`));
        const retained = JSON.parse(fs.readFileSync(path.join(runDir, "up.json"), "utf8"));
        assert.equal(retained.workerPid, process.pid, "guard must preserve the live retiring PID");
      }
    );
  });
});

// -----------------------------------------------------------------------------
// regression fix: worker 起動 + shutdown/cleanup の自動 smoke。
// preflight 通過後 (DATABASE_URL + config.yaml あり) に `addroid up` が
// 実際に worker.startWorker を呼び pid file を書き出すこと、SIGTERM で
// worker.stop と pid file cleanup が走ることを子プロセス経由で検証する。
// 本物の Next / pg-boss / Postgres には触らない (fixture mock を注入)。
// -----------------------------------------------------------------------------

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("could not pick free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(
  poll: () => T | null | undefined,
  opts: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<T> {
  const interval = opts.intervalMs ?? 50;
  const deadline = Date.now() + opts.timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = poll();
    if (result !== null && result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(
        `[up.test] ${opts.label} did not become ready within ${opts.timeoutMs}ms`
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

interface SpawnedUp {
  child: ReturnType<typeof spawn>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: { value: string };
  stderr: { value: string };
}

function spawnUp(env: NodeJS.ProcessEnv, extraArgs: string[] = []): SpawnedUp {
  const stdout = { value: "" };
  const stderr = { value: "" };
  const child = spawn(TSX_BIN, [SRC_ENTRY, "up", ...extraArgs], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout.value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    }
  );
  return { child, exited, stdout, stderr };
}

describe("addroid up — worker startup + shutdown smoke", () => {
  it(
    "preflight 通過後に worker.startWorker を DATABASE_URL 付きで呼び、pid file を書き出し、SIGTERM で worker.stop + pid file cleanup を行う",
    { timeout: 60_000 },
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-up-smoke-"));
      const startMarker = path.join(home, "worker-start.json");
      const stopMarker = path.join(home, "worker-stop.json");
      const pidFile = path.join(home, "run", "up.json");
      const port = await pickFreePort();
      const databaseUrl = "postgres://addroid:addroid@127.0.0.1:5432/addroid_smoke"; // oss-hygiene-allow: smoke-test fixture, mock worker never connects.

      fs.writeFileSync(path.join(home, "config.yaml"), STUB_CONFIG_YAML, "utf8");

      // ENCRYPTION_KEY は config パッケージの ensureAddroidPaths 経由で
      // 必須ではないが、念のため worker 経路で参照される可能性があるため設定する
      // (本テストの worker は mock なので実質未参照)。
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ADDROID_HOME: home,
        DATABASE_URL: databaseUrl,
        ADDROID_WEB_HOSTNAME: "127.0.0.1",
        ADDROID_WEB_PORT: String(port),
        ADDROID_TEST_WORKER_RUNTIME_PATH: FAKE_WORKER,
        ADDROID_TEST_NEXT_FACTORY_PATH: FAKE_NEXT,
        ADDROID_TEST_WORKER_START_MARKER: startMarker,
        ADDROID_TEST_WORKER_STOP_MARKER: stopMarker,
        // 親プロセスから漏れる可能性のある docker / DB / pid file 設定を排除。
        ADDROID_PIDFILE: undefined as unknown as string,
      };

      const up = spawnUp(env);

      try {
        // 1) worker.startWorker が呼ばれた証跡 (= start marker file の出現) を待つ。
        await waitFor(
          () => (fs.existsSync(startMarker) ? true : null),
          { timeoutMs: 30_000, label: "worker start marker" }
        );
        const startPayload = JSON.parse(fs.readFileSync(startMarker, "utf8")) as {
          databaseUrl: string | null;
          installSignalHandlers: boolean | null;
        };
        assert.equal(
          startPayload.databaseUrl,
          databaseUrl,
          "worker.startWorker は preflight 通過時の DATABASE_URL を受け取るべき"
        );
        assert.equal(
          startPayload.installSignalHandlers,
          false,
          "shared モードでは shutdown を CLI が握るので installSignalHandlers=false で呼ばれる"
        );

        // 2) pid file が書き出されることを待つ (= worker + web 起動完了の signal)。
        const pidState = await waitFor(
          () => {
            try {
              const raw = fs.readFileSync(pidFile, "utf8");
              const parsed = JSON.parse(raw) as { parentPid?: number; mode?: string };
              return parsed.parentPid && parsed.parentPid > 0 ? parsed : null;
            } catch {
              return null;
            }
          },
          { timeoutMs: 30_000, label: "up pid file" }
        );
        assert.equal(pidState.mode, "shared", "default mode は shared であるべき");

        // 3) SIGTERM を pid file 記録の parent pid に送って graceful shutdown を起動。
        process.kill(pidState.parentPid!, "SIGTERM");

        // 4) 子プロセスの exit を待つ (shutdown ハンドラが process.exit する)。
        const exit = await Promise.race([
          up.exited,
          new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (_resolve, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `[up.test] addroid up did not exit after SIGTERM within 20s\n` +
                        `stdout:\n${up.stdout.value}\nstderr:\n${up.stderr.value}`
                    )
                  ),
                20_000
              )
          ),
        ]);
        assert.equal(
          exit.code,
          0,
          `SIGTERM 後は exit 0 を期待 (signal=${exit.signal ?? "none"})\nstdout:\n${up.stdout.value}\nstderr:\n${up.stderr.value}`
        );

        // 5) worker.stop が呼ばれた証跡 (= stop marker file) と pid file cleanup を確認。
        assert.ok(
          fs.existsSync(stopMarker),
          `worker.stop が呼ばれていない (stop marker 不在: ${stopMarker})\nstdout:\n${up.stdout.value}\nstderr:\n${up.stderr.value}`
        );
        assert.equal(
          fs.existsSync(pidFile),
          false,
          `shutdown 後に pid file が cleanup されていない (${pidFile})`
        );
      } finally {
        if (up.child.exitCode === null && up.child.signalCode === null) {
          try {
            up.child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  );
});

describe("addroid up --separate-worker — supervised runtime fixture", () => {
  it(
    "direct runtime death is detected, generation 2 recovers, and one scheduled fixture completion is recorded",
    { timeout: 60_000 },
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-up-supervisor-"));
      const pidFile = path.join(home, "run", "up.json");
      const healthFile = path.join(home, "run", "worker-health.json");
      const eventsFile = path.join(home, "worker-events.jsonl");
      const jobEvidenceFile = path.join(home, "scheduled-job.json");
      const port = await pickFreePort();
      fs.writeFileSync(path.join(home, "config.yaml"), STUB_CONFIG_YAML, "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ADDROID_HOME: home,
        DATABASE_URL: "postgres://fixture.invalid/addroid", // fixture never connects
        ADDROID_WEB_HOSTNAME: "127.0.0.1",
        ADDROID_WEB_PORT: String(port),
        ADDROID_TEST_NEXT_FACTORY_PATH: FAKE_NEXT,
        ADDROID_TEST_WORKER_ENTRY_PATH: FAKE_SUPERVISED_WORKER,
        ADDROID_TEST_SUPERVISOR_EVENTS: eventsFile,
        ADDROID_TEST_SCHEDULED_JOB_EVIDENCE: jobEvidenceFile,
        ADDROID_TEST_DIE_FIRST_GENERATION: "1",
        ADDROID_WORKER_READY_TIMEOUT_MS: "500",
        ADDROID_WORKER_HEARTBEAT_TIMEOUT_MS: "500",
        ADDROID_WORKER_RESTART_BACKOFF_BASE_MS: "20",
        ADDROID_WORKER_RESTART_BACKOFF_MAX_MS: "20",
        ADDROID_WORKER_MAX_RESTART_ATTEMPTS: "3",
        ADDROID_WORKER_STABLE_RESET_MS: "1000",
      };
      const up = spawnUp(env, ["--separate-worker"]);
      try {
        const health = await waitFor(
          () => {
            try {
              const parsed = JSON.parse(fs.readFileSync(healthFile, "utf8")) as {
                generation?: number;
                phase?: string;
                workerPid?: number;
              };
              return parsed.generation === 2 && parsed.phase === "ready" ? parsed : null;
            } catch {
              return null;
            }
          },
          { timeoutMs: 30_000, label: "generation 2 ready" }
        );
        const pidState = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
          parentPid: number;
          workerPid?: number;
          mode: string;
        };
        assert.equal(pidState.mode, "separate-worker");
        assert.ok(health.workerPid && health.workerPid > 0);
        assert.notEqual(health.workerPid, pidState.parentPid, "worker PID must be the direct runtime");

        const job = JSON.parse(fs.readFileSync(jobEvidenceFile, "utf8")) as {
          jobId: string;
          generation: number;
          status: string;
        };
        assert.deepEqual(job, {
          jobId: "scheduled-fixture-1",
          generation: 2,
          status: "completed",
        });
        const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(events.filter((event) => event.event === "scheduled-job-completed").length, 1);

        process.kill(pidState.parentPid, "SIGTERM");
        const exit = await up.exited;
        assert.equal(exit.code, 0, `stdout:\n${up.stdout.value}\nstderr:\n${up.stderr.value}`);
        assert.equal(fs.existsSync(pidFile), false);
        const stopped = JSON.parse(fs.readFileSync(healthFile, "utf8")) as { phase: string };
        assert.equal(stopped.phase, "stopped");
      } finally {
        if (up.child.exitCode === null && up.child.signalCode === null) up.child.kill("SIGKILL");
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  );
});

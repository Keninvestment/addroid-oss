// `addroid up` — web (Next.js) と worker (pg-boss) を 1 つの CLI プロセスで併走する。
//
// the current implementation の既定モデルは「default の `addroid up` = 1 ローカルプロセス」。
// CLI は Next.js を programmatic に起動し、`@addroid/worker` の `startWorker()` を
// 同一プロセス上で直接呼ぶ。`--separate-worker` フラグを指定したときのみ worker を
// 子プロセスとして spawn し、将来の水平スケール (別ホストへ worker を移す) と同じ
// 分離境界をローカルでも再現できるようにする。
//
// 動作:
//   - DATABASE_URL / config.yaml の precheck (足りなければ actionable error で停止)
//   - web は 127.0.0.1:3000 に強制バインド (ADDROID_WEB_HOSTNAME 等で上書き可)
//   - shared モードでは CLI の stdout/stderr を ~/.addroid/logs/up.log に tee
//   - separate-worker モードでは worker stdout/stderr を ~/.addroid/logs/worker.log に追記
//   - pid file (~/.addroid/run/up.json) を書き出し、down/status から参照可能にする
//   - SIGINT/SIGTERM で graceful にツリー shutdown

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import {
  ensureAddroidPaths,
  resolveWebBinding,
  type AddroidPaths,
} from "@addroid/config";
import { resolveRepoRoot } from "../lib/paths.js";
import {
  clearUpState,
  isProcessAlive,
  readUpState,
  writeUpState,
  type UpMode,
  type UpState,
} from "../lib/processes.js";

interface ParsedArgs {
  mode: UpMode;
  help: boolean;
}

interface WorkerRuntimeModule {
  startWorker: (opts: {
    databaseUrl?: string | undefined;
    installSignalHandlers?: boolean;
  }) => Promise<{ stop: () => Promise<void> }>;
}

interface NextAppInstance {
  prepare: () => Promise<void>;
  getRequestHandler: () => (req: unknown, res: unknown) => Promise<void>;
  getUpgradeHandler?: () => (req: unknown, socket: unknown, head: unknown) => void;
  close?: () => Promise<void>;
}

type NextFactory = (opts: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => NextAppInstance;

// regression fix: worker / next の解決経路を関数に切り出し、E2E ハーネスから
// `ADDROID_TEST_WORKER_RUNTIME_PATH` / `ADDROID_TEST_NEXT_FACTORY_PATH` 経由で
// 差し替え可能にする。本番経路 (= env が未設定) では the current implementation の既定パス
// (apps/worker/src/runtime.ts と `next` パッケージ) が解決される。これにより
// 「`addroid up` が preflight 通過後に worker を起動 → pid file 書き出し →
// SIGTERM で worker.stop + cleanup」までを自動 smoke test で踏める。
async function loadWorkerRuntimeModule(repoRoot: string): Promise<WorkerRuntimeModule> {
  const override = process.env.ADDROID_TEST_WORKER_RUNTIME_PATH?.trim();
  const targetPath = override
    ? path.resolve(override)
    : path.join(repoRoot, "apps/worker/src/runtime.ts");
  const url = pathToFileURL(targetPath).href;
  return (await import(url)) as WorkerRuntimeModule;
}

async function loadNextFactory(): Promise<NextFactory> {
  const override = process.env.ADDROID_TEST_NEXT_FACTORY_PATH?.trim();
  if (override) {
    const url = pathToFileURL(path.resolve(override)).href;
    const mod = (await import(url)) as { default?: NextFactory } & Partial<NextFactory>;
    const factory = (mod.default ?? (mod as unknown as NextFactory)) as NextFactory;
    return factory;
  }
  const nextModule = (await import("next")) as typeof import("next");
  const factory =
    (nextModule as unknown as { default?: typeof nextModule }).default ?? nextModule;
  return factory as unknown as NextFactory;
}

export async function runUp(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const paths = await ensureAddroidPaths();
  const repoRoot = resolveRepoRoot();

  const precheck = await preflight(paths);
  if (!precheck.ok) {
    process.stderr.write(precheck.message);
    return 1;
  }

  const existing = await readUpState(paths);
  if (existing && (isProcessAlive(existing.parentPid) || isProcessAlive(existing.webPid) || isProcessAlive(existing.workerPid))) {
    process.stderr.write(
      [
        "[addroid up] 既に起動済みです。",
        `  pid file  : ${paths.pidFile}`,
        `  mode      : ${existing.mode}`,
        `  parent pid: ${existing.parentPid}${
          isProcessAlive(existing.parentPid) ? "" : " (not running)"
        }`,
        `  web pid   : ${existing.webPid ?? "(in parent)"}${
          existing.webPid && !isProcessAlive(existing.webPid) ? " (not running)" : ""
        }`,
        `  worker pid: ${existing.workerPid ?? "(in parent)"}${
          existing.workerPid && !isProcessAlive(existing.workerPid) ? " (not running)" : ""
        }`,
        "  停止するには別ターミナルで `addroid down` を実行してください。",
        "",
      ].join("\n")
    );
    return 1;
  }
  if (existing) {
    await clearUpState(paths);
  }

  let binding: { hostname: string; port: number };
  try {
    binding = resolveWebBinding();
  } catch (err) {
    process.stderr.write(
      [
        "[addroid up] localhost-only バインド設定の検証に失敗しました。",
        `  - ${(err as Error).message}`,
        "  ADDROID_WEB_HOSTNAME を 127.0.0.1 / localhost / ::1 のいずれかに設定し直すか、unset してデフォルト (127.0.0.1) に戻してください。",
        "",
      ].join("\n")
    );
    return 1;
  }
  process.env.ADDROID_WEB_HOSTNAME = binding.hostname;
  process.env.ADDROID_WEB_PORT = String(binding.port);

  process.stdout.write(
    [
      "[addroid up]",
      `  mode      : ${parsed.mode}`,
      `  repo root : ${repoRoot}`,
      `  web URL   : http://${binding.hostname}:${binding.port}  (localhost-only / outbound-only)`,
      parsed.mode === "shared"
        ? `  log file  : ${paths.upLogFile}`
        : `  web log   : ${paths.webLogFile}\n  worker log: ${paths.workerLogFile}`,
      `  pid file  : ${paths.pidFile}`,
      "  Ctrl+C で停止。別ターミナルから `addroid down` でも停止可能。",
      "",
    ].join("\n")
  );

  if (parsed.mode === "shared") {
    return await runShared({ paths, repoRoot, binding });
  }
  return await runSeparateWorker({ paths, repoRoot, binding });
}

function parseArgs(args: string[]): ParsedArgs {
  let mode: UpMode = "shared";
  let help = false;
  for (const a of args) {
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--separate-worker") mode = "separate-worker";
    else if (a === "--shared") mode = "shared";
    else {
      process.stderr.write(`[addroid up] unknown argument: ${a}\n`);
      help = true;
    }
  }
  return { mode, help };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: addroid up [--separate-worker]",
      "",
      "  (default)            web と worker を CLI と同じプロセスで併走 (the current implementation 既定モデル)",
      "  --separate-worker    worker を別プロセスとして spawn する (将来の水平スケール経路)",
      "",
      "All operations are localhost-bound and outbound-only.",
      "",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// shared mode (the current implementation default): web + worker in the same process
// ---------------------------------------------------------------------
interface SharedContext {
  paths: AddroidPaths;
  repoRoot: string;
  binding: { hostname: string; port: number };
}

async function runShared(ctx: SharedContext): Promise<number> {
  const upLog = fs.createWriteStream(ctx.paths.upLogFile, { flags: "a" });
  upLog.write(`\n--- [addroid up] shared mode started ${new Date().toISOString()} ---\n`);
  const restoreTee = teeStdio(upLog);

  let workerHandle: { stop: () => Promise<void> } | null = null;
  let httpServer: Server | null = null;
  let nextApp: { close?: () => Promise<void> } | null = null;
  let webStatus: "running" | "failed" = "running";
  let shuttingDown = false;
  let exitCode = 0;

  const shutdown = async (reason: string, code: number): Promise<never> => {
    if (shuttingDown) {
      // 二重呼び出しは block して exit を待つ。
      return new Promise<never>(() => undefined);
    }
    shuttingDown = true;
    exitCode = code;
    process.stdout.write(`\n[addroid up] shutting down (${reason})…\n`);
    try {
      if (httpServer) await closeServer(httpServer);
    } catch (err) {
      process.stderr.write(`[addroid up] web close error: ${(err as Error).message}\n`);
    }
    try {
      if (nextApp?.close) await nextApp.close();
    } catch (err) {
      process.stderr.write(`[addroid up] next close error: ${(err as Error).message}\n`);
    }
    try {
      if (workerHandle) await workerHandle.stop();
    } catch (err) {
      process.stderr.write(`[addroid up] worker stop error: ${(err as Error).message}\n`);
    }
    try {
      restoreTee();
      upLog.end();
    } catch {
      /* ignore */
    }
    await clearUpState(ctx.paths).catch(() => undefined);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[addroid up] uncaughtException: ${(err as Error).stack ?? err}\n`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[addroid up] unhandledRejection: ${String(err)}\n`);
    void shutdown("unhandledRejection", 1);
  });

  // 1) worker を同一プロセスで起動
  try {
    const workerModule = await loadWorkerRuntimeModule(ctx.repoRoot);
    workerHandle = await workerModule.startWorker({
      databaseUrl: process.env.DATABASE_URL,
      installSignalHandlers: false,
    });
  } catch (err) {
    process.stderr.write(`[addroid up] worker startup failed: ${(err as Error).message}\n`);
    return shutdown("worker-failed", 1);
  }

  // 2) Next.js を programmatic に起動 (apps/web をルートに)
  try {
    const webDir = path.join(ctx.repoRoot, "apps/web");
    // 注: `next` は @addroid/web の依存として root node_modules に hoist される。
    // CLI から直接 await import('next') すれば同じインスタンスが解決される。
    const nextFactory = await loadNextFactory();
    const dev = process.env.NODE_ENV !== "production";
    const app = nextFactory({
      dev,
      dir: webDir,
      hostname: ctx.binding.hostname,
      port: ctx.binding.port,
    });
    nextApp = app;
    await app.prepare();
    const handler = app.getRequestHandler();
    httpServer = createServer((req, res) => {
      void handler(req, res).catch((err: unknown) => {
        process.stderr.write(
          `[addroid up] web handler error: ${(err as Error).message}\n`
        );
      });
    });
    if (typeof app.getUpgradeHandler === "function") {
      const upgradeHandler = app.getUpgradeHandler();
      httpServer.on("upgrade", (req, socket, head) => {
        try {
          upgradeHandler(req, socket, head);
        } catch (err) {
          process.stderr.write(
            `[addroid up] web upgrade error: ${(err as Error).message}\n`
          );
        }
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer?.removeListener("error", onError);
        reject(err);
      };
      httpServer!.once("error", onError);
      httpServer!.listen(ctx.binding.port, ctx.binding.hostname, () => {
        httpServer!.removeListener("error", onError);
        resolve();
      });
    });
    process.stdout.write(
      `[addroid up] web ready on http://${ctx.binding.hostname}:${ctx.binding.port}\n`
    );
  } catch (err) {
    webStatus = "failed";
    process.stderr.write(
      [
        `[addroid up] web startup failed: ${(err as Error).message}`,
        `[addroid up] worker は引き続き稼働します — GitOps polling / Apply / Cron は通常通り。`,
        `[addroid up] Web UI を再起動するには Ctrl+C で停止後、\`addroid up\` を再実行してください。`,
        "",
      ].join("\n")
    );
    try {
      if (httpServer) await closeServer(httpServer);
    } catch {
      /* ignore — best-effort cleanup of partially-bound server */
    }
    httpServer = null;
    try {
      if (nextApp?.close) await nextApp.close();
    } catch {
      /* ignore — best-effort cleanup of partially-prepared next app */
    }
    nextApp = null;
  }

  // 3) pid file を書き出して、CLI を foreground で block する
  const state: UpState = {
    startedAt: new Date().toISOString(),
    parentPid: process.pid,
    webUrl: `http://${ctx.binding.hostname}:${ctx.binding.port}`,
    cwd: ctx.repoRoot,
    mode: "shared",
    webStatus,
  };
  await writeUpState(state, ctx.paths);

  return await new Promise<number>(() => {
    /* never resolves; shutdown handler invokes process.exit */
  });
}

function teeStdio(stream: fs.WriteStream): () => void {
  const origStdout = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const origStderr = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  const teeFactory = (orig: typeof process.stdout.write): typeof process.stdout.write => {
    const tee: typeof process.stdout.write = ((
      chunk: unknown,
      encodingOrCb?: unknown,
      cb?: unknown
    ): boolean => {
      try {
        if (typeof chunk === "string") stream.write(chunk);
        else if (chunk instanceof Uint8Array) stream.write(chunk);
      } catch {
        /* ignore log file errors */
      }
      return (orig as unknown as (
        c: unknown,
        e?: unknown,
        b?: unknown
      ) => boolean)(chunk, encodingOrCb, cb);
    }) as typeof process.stdout.write;
    return tee;
  };
  process.stdout.write = teeFactory(origStdout);
  process.stderr.write = teeFactory(origStderr);
  return () => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------
// separate-worker mode (将来の scale-out 経路): web in-process + worker child
// ---------------------------------------------------------------------
interface SpawnedChild {
  name: "worker";
  child: ChildProcess;
  logStream: fs.WriteStream;
}

async function runSeparateWorker(ctx: SharedContext): Promise<number> {
  // web は in-process で起動。worker のみ child process。
  const upLog = fs.createWriteStream(ctx.paths.upLogFile, { flags: "a" });
  upLog.write(
    `\n--- [addroid up] separate-worker mode started ${new Date().toISOString()} ---\n`
  );
  const restoreTee = teeStdio(upLog);

  const children: SpawnedChild[] = [];
  let httpServer: Server | null = null;
  let nextApp: { close?: () => Promise<void> } | null = null;
  let webStatus: "running" | "failed" = "running";
  let shuttingDown = false;
  let exitCode = 0;

  const shutdown = async (reason: string, code: number): Promise<never> => {
    if (shuttingDown) return new Promise<never>(() => undefined);
    shuttingDown = true;
    exitCode = code;
    process.stdout.write(`\n[addroid up] shutting down (${reason})…\n`);
    for (const c of children) {
      if (c.child.exitCode !== null || c.child.signalCode !== null) continue;
      try {
        c.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.child.exitCode !== null || c.child.signalCode !== null) return resolve();
            const timer = setTimeout(() => {
              try {
                c.child.kill("SIGKILL");
              } catch {
                /* ignore */
              }
              resolve();
            }, 5_000);
            c.child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          })
      )
    );
    for (const c of children) c.logStream.end();
    try {
      if (httpServer) await closeServer(httpServer);
    } catch (err) {
      process.stderr.write(`[addroid up] web close error: ${(err as Error).message}\n`);
    }
    try {
      if (nextApp?.close) await nextApp.close();
    } catch (err) {
      process.stderr.write(`[addroid up] next close error: ${(err as Error).message}\n`);
    }
    try {
      restoreTee();
      upLog.end();
    } catch {
      /* ignore */
    }
    await clearUpState(ctx.paths).catch(() => undefined);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });

  // 1) worker を子プロセスとして spawn
  const workerChild = spawnWorkerChild(ctx);
  children.push(workerChild);
  workerChild.child.on("exit", (code, signal) => {
    process.stdout.write(
      `[addroid up] worker exited (code=${code ?? "null"}, signal=${signal ?? "none"}).\n`
    );
    if (!shuttingDown) {
      void shutdown("worker-exited", code ?? 1);
    }
  });

  // 2) Next.js を programmatic に in-process で起動
  try {
    const webDir = path.join(ctx.repoRoot, "apps/web");
    const nextFactory = await loadNextFactory();
    const dev = process.env.NODE_ENV !== "production";
    const app = nextFactory({
      dev,
      dir: webDir,
      hostname: ctx.binding.hostname,
      port: ctx.binding.port,
    });
    nextApp = app;
    await app.prepare();
    const handler = app.getRequestHandler();
    httpServer = createServer((req, res) => {
      void handler(req, res).catch((err: unknown) => {
        process.stderr.write(
          `[addroid up] web handler error: ${(err as Error).message}\n`
        );
      });
    });
    if (typeof app.getUpgradeHandler === "function") {
      const upgradeHandler = app.getUpgradeHandler();
      httpServer.on("upgrade", (req, socket, head) => {
        try {
          upgradeHandler(req, socket, head);
        } catch (err) {
          process.stderr.write(
            `[addroid up] web upgrade error: ${(err as Error).message}\n`
          );
        }
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer?.removeListener("error", onError);
        reject(err);
      };
      httpServer!.once("error", onError);
      httpServer!.listen(ctx.binding.port, ctx.binding.hostname, () => {
        httpServer!.removeListener("error", onError);
        resolve();
      });
    });
    process.stdout.write(
      `[addroid up] web ready on http://${ctx.binding.hostname}:${ctx.binding.port}\n`
    );
  } catch (err) {
    webStatus = "failed";
    process.stderr.write(
      [
        `[addroid up] web startup failed: ${(err as Error).message}`,
        `[addroid up] worker child は引き続き稼働します — GitOps polling / Apply / Cron は通常通り。`,
        `[addroid up] Web UI を再起動するには Ctrl+C で停止後、\`addroid up --separate-worker\` を再実行してください。`,
        "",
      ].join("\n")
    );
    try {
      if (httpServer) await closeServer(httpServer);
    } catch {
      /* ignore — best-effort cleanup of partially-bound server */
    }
    httpServer = null;
    try {
      if (nextApp?.close) await nextApp.close();
    } catch {
      /* ignore — best-effort cleanup of partially-prepared next app */
    }
    nextApp = null;
  }

  const state: UpState = {
    startedAt: new Date().toISOString(),
    parentPid: process.pid,
    webUrl: `http://${ctx.binding.hostname}:${ctx.binding.port}`,
    cwd: ctx.repoRoot,
    mode: "separate-worker",
    webStatus,
    ...(workerChild.child.pid !== undefined ? { workerPid: workerChild.child.pid } : {}),
  };
  await writeUpState(state, ctx.paths);

  return await new Promise<number>(() => {
    /* never resolves; shutdown handler invokes process.exit */
  });
}

function spawnWorkerChild(ctx: SharedContext): SpawnedChild {
  const logStream = fs.createWriteStream(ctx.paths.workerLogFile, { flags: "a" });
  logStream.write(`\n--- [addroid up] worker started ${new Date().toISOString()} ---\n`);
  const child = spawn(
    "npm",
    ["run", "--silent", "--workspace", "apps/worker", "dev"],
    {
      cwd: ctx.repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const tag = "[worker] ";
  const teeOut = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    logStream.write(text);
    process.stdout.write(prefixLines(text, tag));
  };
  const teeErr = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    logStream.write(text);
    process.stderr.write(prefixLines(text, tag));
  };
  child.stdout?.on("data", teeOut);
  child.stderr?.on("data", teeErr);
  child.on("error", (err) => {
    logStream.write(`[spawn error] ${(err as Error).message}\n`);
    process.stderr.write(`[addroid up] worker spawn error: ${(err as Error).message}\n`);
  });
  return { name: "worker", child, logStream };
}

function prefixLines(text: string, prefix: string): string {
  if (!text) return "";
  const trailing = text.endsWith("\n");
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.map((l) => prefix + l).join("\n") + (trailing ? "\n" : "");
}

// ---------------------------------------------------------------------
// preflight (DATABASE_URL + ~/.addroid/config.yaml の存在確認)
// ---------------------------------------------------------------------
interface PreflightResult {
  ok: boolean;
  message: string;
}

async function preflight(paths: AddroidPaths): Promise<PreflightResult> {
  const issues: string[] = [];
  if (!process.env.DATABASE_URL) {
    issues.push(
      [
        "DATABASE_URL が設定されていません。次のいずれかを行ってください:",
        "      1) `cp .env.example .env` してリポジトリ root の `.env` に値を書く",
        "         (Prisma `db:*` / Next.js / addroid CLI が auto-load します)",
        "      2) または `.env.local` に書く",
        "         (Next.js / addroid CLI は auto-load しますが、Prisma `db:*` は auto-load しません)",
        "      3) または shell で `export DATABASE_URL=...` する",
      ].join("\n  ")
    );
  }
  try {
    await fsp.access(paths.configFile);
  } catch {
    issues.push(
      `${paths.configFile} が存在しません。先に \`addroid init\` を実行してください。`
    );
  }
  if (issues.length === 0) return { ok: true, message: "" };
  return {
    ok: false,
    message:
      "[addroid up] 起動前チェックに失敗しました:\n" +
      issues.map((m) => `  - ${m}`).join("\n") +
      "\n",
  };
}

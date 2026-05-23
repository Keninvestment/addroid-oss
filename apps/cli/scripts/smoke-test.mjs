#!/usr/bin/env node
// AdDroid OSS — `@addroid/cli` の package smoke test。
//
// 目的:
//   1) `npm pack` で生成したバンドル tarball を、
//   2) クリーンな一時ディレクトリに `npm install` で展開し、
//   3) インストールされた `addroid` bin が `--help` と `doctor` を実行でき、
//      期待される出力と exit code を返すことを assert する。
//
// 検証範囲:
//   - npm install lifecycle が postinstall の non-invasive next-step message まで通る
//   - bin が `process.execPath` で `dist/index.mjs` を起動できる (tsx 不要)
//   - `addroid --help` が Usage を 0 で返す
//   - `addroid doctor` が clean smoke env (DATABASE_URL なし、ENCRYPTION_KEY ダミー)
//     で check を出力し 0 か 1 で終わる
//
// 本スクリプトはネットワーク・DB・pg-boss を一切叩かない。
// CI からは `npm run package:smoke --workspace apps/cli` で呼ばれる。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const CLI_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(CLI_DIR, "..", "..");

const ENCRYPTION_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function fail(msg, extra) {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  if (extra) process.stderr.write(`${extra}\n`);
  process.exit(1);
}

function info(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.captureOutput ? "pipe" : "inherit",
    env: opts.env ?? process.env,
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
  });
  if (opts.captureOutput) {
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
  return { code: result.status, stdout: "", stderr: "" };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-cli-smoke-"));
const installDir = path.join(tmpRoot, "install");
const homeDir = path.join(tmpRoot, "home");
fs.mkdirSync(installDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

let exitCode = 0;
try {
  // 1. Build the bundle (idempotent — prepack も同じことをする)。
  info("building bundle (esbuild)...");
  run("node", ["build.mjs"], { cwd: CLI_DIR });

  // 2. npm pack into the temp dir.
  info("running `npm pack` for @addroid/cli...");
  const packResult = run(
    "npm",
    ["pack", "--workspace", "apps/cli", "--pack-destination", tmpRoot, "--json"],
    { cwd: REPO_ROOT, captureOutput: true, timeoutMs: 180_000 }
  );
  if (packResult.code !== 0) {
    fail("npm pack failed", packResult.stderr);
  }
  let tarballName;
  try {
    const parsed = JSON.parse(packResult.stdout);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0].filename) {
      throw new Error("unexpected `npm pack --json` output shape");
    }
    // npm pack --json は { name, version, filename } 等を返す。
    // filename は tarball のファイル名 (basename) のみ。
    tarballName = path.basename(parsed[0].filename);
  } catch (err) {
    fail(`failed to parse npm pack output: ${err.message}`, packResult.stdout);
  }
  const tarballPath = path.join(tmpRoot, tarballName);
  if (!fs.existsSync(tarballPath)) {
    fail(`tarball not found at ${tarballPath}`);
  }
  info(`tarball: ${tarballPath}`);

  // 3. クリーンな install ディレクトリで `npm init -y` 後にインストール。
  info("installing tarball into clean temp dir (offline-equivalent)...");
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "addroid-cli-smoke", version: "0.0.0", private: true }, null, 2)
  );
  const installResult = run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--foreground-scripts", tarballPath],
    {
      cwd: installDir,
      captureOutput: true,
      timeoutMs: 300_000,
    }
  );
  if (installResult.code !== 0) {
    fail("npm install of packed CLI failed", installResult.stderr || installResult.stdout);
  }
  if (!/AdDroid OSS CLI installed/.test(installResult.stdout + installResult.stderr)) {
    fail("postinstall next-step message did not run", installResult.stdout + installResult.stderr);
  }

  // 4. Bin が dist 経由で起動できることを確認。
  const binPath = path.join(installDir, "node_modules", ".bin", "addroid");
  if (!fs.existsSync(binPath)) {
    fail(`addroid bin not exposed at ${binPath}`);
  }
  // インストールされた tarball には dist/index.mjs が含まれているはず。
  const installedDistPath = path.join(
    installDir,
    "node_modules",
    "@addroid",
    "cli",
    "dist",
    "index.mjs"
  );
  if (!fs.existsSync(installedDistPath)) {
    fail(`installed package missing dist/index.mjs at ${installedDistPath}`);
  }
  info(`bin path: ${binPath}`);

  // 5. `addroid --help` の verify。
  info("verifying `addroid --help`...");
  const helpResult = run(binPath, ["--help"], {
    captureOutput: true,
    cwd: installDir,
    timeoutMs: 60_000,
  });
  if (helpResult.code !== 0) {
    fail(`addroid --help exited with ${helpResult.code}`, helpResult.stderr);
  }
  if (!/addroid — AdDroid OSS local CLI/.test(helpResult.stdout)) {
    fail("addroid --help missing expected banner", helpResult.stdout);
  }
  for (const sub of ["init", "doctor", "up", "validate", "plan", "activate", "cron", "auth"]) {
    if (!new RegExp(`\\b${sub}\\b`).test(helpResult.stdout)) {
      fail(`addroid --help missing subcommand: ${sub}`, helpResult.stdout);
    }
  }
  if (!/localhost-bound and outbound-only/.test(helpResult.stdout)) {
    fail("addroid --help missing OSS posture line", helpResult.stdout);
  }
  info("ok: --help");

  // 6. `addroid doctor` の verify。clean env (DATABASE_URL を消す)。
  info("verifying `addroid doctor` in clean smoke env...");
  const doctorEnv = { ...process.env };
  // 真に「クリーン」を再現するため、親プロセスから漏れる可能性のある AdDroid 系環境変数を消す。
  delete doctorEnv.DATABASE_URL;
  delete doctorEnv.ADDROID_HOME;
  doctorEnv.HOME = homeDir;
  doctorEnv.ADDROID_HOME = homeDir;
  doctorEnv.ENCRYPTION_KEY = ENCRYPTION_KEY_B64;

  const doctorResult = run(binPath, ["doctor"], {
    captureOutput: true,
    cwd: installDir,
    env: doctorEnv,
    timeoutMs: 120_000,
  });
  if (doctorResult.code !== 0 && doctorResult.code !== 1) {
    fail(
      `addroid doctor exited with unexpected code ${doctorResult.code}`,
      `stdout:\n${doctorResult.stdout}\nstderr:\n${doctorResult.stderr}`
    );
  }
  if (!/\[addroid doctor\]/.test(doctorResult.stdout)) {
    fail("addroid doctor missing banner", doctorResult.stdout);
  }
  for (const name of [
    "uv",
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "config",
    "secrets.local.yaml",
    "prisma-connect",
  ]) {
    const re = new RegExp(name.replace(/\./g, "\\."), "i");
    if (!re.test(doctorResult.stdout)) {
      fail(`addroid doctor missing check: ${name}`, doctorResult.stdout);
    }
  }
  if (!/overall:\s+\[(ok|warn|error)\s*\]/.test(doctorResult.stdout)) {
    fail("addroid doctor missing overall: line", doctorResult.stdout);
  }
  info(`ok: doctor (exit ${doctorResult.code})`);

  info("PASS — package smoke test succeeded");
} catch (err) {
  process.stderr.write(`[smoke] uncaught error: ${err && err.stack ? err.stack : err}\n`);
  exitCode = 1;
} finally {
  // クリーンアップ。失敗時に証拠が欲しい場合は ADDROID_KEEP_SMOKE_TMP=1 を立てる。
  if (process.env.ADDROID_KEEP_SMOKE_TMP === "1") {
    info(`keeping ${tmpRoot} (ADDROID_KEEP_SMOKE_TMP=1)`);
  } else {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

process.exit(exitCode);

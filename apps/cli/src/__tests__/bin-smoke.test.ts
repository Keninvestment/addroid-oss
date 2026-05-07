// `apps/cli/bin/addroid.cjs` の subprocess 起動 smoke test。
//
// 既存の各 commands テスト (init / doctor / up / cron / etc.) は runX() を
// 直接 import して呼び出しているため、bin launcher 自身が壊れていても test は
// 通ってしまう。OSS 公開時の acceptance criterion
// "The installed package exposes the `addroid` CLI bin and can run
// `addroid doctor` in a clean smoke-test environment." を裏打ちするため、
// ここでは bin/addroid.cjs を実際に spawn して以下を assert する:
//   1) `--help` が Usage を stdout に出して exit 0
//   2) `doctor` がクリーン環境 (ADDROID_HOME = tmp / DATABASE_URL なし) で
//      check 行を出して exit 0/1 (環境依存の overall を許容)
//
// 本 test は network / DB / pg-boss を一切叩かない。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const BIN_PATH = path.resolve(HERE, "..", "..", "bin", "addroid.cjs");

const ENCRYPTION_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function runBin(
  args: string[],
  envOverrides: Record<string, string | undefined>
): { code: number; stdout: string; stderr: string } {
  // 親プロセスの環境変数をコピーして必要な上書きを適用する。
  // undefined は明示的に削除する (= clean smoke env を再現)。
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("bin/addroid.cjs は実在し、--help を実行すると Usage を出して exit 0", () => {
  assert.ok(fs.existsSync(BIN_PATH), `bin not found at ${BIN_PATH}`);
  const { code, stdout } = runBin(["--help"], {});
  assert.equal(code, 0, `expected exit 0, got ${code}`);
  assert.match(stdout, /addroid — AdDroid OSS local CLI/);
  // 主要サブコマンドが Usage に列挙されていること。
  for (const sub of [
    "init",
    "doctor",
    "up",
    "validate",
    "plan",
    "activate",
    "cron",
    "auth",
    "chat",
  ]) {
    assert.match(stdout, new RegExp(`\\b${sub}\\b`), `Usage missing: ${sub}`);
  }
  // OSS 性質を表す 1 行を assert (outbound-only / localhost-bound のメッセージ)。
  assert.match(stdout, /localhost-bound and outbound-only/);
});

test("bin/addroid.cjs doctor は clean smoke env で check と overall: を出して exit 0 か 1 を返す", () => {
  // 注意: bin/addroid.cjs は起動時に repo root の .env.local を process.env へ
  // 反映するため、ここで DATABASE_URL を delete しても subprocess 側で再
  // 注入される (=「クリーン」を完全に再現できない)。本テストの意図は
  // 「bin が dispatch されて doctor の出力構造を正しく印字する」ことの
  // smoke verification なので、どの check が pass / error になるかは環境
  // 依存として許容する。重要なのは:
  //   - bin が exit 0 / 1 のいずれかを返す (= プロセスがクラッシュしない)
  //   - doctor の check と overall: 行がすべて出力される
  //   - meta-ads-cli は ADDROID_META_ADS_CLI_MOCK=1 で ok 経路に入る
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-bin-smoke-"));
  try {
    const { code, stdout } = runBin(["doctor"], {
      ADDROID_HOME: tmpHome,
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      ADDROID_META_ADS_CLI_MOCK: "1",
    });
    // bin が走り切って 0 / 1 のどちらかで終わること (5xx 級のクラッシュではない)。
    assert.ok(
      code === 0 || code === 1,
      `expected exit 0 or 1, got ${code}\nstdout:\n${stdout}`
    );
    assert.match(stdout, /\[addroid doctor\]/);
    // doctor が出す 9 件の check 名が並ぶこと (state は環境依存)。
    for (const name of [
      "uv",
      "python3.12",
      "meta-ads-cli",
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "config",
      "secrets.local.yaml",
      "prisma-connect",
    ]) {
      assert.match(
        stdout,
        new RegExp(name.replace(/\./g, "\\."), "i"),
        `doctor output missing check: ${name}`
      );
    }
    assert.match(stdout, /overall:\s+\[(ok|warn|error)\s*\]/);
    // ADDROID_META_ADS_CLI_MOCK=1 のときは meta-ads-cli は ok を返す。
    assert.match(stdout, /meta-ads-cli\s+ADDROID_META_ADS_CLI_MOCK=1/);
    // ENCRYPTION_KEY を渡したので ok 行に出ているはず。
    assert.match(stdout, /\[\s*ok\s*\]\s+ENCRYPTION_KEY/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("bin/addroid.cjs unknown-command は exit 2 で Usage に誘導する", () => {
  const { code, stdout, stderr } = runBin(["totally-bogus-command"], {});
  assert.equal(code, 2, `expected exit 2, got ${code}`);
  assert.match(stderr, /unknown command: totally-bogus-command/);
  assert.match(stdout, /addroid — AdDroid OSS local CLI/);
});

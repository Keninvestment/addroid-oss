// `addroid doctor` の clean smoke-test 環境での挙動を検証する。
//
// addroid doctor は read-only で副作用が少なく、acceptance criterion
// "The installed package exposes the `addroid` CLI bin and can run
// `addroid doctor` in a clean smoke-test environment." を裏打ちする。
//
// 本テストでは DATABASE_URL を外し、ADDROID_HOME を一時ディレクトリに切り替え、
// ENCRYPTION_KEY を 32 バイトに固定することで本物の依存関係に触れない範囲を確認する。
// uv / psql は実環境を見るため、見つからなくても doctor 自身は actionable
// hint を出して終了することを assert する。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDoctor } from "../commands/doctor.js";

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

const ENCRYPTION_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes

async function withCleanEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: (home: string) => Promise<T>
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-doctor-"));
  const keys = [
    "ADDROID_HOME",
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    ...Object.keys(overrides),
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];

  process.env.ADDROID_HOME = dir;
  delete process.env.DATABASE_URL;
  delete process.env.ENCRYPTION_KEY;
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

describe("addroid doctor", () => {
  it("clean smoke env (DATABASE_URL 未設定 + 32-byte key) で check 行と overall を出力する", async () => {
    await withCleanEnv(
      {
        ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      },
      async () => {
        const { code, out } = await capture(() => runDoctor([]));
        // DATABASE_URL 未設定 → checkDatabaseUrl が error → exit 1。
        // CI smoke では DATABASE_URL の有無は本テストの観点ではなく、
        // 「doctor が落ちずに check を並べた上で overall を返す」ことが本旨。
        assert.ok([0, 1].includes(code), `unexpected exit code ${code}`);

        assert.match(out.stdout, /\[addroid doctor\]/);
        // check 名が並ぶことを assert (state が ok か error かは環境依存)。
        for (const name of [
          "platform",
          "uv",
          "github-cli",
          "DATABASE_URL",
          "ENCRYPTION_KEY",
          "config",
          "secrets.local.yaml",
          "prisma-connect",
        ]) {
          assert.match(
            out.stdout,
            new RegExp(name.replace(/\./g, "\\."), "i"),
            `doctor output missing check: ${name}`
          );
        }
        assert.match(out.stdout, /overall:\s+\[/);

        // ENCRYPTION_KEY も ok を返す。
        assert.match(out.stdout, /ENCRYPTION_KEY\s+set \(32 bytes/);
      }
    );
  });

  it("DATABASE_URL 未設定で overall が error になり exit 1 を返す", async () => {
    await withCleanEnv(
      {
        ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      },
      async () => {
        const { code, out } = await capture(() => runDoctor([]));
        assert.equal(code, 1);
        assert.match(out.stdout, /overall:\s+\[error\]/);
        // DATABASE_URL の actionable hint が出ること (CI で何を直せばいいか分かる必要あり)。
        assert.match(out.stdout, /DATABASE_URL/);
        assert.match(out.stdout, /\[error\]\s+DATABASE_URL/);
      }
    );
  });

  it("ENCRYPTION_KEY 未設定 (= 0 byte) も error として overall に伝播する", async () => {
    // DATABASE_URL は意図的に未設定にして prisma-connect を skip させる
    // (real DB に到達しようとしてテストを 10 秒以上ブロックさせない)。
    await withCleanEnv(
      {
        // ENCRYPTION_KEY は intentionally undefined
      },
      async () => {
        const { code, out } = await capture(() => runDoctor([]));
        assert.equal(code, 1);
        assert.match(out.stdout, /\[error\]\s+ENCRYPTION_KEY/);
        assert.match(out.stdout, /\[skip \]\s+prisma-connect/);
      }
    );
  });

  it("Meta Ads CLI が無くても doctor の必須診断には含めない", async () => {
    await withCleanEnv(
      {
        ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
        // PATH を一時的に空にしても Meta Ads CLI は標準必須診断に含まれない。
        PATH: "/nonexistent-empty-path-9999",
      },
      async () => {
        const { code, out } = await capture(() => runDoctor([]));
        assert.equal(code, 1);
        assert.doesNotMatch(out.stdout, /meta-ads-cli/i);
      }
    );
  });

  it("config.yaml が無い ADDROID_HOME では config を warn で返す (init を促す hint)", async () => {
    await withCleanEnv(
      {
        ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      },
      async (home) => {
        // config.yaml は存在しないことを保証 (withCleanEnv が一時 home を作るだけ)。
        assert.equal(fs.existsSync(path.join(home, "config.yaml")), false);
        const { code, out } = await capture(() => runDoctor([]));
        // DATABASE_URL 未設定によって overall=error なので exit 1 だが、config 行は warn。
        assert.equal(code, 1);
        assert.match(out.stdout, /\[warn \]\s+config/);
        assert.match(out.stdout, /addroid init/);
      }
    );
  });
});

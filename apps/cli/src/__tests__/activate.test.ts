// `addroid activate` のフラグ解釈と境界エラー出力を検証する。
// DB / Meta CLI を起動しない範囲の挙動 (引数バリデーション、help、DATABASE_URL 未設定) を扱う。

import test from "node:test";
import assert from "node:assert/strict";

import { runActivateCommand } from "../commands/activate.js";

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: Captured }> {
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

async function withoutDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

test("activate --help は stdout に Usage を出して 0 以外を返す", async () => {
  const { code, out } = await capture(() => runActivateCommand(["--help"]));
  assert.equal(code, 2);
  assert.match(out.stdout, /addroid activate/);
  assert.match(out.stdout, /<hierarchy_id>/);
});

test("activate は hierarchy_id 引数なしだと 2 で終了する", async () => {
  const { code, out } = await capture(() => runActivateCommand([]));
  assert.equal(code, 2);
  assert.match(out.stderr, /<hierarchy_id> が必要/);
});

test("activate は未知のオプションを拒否する", async () => {
  const { code, out } = await capture(() => runActivateCommand(["--bogus"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /未知のオプション/);
});

test("activate は引数の重複を拒否する", async () => {
  const { code, out } = await capture(() =>
    runActivateCommand(["node-a", "node-b"])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /余分な引数/);
});

test("activate は DATABASE_URL 未設定で exit 2", async () => {
  await withoutDatabaseUrl(async () => {
    const { code, out } = await capture(() =>
      runActivateCommand(["00000000-0000-0000-0000-000000000000"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /DATABASE_URL/);
  });
});

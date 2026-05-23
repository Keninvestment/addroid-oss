// `addroid validate` / `addroid plan --dry-run` の operation manifest 経路を検証する。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runValidate } from "../commands/validate.js";
import { runPlan } from "../commands/plan.js";

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

function writeFixture(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-cli-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function operation(accountKey = "primary"): string {
  return JSON.stringify(
    {
      version: 2,
      accountKey,
      intent: "set_budget",
      actions: [
        {
          kind: "adset.update",
          payload: { adsetId: "as_123", dailyBudget: 300 },
          entity: { nodeType: "adset", nodeKey: "as_123" },
        },
      ],
    },
    null,
    2
  );
}

test("validate exits 0 on a clean operation manifest repo", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/2026-05-17-budget.json": operation(),
  });
  try {
    const { code, out } = await capture(() => runValidate(["--root", dir]));
    assert.equal(code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /no issues/);
    assert.match(out.stdout, /operation files\s*:\s*1/);
  } finally {
    cleanup();
  }
});

test("validate --json emits operation counts", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/2026-05-17-budget.json": operation(),
  });
  try {
    const { code, out } = await capture(() =>
      runValidate(["--root", dir, "--json"])
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.counts.errors, 0);
    assert.equal(parsed.counts.operations, 1);
  } finally {
    cleanup();
  }
});

test("validate exits 1 on unsupported Graph operation", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/unsupported.json": JSON.stringify({
      version: 2,
      accountKey: "primary",
      actions: [{ kind: "experiment.create", payload: { name: "x" } }],
    }),
  });
  try {
    const { code, out } = await capture(() => runValidate(["--root", dir]));
    assert.equal(code, 1);
    assert.match(out.stdout, /unsupported Graph operation kind/);
  } finally {
    cleanup();
  }
});

test("plan without --dry-run exits 2", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/2026-05-17-budget.json": operation(),
  });
  try {
    const { code, out } = await capture(() => runPlan(["--root", dir]));
    assert.equal(code, 2);
    assert.match(out.stderr, /--dry-run/);
  } finally {
    cleanup();
  }
});

test("plan --dry-run reports operation actions", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/2026-05-17-budget.json": operation(),
  });
  try {
    const { code, out } = await capture(() => runPlan(["--root", dir, "--dry-run"]));
    assert.equal(code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /actions\s*:\s*1/);
    assert.match(out.stdout, /adset:update account=primary/);
  } finally {
    cleanup();
  }
});

test("plan --dry-run --account filters operations", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/2026-05-17-budget.json": operation("primary"),
    "operations/secondary/2026-05-17-budget.json": operation("secondary"),
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run", "--account", "secondary", "--json"])
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.counts.actions, 1);
    assert.equal(parsed.actions[0].account, "secondary");
  } finally {
    cleanup();
  }
});

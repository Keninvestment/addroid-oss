// AdDroid OSS — improvement_pr-runtime の operation manifest validator テスト。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createImprovementPrPlanValidator } from "../improvement-pr-runtime.js";

function writeFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-improvement-rt-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function manifest(amount: string): string {
  return JSON.stringify(
    {
      version: 2,
      accountKey: "primary",
      intent: "set_budget",
      actions: [
        {
          kind: "adset.update",
          payload: { adsetId: "as_123", dailyBudget: Number(amount) },
          entity: { nodeType: "adset", nodeKey: "as_123" },
        },
      ],
    },
    null,
    2
  );
}

function diff(content: string): string {
  return content
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n");
}

test("plan validator returns available=false when rootDir is null", async () => {
  const validator = createImprovementPrPlanValidator({ rootDir: null });
  const out = await validator.validate({ accountKey: "primary", files: [] });
  assert.equal(out.available, false);
  assert.equal(out.ok, false);
  assert.match(out.summary, /ADDROID_OPS_REPO_LOCAL_DIR not set/);
});

test("plan validator returns available=false when rootDir does not exist", async () => {
  const validator = createImprovementPrPlanValidator({
    rootDir: "/nonexistent/path/addroid-test-missing",
  });
  const out = await validator.validate({ accountKey: "primary", files: [] });
  assert.equal(out.available, false);
  assert.equal(out.ok, false);
  assert.match(out.summary, /does not exist/);
});

test("plan validator applies gitops operation manifest and runs runPlanForRoot ok", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/existing.json": manifest("200"),
  });
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    const out = await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "operations/primary/2026-05-17-budget.json",
          action: "create",
          diff: diff(manifest("300")),
        },
      ],
    });
    assert.equal(out.available, true);
    assert.equal(out.ok, true);
    assert.equal(out.risk, "ok");
    assert.equal(out.errors.length, 0);
    assert.match(out.summary, /plan ok for account=primary/);
    assert.equal(
      fs.existsSync(path.join(dir, "operations/primary/2026-05-17-budget.json")),
      false
    );
  } finally {
    cleanup();
  }
});

test("plan validator surfaces validation errors when applied operation is invalid", async () => {
  const { dir, cleanup } = writeFixture({});
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    const out = await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "operations/primary/broken.json",
          action: "create",
          diff: diff(JSON.stringify({ version: 2, accountKey: "primary", actions: [] })),
        },
      ],
    });
    assert.equal(out.available, true);
    assert.equal(out.ok, false);
    assert.equal(out.risk, "error");
    assert.ok(out.errors.some((e) => /actions\[\] is required/.test(e.message)));
  } finally {
    cleanup();
  }
});

test("plan validator sanitizes traversal-looking paths without mutating source root", async () => {
  const { dir, cleanup } = writeFixture({
    "operations/primary/existing.json": manifest("200"),
  });
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    const out = await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "../escape.json",
          action: "create",
          diff: diff(manifest("300")),
        },
      ],
    });
    assert.equal(out.available, true);
    assert.equal(out.ok, true);
    assert.equal(fs.existsSync(path.join(dir, "../escape.json")), false);
  } finally {
    cleanup();
  }
});

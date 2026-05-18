// AdDroid OSS — plan-runtime のユニットテスト.
//
// runPlanForRoot / persistPlanRun の挙動を fixture ops repo + fake PlanRunStore で検証する。
// - success: clean repo で risk=ok, perAccount に当該 account を 1 件
// - dry-run failure: budget guardrail 違反で risk=error, ok=false, validationErrors を埋める
// - account filter: filter で perAccount が絞られ、validation は repo 全体に対して動作
// - persistence: persistPlanRun が ExecutionLog に書き込む payload を検証
//
// Prisma を使わず PlanRunStore (recordPlanExecutionLog) を fake に差し替えるため、
// DB に依存しないユニットテストとして動かす。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  persistPlanRun,
  runPlanForRoot,
  type PlanRunStore,
  type RecordPlanExecutionLogInput,
} from "../plan-runtime.js";

// ---- helpers --------------------------------------------------------

function writeFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-plan-rt-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeFakeStore(): {
  store: PlanRunStore;
  recorded: RecordPlanExecutionLogInput[];
} {
  const recorded: RecordPlanExecutionLogInput[] = [];
  const store: PlanRunStore = {
    async recordPlanExecutionLog(input) {
      recorded.push(input);
      return { id: `log-${recorded.length}` };
    },
  };
  return { store, recorded };
}

const VALID_PROJECT = `version: 1
workspace:
  slug: default
  displayName: "Default Workspace"
`;
const VALID_CRON = `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: true
`;

function operationManifest(accountKey: string, actions: unknown[]): string {
  return `${JSON.stringify(
    {
      version: 1,
      accountKey,
      intent: "other",
      source: "test",
      actor: "test",
      rationale: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      actions,
    },
    null,
    2
  )}\n`;
}

// ---- runPlanForRoot: success ---------------------------------------

test("runPlanForRoot returns ok=true and risk=ok for a clean repo with paused campaigns", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/create-campaign.json": operationManifest("primary", [
      { resource: "campaign", verb: "create", args: ["ads", "campaign", "create", "--name", "Fall Promo", "--objective", "outcome_traffic", "--status", "paused"] },
    ]),
  });
  try {
    const out = runPlanForRoot({ rootDir: dir });
    assert.equal(out.ok, true);
    assert.equal(out.risk, "ok");
    assert.equal(out.validationErrors.length, 0);
    assert.equal(out.perAccount.length, 1);
    const acc = out.perAccount[0]!;
    assert.equal(acc.account, "primary");
    assert.equal(acc.counts.creates, 1);
    assert.equal(acc.counts.updates, 0);
    assert.equal(acc.counts.deletes, 0);
    assert.equal(acc.counts.errors, 0);
    assert.equal(acc.risk, "ok");
    assert.equal(out.totalCounts.creates, 1);
    assert.equal(typeof out.durationMs, "number");
  } finally {
    cleanup();
  }
});

// ---- runPlanForRoot: dry-run failure (validation error) ------------

test("runPlanForRoot reports dry-run failure for unsupported operation with ok=false", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/unsupported.json": operationManifest("primary", [
      { resource: "campaign", verb: "dance", args: ["ads", "campaign", "dance"] },
    ]),
  });
  try {
    const out = runPlanForRoot({ rootDir: dir });
    assert.equal(out.ok, false);
    assert.equal(out.risk, "error");
    assert.equal(out.perAccount.length, 1);
    assert.match(
      out.perAccount[0]!.findings.map((e) => e.message).join("\n"),
      /unsupported Meta CLI operation/
    );
  } finally {
    cleanup();
  }
});

// ---- runPlanForRoot: guardrail violation (plan-level error) --------

test("runPlanForRoot surfaces invalid operation manifest as validation errors", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/invalid.json": `{"version":1,"accountKey":"primary","actions":"nope"}\n`,
  });
  try {
    const out = runPlanForRoot({ rootDir: dir });
    assert.equal(out.ok, false);
    assert.equal(out.risk, "error");
    assert.ok(
      out.validationErrors.some((e) =>
        e.message.includes("actions[] is required")
      )
    );
  } finally {
    cleanup();
  }
});

// ---- runPlanForRoot: account filter --------------------------------

test("runPlanForRoot accountFilter restricts perAccount to matching account", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/a.json": operationManifest("primary", [
      { resource: "campaign", verb: "create", args: ["ads", "campaign", "create", "--name", "A"] },
    ]),
    "operations/secondary/b.json": operationManifest("secondary", [
      { resource: "campaign", verb: "create", args: ["ads", "campaign", "create", "--name", "B"] },
    ]),
  });
  try {
    const out = runPlanForRoot({ rootDir: dir, accountFilter: "secondary" });
    assert.equal(out.ok, true);
    assert.equal(out.perAccount.length, 1);
    assert.equal(out.perAccount[0]!.account, "secondary");
  } finally {
    cleanup();
  }
});

// ---- persistPlanRun: success path ----------------------------------

test("persistPlanRun records info-level execution log on a clean plan", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/create-campaign.json": operationManifest("primary", [
      { resource: "campaign", verb: "create", args: ["ads", "campaign", "create", "--name", "Fall Promo"] },
    ]),
  });
  try {
    const result = runPlanForRoot({ rootDir: dir });
    const { store, recorded } = makeFakeStore();
    const out = await persistPlanRun({
      store,
      workspaceId: "ws-1",
      source: "cli",
      triggeredBy: "user:cli",
      rootDir: dir,
      result,
    });
    assert.equal(out.id, "log-1");
    assert.equal(recorded.length, 1);
    const entry = recorded[0]!;
    assert.equal(entry.workspaceId, "ws-1");
    assert.equal(entry.level, "info");
    assert.match(entry.message, /plan ok/);
    assert.equal(entry.payload.source, "cli");
    assert.equal(entry.payload.triggeredBy, "user:cli");
    assert.equal(entry.payload.ok, true);
    assert.equal(entry.payload.risk, "ok");
    assert.equal(entry.payload.perAccount.length, 1);
    assert.equal(entry.payload.totalCounts.creates, 1);
  } finally {
    cleanup();
  }
});

// ---- persistPlanRun: failure path captures error level -------------

test("persistPlanRun records error-level log when validation fails", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/unsupported.json": operationManifest("primary", [
      { resource: "campaign", verb: "dance", args: ["ads", "campaign", "dance"] },
    ]),
  });
  try {
    const result = runPlanForRoot({ rootDir: dir });
    const { store, recorded } = makeFakeStore();
    await persistPlanRun({
      store,
      workspaceId: null,
      source: "ci",
      triggeredBy: "ci:plan",
      rootDir: dir,
      result,
    });
    assert.equal(recorded.length, 1);
    const entry = recorded[0]!;
    assert.equal(entry.level, "error");
    assert.match(entry.message, /plan failed/);
    assert.equal(entry.payload.ok, false);
    assert.equal(entry.payload.risk, "error");
    assert.equal(entry.payload.source, "ci");
    assert.ok((entry.payload.perAccount[0]?.findings.length ?? 0) > 0);
  } finally {
    cleanup();
  }
});

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

// ---- runPlanForRoot: success ---------------------------------------

test("runPlanForRoot returns ok=true and risk=ok for a clean repo with paused campaigns", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: fall-promo
    name: Fall Promo
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyUsd: 50
`,
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

test("runPlanForRoot reports dry-run failure (initial active campaign) with ok=false", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: launch
    name: Launch
    objective: OUTCOME_TRAFFIC
    initialState: active
    budget:
      dailyUsd: 100
`,
  });
  try {
    const out = runPlanForRoot({ rootDir: dir });
    assert.equal(out.ok, false);
    assert.equal(out.risk, "error");
    assert.ok(out.validationErrors.length > 0);
    assert.match(
      out.validationErrors.map((e) => e.message).join("\n"),
      /initialState: "paused"/
    );
  } finally {
    cleanup();
  }
});

// ---- runPlanForRoot: guardrail violation (plan-level error) --------

test("runPlanForRoot surfaces guardrail violations as plan-level errors", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
guardrails:
  maxDailyUsdPerCampaign: 50
campaigns:
  - id: fall
    name: Fall
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyUsd: 100
`,
  });
  try {
    const out = runPlanForRoot({ rootDir: dir });
    assert.equal(out.ok, false);
    assert.equal(out.risk, "error");
    assert.ok(
      out.validationErrors.some((e) =>
        e.message.includes("maxDailyUsdPerCampaign")
      )
    );
    assert.equal(out.perAccount.length, 1);
    assert.equal(out.perAccount[0]!.risk, "error");
    assert.ok(out.perAccount[0]!.counts.errors >= 1);
  } finally {
    cleanup();
  }
});

// ---- runPlanForRoot: account filter --------------------------------

test("runPlanForRoot accountFilter restricts perAccount to matching account", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: a
    name: A
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget: { dailyUsd: 10 }
`,
    "ads/accounts/secondary/brand.yaml": `version: 1
account:
  key: secondary
  displayName: "Secondary"
campaigns:
  - id: b
    name: B
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget: { dailyUsd: 20 }
`,
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
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: fall-promo
    name: Fall Promo
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget: { dailyUsd: 50 }
`,
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
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: launch
    name: Launch
    objective: OUTCOME_TRAFFIC
    initialState: active
    budget: { dailyUsd: 100 }
`,
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
    assert.ok(entry.payload.validationErrors.length > 0);
  } finally {
    cleanup();
  }
});

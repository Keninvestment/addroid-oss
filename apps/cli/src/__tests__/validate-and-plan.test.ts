// `addroid validate` / `addroid plan --dry-run` の挙動を fixture ops repo に対して直接検証する。
// CLI のコマンド実装 (commands/validate.ts, commands/plan.ts) を関数として呼び出し、
// stdout / stderr を捕捉して exit code と出力を確認する。

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
const VALID_BRAND_EMPTY = (key: string) => `version: 1
account:
  key: ${key}
  displayName: "${key} account"
campaigns: []
`;

test("validate exits 0 on a clean ops repo and reports brand count", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("primary"),
  });
  try {
    const { code, out } = await capture(() => runValidate(["--root", dir]));
    assert.equal(code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /no issues/);
    assert.match(out.stdout, /brand files\s*:\s*1/);
  } finally {
    cleanup();
  }
});

test("validate exits 1 on a path / account.key mismatch", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("not-primary"),
  });
  try {
    const { code, out } = await capture(() => runValidate(["--root", dir]));
    assert.equal(code, 1);
    assert.match(out.stdout, /does not match path key/);
  } finally {
    cleanup();
  }
});

test("validate --json emits a parsable result document", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("primary"),
  });
  try {
    const { code, out } = await capture(() =>
      runValidate(["--root", dir, "--json"])
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.counts.errors, 0);
    assert.equal(parsed.counts.brandFiles, 1);
  } finally {
    cleanup();
  }
});

test("plan without --dry-run exits 2 (the current implementation skeleton refuses)", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("primary"),
  });
  try {
    const { code, out } = await capture(() => runPlan(["--root", dir]));
    assert.equal(code, 2);
    assert.match(out.stderr, /--dry-run/);
  } finally {
    cleanup();
  }
});

test("plan --dry-run on a clean repo reports zero apply actions", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("primary"),
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run"])
    );
    assert.equal(code, 0);
    assert.match(out.stdout, /actions\s*:\s*0/);
  } finally {
    cleanup();
  }
});

test("plan --dry-run lists planned create_campaign actions per paused campaign", async () => {
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
      dailyBudget: 50
`,
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run", "--json"])
    );
    assert.equal(code, 0, out.stdout + out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0].kind, "create_campaign");
    assert.equal(parsed.actions[0].account, "primary");
    assert.equal(parsed.actions[0].campaignId, "fall-promo");
    assert.equal(parsed.actions[0].initialState, "paused");
    assert.equal(parsed.actions[0].budget.dailyBudget, 50);
  } finally {
    cleanup();
  }
});

test("plan --dry-run propagates validation failures with exit code 1", async () => {
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
      dailyBudget: 100
`,
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run"])
    );
    assert.equal(code, 1);
    assert.match(out.stdout, /validate に失敗したため plan を中断/);
  } finally {
    cleanup();
  }
});

// ---- --base flag (previous / base state comparison) --------------------

const BRAND_WITH_DAILY = (key: string, campaignId: string, dailyBudget: number) => `version: 1
account:
  key: ${key}
  displayName: "${key} account"
campaigns:
  - id: ${campaignId}
    name: ${campaignId}
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyBudget: ${dailyBudget}
`;

test("validate --base rejects unsafe budget increase against base", async () => {
  const base = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 50),
  });
  const target = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 200),
  });
  try {
    const { code, out } = await capture(() =>
      runValidate(["--root", target.dir, "--base", base.dir])
    );
    assert.equal(code, 1);
    assert.match(out.stdout, /increase exceeds/);
  } finally {
    base.cleanup();
    target.cleanup();
  }
});

test("validate --base accepts safe (at-ratio) budget increase", async () => {
  const base = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 50),
  });
  const target = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 100),
  });
  try {
    const { code, out } = await capture(() =>
      runValidate(["--root", target.dir, "--base", base.dir])
    );
    assert.equal(code, 0, out.stdout + out.stderr);
  } finally {
    base.cleanup();
    target.cleanup();
  }
});

test("plan --dry-run --base rejects unsafe budget increase against base", async () => {
  const base = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 50),
  });
  const target = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 200),
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", target.dir, "--base", base.dir, "--dry-run"])
    );
    assert.equal(code, 1);
    assert.match(out.stdout, /validate に失敗したため plan を中断/);
    assert.match(out.stdout, /increase exceeds/);
  } finally {
    base.cleanup();
    target.cleanup();
  }
});

const BRAND_WITH_LIFETIME = (key: string, campaignId: string, lifetimeBudget: number) => `version: 1
account:
  key: ${key}
  displayName: "${key} account"
campaigns:
  - id: ${campaignId}
    name: ${campaignId}
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      lifetimeBudget: ${lifetimeBudget}
`;

test("validate --base rejects unsafe lifetimeBudget increase against base", async () => {
  const base = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME("primary", "fall-promo", 500),
  });
  const target = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME("primary", "fall-promo", 2000),
  });
  try {
    const { code, out } = await capture(() =>
      runValidate(["--root", target.dir, "--base", base.dir])
    );
    assert.equal(code, 1);
    assert.match(out.stdout, /lifetimeBudget increase exceeds/);
  } finally {
    base.cleanup();
    target.cleanup();
  }
});

test("plan --dry-run --base rejects unsafe lifetimeBudget increase against base", async () => {
  const base = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME("primary", "fall-promo", 500),
  });
  const target = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME("primary", "fall-promo", 2000),
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", target.dir, "--base", base.dir, "--dry-run"])
    );
    assert.equal(code, 1);
    assert.match(out.stdout, /validate に失敗したため plan を中断/);
    assert.match(out.stdout, /lifetimeBudget increase exceeds/);
  } finally {
    base.cleanup();
    target.cleanup();
  }
});

test("plan --dry-run --base accepts safe (at-ratio) budget increase", async () => {
  const base = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 50),
  });
  const target = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_DAILY("primary", "fall-promo", 100),
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", target.dir, "--base", base.dir, "--dry-run", "--json"])
    );
    assert.equal(code, 0, out.stdout + out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    base.cleanup();
    target.cleanup();
  }
});

test("plan --dry-run --json emits hierarchical create_* actions for campaign/adset/ad/creative/experiment", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: fall
    name: Fall
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyBudget: 100
    adsets:
      - id: fall-jp
        name: "Fall JP"
        initialState: paused
        budget:
          dailyBudget: 50
        targeting:
          countries: [JP]
          ageMin: 25
          ageMax: 45
        ads:
          - id: fall-jp-ad-1
            name: "Fall JP Ad 1"
            creativeRef: creative-a
            initialState: paused
creatives:
  - id: creative-a
    name: "Creative A"
    mediaType: image
    headline: "Fall sale"
    callToAction: SHOP_NOW
experiments:
  - id: fall-test
    name: "Fall Test"
    campaignId: fall
    variants:
      - id: control
        adsetIds: [fall-jp]
        weight: 50
      - id: treatment
        adsetIds: [fall-jp]
        weight: 50
`,
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run", "--json"])
    );
    assert.equal(code, 0, out.stdout + out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.ok, true);
    const kinds: string[] = parsed.actions.map((a: { kind: string }) => a.kind);
    assert.deepEqual(kinds, [
      "create_creative",
      "create_campaign",
      "create_adset",
      "create_ad",
      "create_experiment",
    ]);
    const adset = parsed.actions.find(
      (a: { kind: string }) => a.kind === "create_adset"
    );
    assert.deepEqual(adset.targeting.countries, ["JP"]);
    const ad = parsed.actions.find(
      (a: { kind: string }) => a.kind === "create_ad"
    );
    assert.equal(ad.creativeRef, "creative-a");
  } finally {
    cleanup();
  }
});

test("plan --dry-run fails when guardrails.maxDailyBudgetPerCampaign is exceeded", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
guardrails:
  maxDailyBudgetPerCampaign: 50
campaigns:
  - id: fall
    name: Fall
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyBudget: 100
`,
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run"])
    );
    assert.equal(code, 1);
    assert.match(out.stdout, /maxDailyBudgetPerCampaign/);
  } finally {
    cleanup();
  }
});

test("plan --dry-run --account filters perAccount to a single account", async () => {
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
    budget: { dailyBudget: 10 }
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
    budget: { dailyBudget: 20 }
`,
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run", "--account", "secondary", "--json"])
    );
    assert.equal(code, 0, out.stdout + out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0].account, "secondary");
    assert.equal(parsed.actions[0].campaignId, "b");
  } finally {
    cleanup();
  }
});

test("plan rejects --source values outside ci|cli|web", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("primary"),
  });
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run", "--source", "bogus"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /--source/);
  } finally {
    cleanup();
  }
});

test("plan --persist without DATABASE_URL surfaces persist failure but still returns plan exit code", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_EMPTY("primary"),
  });
  const previousDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { code, out } = await capture(() =>
      runPlan(["--root", dir, "--dry-run", "--persist", "--source", "ci", "--json"])
    );
    assert.equal(code, 0, out.stdout + out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.persisted, false);
    assert.match(parsed.persistError, /DATABASE_URL/);
  } finally {
    if (previousDbUrl !== undefined) process.env.DATABASE_URL = previousDbUrl;
    cleanup();
  }
});

test("validate accepts the on-disk ops template after placeholder substitution", async () => {
  // 実テンプレート (templates/addroid-ops-template) を buildOpsTemplate 経由で展開して、
  // 「テンプレートそのものが validate を通る」ことを担保する。
  const { buildOpsTemplate } = await import("@addroid/ops-template");
  const files = buildOpsTemplate({
    workspaceSlug: "default",
    workspaceDisplayName: "Default Workspace",
    initialAccountKey: "primary",
    initialAccountDisplayName: "Primary Account",
  });
  const { dir, cleanup } = writeFixture(
    Object.fromEntries(
      files
        .filter((f) => f.path !== ".github/workflows/addroid-validate.yml" && f.path !== "README.md")
        .map((f) => [f.path, f.content])
    )
  );
  try {
    const { code, out } = await capture(() => runValidate(["--root", dir]));
    assert.equal(code, 0, out.stdout + out.stderr);
  } finally {
    cleanup();
  }
});

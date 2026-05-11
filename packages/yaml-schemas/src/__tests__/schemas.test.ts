import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AdsValidationError,
  BUDGET_INCREASE_RATIO_LIMIT,
  BrandYamlSchema,
  BudgetGuardPolicyYamlSchema,
  CronYamlSchema,
  ProjectYamlSchema,
  assertBrandYamlPathMatches,
  assertBudgetChangeIsSafe,
  assertInitialCampaignsArePaused,
  loadAndValidateOpsRepo,
  loadBudgetGuardPolicy,
  loadPreviousOpsRepoState,
} from "../index.js";

// ---- ProjectYamlSchema ---------------------------------------------------

test("ProjectYamlSchema accepts a valid project.yaml", () => {
  const r = ProjectYamlSchema.safeParse({
    version: 1,
    workspace: { slug: "default", displayName: "Default Workspace" },
  });
  assert.equal(r.success, true);
});

test("ProjectYamlSchema rejects an invalid slug", () => {
  const r = ProjectYamlSchema.safeParse({
    version: 1,
    workspace: { slug: "Default Workspace", displayName: "x" },
  });
  assert.equal(r.success, false);
});

test("ProjectYamlSchema rejects unknown top-level keys (strict)", () => {
  const r = ProjectYamlSchema.safeParse({
    version: 1,
    workspace: { slug: "default", displayName: "x" },
    extra: "boom",
  });
  assert.equal(r.success, false);
});

// ---- CronYamlSchema ------------------------------------------------------

test("CronYamlSchema accepts standard cron presets", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [
      { name: "github_poll", cron: "*/2 * * * *", enabled: true },
      { name: "daily_report", cron: "0 9 * * *", enabled: false },
      { name: "today_report", cron: "0 * * * *", enabled: false },
    ],
  });
  assert.equal(r.success, true);
});

test("CronYamlSchema rejects malformed cron expression", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "not a cron", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects out-of-range minute", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "60 * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects out-of-range hour", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "0 24 * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects out-of-range day-of-month", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "0 0 32 * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects out-of-range month", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "0 0 1 13 *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects out-of-range day-of-week", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "0 0 1 1 8", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema accepts day-of-week 7 (Sunday alias)", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "0 0 * * 7", enabled: true }],
  });
  assert.equal(r.success, true);
});

test("CronYamlSchema rejects inverted range", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "5-3 * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects out-of-range range endpoint", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "0-60 * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects zero step", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "*/0 * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects empty step", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "*/ * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects trailing comma", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "1,2, * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects too few fields", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "* * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects too many fields", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "github_poll", cron: "* * * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema accepts list / range / step combinations", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [
      { name: "github_poll", cron: "0,15,30,45 9-17 * * 1-5", enabled: true },
      { name: "daily_report", cron: "*/30 0-23/2 1,15 * *", enabled: false },
    ],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("CronYamlSchema rejects unknown preset name", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [{ name: "rogue_preset", cron: "* * * * *", enabled: true }],
  });
  assert.equal(r.success, false);
});

test("CronYamlSchema rejects duplicate schedule names", () => {
  const r = CronYamlSchema.safeParse({
    version: 1,
    schedules: [
      { name: "github_poll", cron: "*/2 * * * *", enabled: true },
      { name: "github_poll", cron: "*/3 * * * *", enabled: false },
    ],
  });
  assert.equal(r.success, false);
});

// ---- BrandYamlSchema -----------------------------------------------------

test("BrandYamlSchema accepts an empty campaigns array", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [],
  });
  assert.equal(r.success, true);
});

test("BrandYamlSchema accepts a paused campaign with a daily budget", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall-promo",
        name: "Fall Promo",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 50 },
      },
    ],
  });
  assert.equal(r.success, true);
});

test("BrandYamlSchema rejects an account.key with uppercase", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "Primary", displayName: "x" },
    campaigns: [],
  });
  assert.equal(r.success, false);
});

test("BrandYamlSchema rejects unknown campaign objective", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "x",
        name: "x",
        objective: "WORLD_DOMINATION",
        initialState: "paused",
        budget: { dailyUsd: 1 },
      },
    ],
  });
  assert.equal(r.success, false);
});

test("BrandYamlSchema rejects budget without dailyUsd or lifetimeUsd", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "x",
        name: "x",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: {},
      },
    ],
  });
  assert.equal(r.success, false);
});

test("BrandYamlSchema rejects duplicate campaign ids", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "dup",
        name: "a",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
      },
      {
        id: "dup",
        name: "b",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
      },
    ],
  });
  assert.equal(r.success, false);
});

// ---- assertBrandYamlPathMatches -----------------------------------------

test("assertBrandYamlPathMatches throws when key disagrees with path", () => {
  const brand = BrandYamlSchema.parse({
    version: 1,
    account: { key: "alpha", displayName: "Alpha" },
    campaigns: [],
  });
  assert.throws(
    () => assertBrandYamlPathMatches(brand, { expectedAccountKey: "beta" }),
    AdsValidationError
  );
});

test("assertBrandYamlPathMatches passes when key matches path", () => {
  const brand = BrandYamlSchema.parse({
    version: 1,
    account: { key: "alpha", displayName: "Alpha" },
    campaigns: [],
  });
  assertBrandYamlPathMatches(brand, { expectedAccountKey: "alpha" });
});

// ---- assertInitialCampaignsArePaused ------------------------------------

test("assertInitialCampaignsArePaused rejects new campaigns marked active", () => {
  const brand = BrandYamlSchema.parse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "new-active",
        name: "x",
        objective: "OUTCOME_TRAFFIC",
        initialState: "active",
        budget: { dailyUsd: 10 },
      },
    ],
  });
  assert.throws(() => assertInitialCampaignsArePaused(brand), AdsValidationError);
});

test("assertInitialCampaignsArePaused allows already-known active campaigns", () => {
  const brand = BrandYamlSchema.parse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "old-running",
        name: "x",
        objective: "OUTCOME_TRAFFIC",
        initialState: "active",
        budget: { dailyUsd: 10 },
      },
    ],
  });
  assertInitialCampaignsArePaused(brand, {
    previousIds: new Set(["old-running"]),
  });
});

// ---- assertBudgetChangeIsSafe -------------------------------------------

test("assertBudgetChangeIsSafe rejects empty next budget", () => {
  assert.throws(() => assertBudgetChangeIsSafe(null, {}), AdsValidationError);
});

test("assertBudgetChangeIsSafe rejects initial dailyUsd <= 0", () => {
  assert.throws(
    () => assertBudgetChangeIsSafe(null, { dailyUsd: 0 }),
    AdsValidationError
  );
});

test("assertBudgetChangeIsSafe accepts a sane initial dailyUsd", () => {
  assertBudgetChangeIsSafe(null, { dailyUsd: 50 });
});

test("assertBudgetChangeIsSafe rejects dropping dailyUsd to 0 from > 0", () => {
  assert.throws(
    () => assertBudgetChangeIsSafe({ dailyUsd: 50 }, { dailyUsd: 0 }),
    AdsValidationError
  );
});

test("assertBudgetChangeIsSafe rejects increase beyond ratio limit", () => {
  const before = { dailyUsd: 50 };
  const overLimit = 50 * BUDGET_INCREASE_RATIO_LIMIT + 1;
  assert.throws(
    () => assertBudgetChangeIsSafe(before, { dailyUsd: overLimit }),
    AdsValidationError
  );
});

test("assertBudgetChangeIsSafe accepts increase at ratio limit", () => {
  const before = { dailyUsd: 50 };
  assertBudgetChangeIsSafe(before, {
    dailyUsd: 50 * BUDGET_INCREASE_RATIO_LIMIT,
  });
});

test("assertBudgetChangeIsSafe rejects initial lifetimeUsd <= 0", () => {
  assert.throws(
    () => assertBudgetChangeIsSafe(null, { lifetimeUsd: 0 }),
    AdsValidationError
  );
});

test("assertBudgetChangeIsSafe accepts a sane initial lifetimeUsd", () => {
  assertBudgetChangeIsSafe(null, { lifetimeUsd: 500 });
});

test("assertBudgetChangeIsSafe rejects dropping lifetimeUsd to 0 from > 0", () => {
  assert.throws(
    () => assertBudgetChangeIsSafe({ lifetimeUsd: 500 }, { lifetimeUsd: 0 }),
    AdsValidationError
  );
});

test("assertBudgetChangeIsSafe rejects lifetimeUsd increase beyond ratio limit", () => {
  const before = { lifetimeUsd: 500 };
  const overLimit = 500 * BUDGET_INCREASE_RATIO_LIMIT + 1;
  assert.throws(
    () => assertBudgetChangeIsSafe(before, { lifetimeUsd: overLimit }),
    AdsValidationError
  );
});

test("assertBudgetChangeIsSafe accepts lifetimeUsd increase at ratio limit", () => {
  const before = { lifetimeUsd: 500 };
  assertBudgetChangeIsSafe(before, {
    lifetimeUsd: 500 * BUDGET_INCREASE_RATIO_LIMIT,
  });
});

// ---- loadAndValidateOpsRepo ---------------------------------------------

function writeFixture(
  files: Record<string, string>
): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-yaml-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const VALID_PROJECT_YAML = `version: 1
workspace:
  slug: default
  displayName: "Default Workspace"
`;
const VALID_CRON_YAML = `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: true
  - name: daily_report
    cron: "0 9 * * *"
    enabled: false
  - name: today_report
    cron: "0 * * * *"
    enabled: false
`;
const VALID_BRAND_YAML = (key: string) => `version: 1
account:
  key: ${key}
  displayName: "${key} account"
campaigns: []
`;

test("loadAndValidateOpsRepo passes for the canonical template shape", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_YAML("primary"),
  });
  try {
    const r = loadAndValidateOpsRepo(dir);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.errors.length, 0);
    assert.equal(r.loaded.brands.length, 1);
    assert.equal(r.loaded.brands[0]!.accountKey, "primary");
  } finally {
    cleanup();
  }
});

test("loadAndValidateOpsRepo flags account.key / path mismatch", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_YAML("not-primary"),
  });
  try {
    const r = loadAndValidateOpsRepo(dir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some(
        (f) =>
          f.file === "ads/accounts/primary/brand.yaml" &&
          /does not match path key/.test(f.message)
      )
    );
  } finally {
    cleanup();
  }
});

test("loadAndValidateOpsRepo flags malformed YAML", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": "version: 1\nworkspace: {slug: ok, displayName:",
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_YAML("primary"),
  });
  try {
    const r = loadAndValidateOpsRepo(dir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some(
        (f) =>
          f.file === ".addroid/project.yaml" && /YAML パースエラー/.test(f.message)
      )
    );
  } finally {
    cleanup();
  }
});

test("loadAndValidateOpsRepo flags initial active campaign creation", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: launch-campaign
    name: Launch
    objective: OUTCOME_TRAFFIC
    initialState: active
    budget:
      dailyUsd: 100
`,
  });
  try {
    const r = loadAndValidateOpsRepo(dir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((f) => /initialState: "paused"/.test(f.message)),
      `expected initialState rejection, got: ${JSON.stringify(r.errors)}`
    );
  } finally {
    cleanup();
  }
});

test("loadAndValidateOpsRepo emits a warning when github_poll is disabled", () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: false
`,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_YAML("primary"),
  });
  try {
    const r = loadAndValidateOpsRepo(dir);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.warnings.some((f) => /github_poll/.test(f.message)));
  } finally {
    cleanup();
  }
});

test("loadAndValidateOpsRepo flags missing required files", () => {
  const { dir, cleanup } = writeFixture({});
  try {
    const r = loadAndValidateOpsRepo(dir);
    assert.equal(r.ok, false);
    const files = r.errors.map((e) => e.file);
    assert.ok(files.includes(".addroid/project.yaml"));
    assert.ok(files.includes("workflows/cron.yaml"));
    assert.ok(files.includes("ads/accounts"));
  } finally {
    cleanup();
  }
});

// ---- previous / base state comparison ------------------------------------

const BRAND_WITH_CAMPAIGN = (opts: {
  key: string;
  campaignId: string;
  initialState: "paused" | "active";
  dailyUsd: number;
}) => `version: 1
account:
  key: ${opts.key}
  displayName: "${opts.key} account"
campaigns:
  - id: ${opts.campaignId}
    name: ${opts.campaignId}
    objective: OUTCOME_TRAFFIC
    initialState: ${opts.initialState}
    budget:
      dailyUsd: ${opts.dailyUsd}
`;

test("loadAndValidateOpsRepo with previous: rejects unsafe budget increase against base", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      dailyUsd: 50,
    }),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      dailyUsd: 50 * BUDGET_INCREASE_RATIO_LIMIT + 1,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    assert.equal(previous.brands.size, 1);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some(
        (f) =>
          f.pointer === "campaigns[0].budget" &&
          /increase exceeds/.test(f.message)
      ),
      `expected budget-increase rejection, got ${JSON.stringify(r.errors)}`
    );
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

test("loadAndValidateOpsRepo with previous: accepts at-ratio-limit budget increase", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      dailyUsd: 50,
    }),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      dailyUsd: 50 * BUDGET_INCREASE_RATIO_LIMIT,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

const BRAND_WITH_LIFETIME = (opts: {
  key: string;
  campaignId: string;
  initialState: "paused" | "active";
  lifetimeUsd: number;
}) => `version: 1
account:
  key: ${opts.key}
  displayName: "${opts.key} account"
campaigns:
  - id: ${opts.campaignId}
    name: ${opts.campaignId}
    objective: OUTCOME_TRAFFIC
    initialState: ${opts.initialState}
    budget:
      lifetimeUsd: ${opts.lifetimeUsd}
`;

test("loadAndValidateOpsRepo with previous: rejects unsafe lifetimeUsd increase against base", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      lifetimeUsd: 500,
    }),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      lifetimeUsd: 500 * BUDGET_INCREASE_RATIO_LIMIT + 1,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    assert.equal(previous.brands.size, 1);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some(
        (f) =>
          f.pointer === "campaigns[0].budget" &&
          /lifetimeUsd increase exceeds/.test(f.message)
      ),
      `expected lifetimeUsd-increase rejection, got ${JSON.stringify(r.errors)}`
    );
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

test("loadAndValidateOpsRepo with previous: accepts at-ratio-limit lifetimeUsd increase", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      lifetimeUsd: 500,
    }),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_LIFETIME({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      lifetimeUsd: 500 * BUDGET_INCREASE_RATIO_LIMIT,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

test("loadAndValidateOpsRepo with previous: rejects dailyUsd dropped to 0 against base", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      dailyUsd: 50,
    }),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "fall-promo",
      initialState: "paused",
      dailyUsd: 0,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((f) => /cannot be reduced to 0/.test(f.message)),
      `expected drop-to-zero rejection, got ${JSON.stringify(r.errors)}`
    );
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

test("loadAndValidateOpsRepo with previous: allows existing campaign to remain initialState=active", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "running",
      initialState: "paused",
      dailyUsd: 50,
    }),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "running",
      initialState: "active",
      dailyUsd: 50,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

test("loadAndValidateOpsRepo with previous: still rejects newly added active campaign", () => {
  const baseFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": VALID_BRAND_YAML("primary"),
  });
  const targetFx = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT_YAML,
    "workflows/cron.yaml": VALID_CRON_YAML,
    "ads/accounts/primary/brand.yaml": BRAND_WITH_CAMPAIGN({
      key: "primary",
      campaignId: "new-launch",
      initialState: "active",
      dailyUsd: 100,
    }),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    const r = loadAndValidateOpsRepo(targetFx.dir, undefined, { previous });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((f) => /initialState: "paused"/.test(f.message)),
      `expected initialState rejection, got ${JSON.stringify(r.errors)}`
    );
  } finally {
    baseFx.cleanup();
    targetFx.cleanup();
  }
});

test("loadPreviousOpsRepoState ignores brands whose account.key does not match path", () => {
  const baseFx = writeFixture({
    "ads/accounts/primary/brand.yaml": VALID_BRAND_YAML("not-primary"),
  });
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    assert.equal(previous.brands.size, 0);
  } finally {
    baseFx.cleanup();
  }
});

test("loadPreviousOpsRepoState returns empty state when accounts dir is missing", () => {
  const baseFx = writeFixture({});
  try {
    const previous = loadPreviousOpsRepoState(baseFx.dir);
    assert.equal(previous.brands.size, 0);
  } finally {
    baseFx.cleanup();
  }
});

// ---- BudgetGuardPolicyYamlSchema (this implementation) -------------------

test("BudgetGuardPolicyYamlSchema accepts a fully populated policy", () => {
  const r = BudgetGuardPolicyYamlSchema.safeParse({
    version: 1,
    alerts: {
      dailyBudgetAlertRatio: 0.8,
      monthlyPaceRatio: 1.0,
      dayOverDayRatio: 1.5,
      noConversionsSpendMin: 5000,
    },
    autoPause: {
      enabled: true,
      minDailyBudgetRatio: 1.5,
      minDayOverDayRatio: 2.0,
      safeCategories: ["auto_pause"],
    },
    accounts: {
      primary: { dailyBudget: 5000, monthlyBudget: 150000, currency: "JPY" },
    },
  });
  assert.equal(r.success, true);
});

test("BudgetGuardPolicyYamlSchema applies defaults for omitted alerts/accounts", () => {
  const r = BudgetGuardPolicyYamlSchema.safeParse({ version: 1 });
  assert.equal(r.success, true);
  if (r.success) {
    assert.deepEqual(r.data.alerts, {});
    assert.deepEqual(r.data.accounts, {});
    assert.equal(r.data.autoPause, undefined);
  }
});

test("BudgetGuardPolicyYamlSchema rejects negative thresholds", () => {
  const r = BudgetGuardPolicyYamlSchema.safeParse({
    version: 1,
    alerts: { dailyBudgetAlertRatio: -0.1 },
  });
  assert.equal(r.success, false);
});

test("BudgetGuardPolicyYamlSchema rejects unknown top-level keys (strict)", () => {
  const r = BudgetGuardPolicyYamlSchema.safeParse({
    version: 1,
    alerts: {},
    extra: true,
  });
  assert.equal(r.success, false);
});

test("loadBudgetGuardPolicy returns null when workflows/budget-guard.yaml is missing", () => {
  const fx = writeFixture({});
  try {
    const out = loadBudgetGuardPolicy(fx.dir);
    assert.equal(out, null);
  } finally {
    fx.cleanup();
  }
});

test("loadBudgetGuardPolicy returns null when YAML is malformed", () => {
  const fx = writeFixture({
    "workflows/budget-guard.yaml": "version: not-a-number\nalerts: 12",
  });
  try {
    const out = loadBudgetGuardPolicy(fx.dir);
    assert.equal(out, null);
  } finally {
    fx.cleanup();
  }
});

test("loadBudgetGuardPolicy parses a valid policy file", () => {
  const fx = writeFixture({
    "workflows/budget-guard.yaml": `version: 1
alerts:
  dailyBudgetAlertRatio: 0.8
  dayOverDayRatio: 1.5
autoPause:
  enabled: true
  minDailyBudgetRatio: 1.5
  safeCategories:
    - auto_pause
accounts:
  primary:
    dailyBudget: 5000
    monthlyBudget: 150000
    currency: JPY
`,
  });
  try {
    const out = loadBudgetGuardPolicy(fx.dir);
    assert.notEqual(out, null);
    assert.equal(out!.alerts.dailyBudgetAlertRatio, 0.8);
    assert.equal(out!.alerts.dayOverDayRatio, 1.5);
    assert.equal(out!.autoPause?.enabled, true);
    assert.deepEqual(out!.autoPause?.safeCategories, ["auto_pause"]);
    assert.equal(out!.accounts["primary"]?.dailyBudget, 5000);
    assert.equal(out!.accounts["primary"]?.currency, "JPY");
  } finally {
    fx.cleanup();
  }
});

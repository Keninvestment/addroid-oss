import test from "node:test";
import assert from "node:assert/strict";
import {
  AdsetSchema,
  BrandYamlSchema,
  CreativeSchema,
  ExperimentSchema,
  TargetingSchema,
  buildExecutionPlan,
  type BrandYaml,
  type CreateAdAction,
  type CreateAdsetAction,
  type CreateCampaignAction,
  type CreateCreativeAction,
  type CreateExperimentAction,
  type DeleteAdsetAction,
  type DeleteCampaignAction,
  type PlanAction,
  type UpdateCampaignAction,
} from "../index.js";

// ---- schema acceptance ---------------------------------------------------

test("TargetingSchema rejects ageMin > ageMax", () => {
  const r = TargetingSchema.safeParse({ ageMin: 40, ageMax: 25 });
  assert.equal(r.success, false);
});

test("TargetingSchema rejects non-ISO country codes", () => {
  const r = TargetingSchema.safeParse({ countries: ["jpn"] });
  assert.equal(r.success, false);
});

test("AdsetSchema rejects duplicate ad ids", () => {
  const r = AdsetSchema.safeParse({
    id: "as1",
    name: "as1",
    targeting: { countries: ["JP"] },
    ads: [
      { id: "dup", name: "a", creativeRef: "c1" },
      { id: "dup", name: "b", creativeRef: "c1" },
    ],
  });
  assert.equal(r.success, false);
});

test("CreativeSchema rejects unknown mediaType", () => {
  const r = CreativeSchema.safeParse({
    id: "c1",
    name: "c",
    mediaType: "hologram",
  });
  assert.equal(r.success, false);
});

test("ExperimentSchema rejects single-variant experiments", () => {
  const r = ExperimentSchema.safeParse({
    id: "exp1",
    name: "Exp 1",
    campaignId: "c1",
    variants: [{ id: "v1", adsetIds: ["a1"], weight: 100 }],
  });
  assert.equal(r.success, false);
});

test("BrandYamlSchema accepts a hierarchical brand with adsets/ads/creatives/experiments", () => {
  const r = BrandYamlSchema.safeParse({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    guardrails: {
      maxDailyUsdPerCampaign: 200,
      allowedCountries: ["JP", "US"],
      bannedInterests: ["alcohol"],
    },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [
          {
            id: "fall-jp",
            name: "Fall JP",
            initialState: "paused",
            budget: { dailyUsd: 50 },
            targeting: {
              countries: ["JP"],
              ageMin: 25,
              ageMax: 45,
              interests: ["fashion"],
            },
            ads: [
              {
                id: "fall-jp-1",
                name: "ad 1",
                creativeRef: "fall-creative-a",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [
      {
        id: "fall-creative-a",
        name: "Fall A",
        mediaType: "image",
        headline: "Fall sale",
        primaryText: "Best deals",
        callToAction: "SHOP_NOW",
      },
    ],
    experiments: [
      {
        id: "fall-test",
        name: "Fall Test",
        campaignId: "fall",
        variants: [
          { id: "control", adsetIds: ["fall-jp"], weight: 50 },
          { id: "treatment", adsetIds: ["fall-jp"], weight: 50 },
        ],
      },
    ],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

// ---- buildExecutionPlan: success path -----------------------------------

function brandFor(input: unknown): BrandYaml {
  return BrandYamlSchema.parse(input);
}

test("buildExecutionPlan with no previous emits create_* actions for the full hierarchy", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [
          {
            id: "fall-jp",
            name: "Fall JP",
            initialState: "paused",
            budget: { dailyUsd: 50 },
            targeting: { countries: ["JP"] },
            ads: [
              {
                id: "fall-jp-1",
                name: "ad 1",
                creativeRef: "creative-a",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [
      { id: "creative-a", name: "A", mediaType: "image", headline: "h" },
    ],
    experiments: [
      {
        id: "exp1",
        name: "Exp 1",
        campaignId: "fall",
        variants: [
          { id: "v1", adsetIds: ["fall-jp"], weight: 50 },
          { id: "v2", adsetIds: ["fall-jp"], weight: 50 },
        ],
      },
    ],
  });

  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    [
      "create_creative",
      "create_campaign",
      "create_adset",
      "create_ad",
      "create_experiment",
    ]
  );
  assert.equal(plan.findings.length, 0, JSON.stringify(plan.findings));
  const camp = plan.actions.find(
    (a): a is CreateCampaignAction => a.kind === "create_campaign"
  )!;
  assert.equal(camp.account, "primary");
  assert.equal(camp.campaignId, "fall");
  assert.equal(camp.budget.dailyUsd, 100);
  const adset = plan.actions.find(
    (a): a is CreateAdsetAction => a.kind === "create_adset"
  )!;
  assert.deepEqual(adset.targeting.countries, ["JP"]);
  const ad = plan.actions.find((a): a is CreateAdAction => a.kind === "create_ad")!;
  assert.equal(ad.creativeRef, "creative-a");
  const creative = plan.actions.find(
    (a): a is CreateCreativeAction => a.kind === "create_creative"
  )!;
  assert.equal(creative.mediaType, "image");
  const exp = plan.actions.find(
    (a): a is CreateExperimentAction => a.kind === "create_experiment"
  )!;
  assert.equal(exp.campaignId, "fall");
  assert.equal(exp.variants.length, 2);
});

test("buildExecutionPlan emits update_campaign when campaign budget changes against previous", () => {
  const previous = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 50 },
      },
    ],
  });
  const next = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall (renamed)",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 80 },
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next, previous });
  const update = plan.actions.find(
    (a): a is UpdateCampaignAction => a.kind === "update_campaign"
  );
  assert.ok(update);
  assert.deepEqual(Object.keys(update!.changes).sort(), ["budget", "name"]);
  assert.equal(plan.findings.length, 0);
});

test("buildExecutionPlan emits delete_* in dependency-reverse order for a full removal (experiment -> ad -> adset -> campaign -> creative)", () => {
  const previous = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 50 },
        adsets: [
          {
            id: "fall-jp",
            name: "JP",
            initialState: "paused",
            targeting: { countries: ["JP"] },
            ads: [
              {
                id: "ad1",
                name: "ad 1",
                creativeRef: "c1",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [
      { id: "c1", name: "C1", mediaType: "image" },
    ],
    experiments: [
      {
        id: "exp1",
        name: "Exp 1",
        campaignId: "fall",
        variants: [
          { id: "v1", adsetIds: ["fall-jp"], weight: 50 },
          { id: "v2", adsetIds: ["fall-jp"], weight: 50 },
        ],
      },
    ],
  });
  const next = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [],
    creatives: [],
    experiments: [],
  });
  const plan = buildExecutionPlan({ account: "primary", next, previous });
  const kinds = plan.actions.map((a) => a.kind);
  // 依存逆順: experiment は campaign/adset/ad を参照するため最初、
  // creative は ad に参照される側なので最後。
  assert.deepEqual(kinds, [
    "delete_experiment",
    "delete_ad",
    "delete_adset",
    "delete_campaign",
    "delete_creative",
  ]);
});

test("buildExecutionPlan emits delete_* in dependency-reverse order when campaign disappears", () => {
  const previous = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 50 },
        adsets: [
          {
            id: "fall-jp",
            name: "JP",
            initialState: "paused",
            targeting: { countries: ["JP"] },
            ads: [
              {
                id: "ad1",
                name: "ad 1",
                creativeRef: "c1",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
  });
  const next = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [],
  });
  const plan = buildExecutionPlan({ account: "primary", next, previous });
  const kinds = plan.actions.map((a) => a.kind);
  // Order: delete_ad → delete_adset → delete_campaign
  assert.deepEqual(kinds, ["delete_ad", "delete_adset", "delete_campaign"]);
  const delAdset = plan.actions.find(
    (a): a is DeleteAdsetAction => a.kind === "delete_adset"
  )!;
  assert.equal(delAdset.adsetId, "fall-jp");
  const delCamp = plan.actions.find(
    (a): a is DeleteCampaignAction => a.kind === "delete_campaign"
  )!;
  assert.equal(delCamp.campaignId, "fall");
});

// ---- buildExecutionPlan: guardrails / structural failures ----------------

test("buildExecutionPlan reports an error when guardrails.maxDailyUsdPerCampaign is exceeded", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    guardrails: { maxDailyUsdPerCampaign: 50 },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find((f) => f.level === "error");
  assert.ok(err);
  assert.match(err!.message, /maxDailyUsdPerCampaign/);
});

test("buildExecutionPlan reports an error when targeting.countries violates allowedCountries", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    guardrails: { allowedCountries: ["JP"] },
    campaigns: [
      {
        id: "c1",
        name: "c1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
        adsets: [
          {
            id: "as1",
            name: "as1",
            initialState: "paused",
            targeting: { countries: ["US"] },
            ads: [],
          },
        ],
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find((f) => f.level === "error");
  assert.ok(err);
  assert.match(err!.message, /allowedCountries/);
});

test("buildExecutionPlan reports an error when targeting.interests includes a banned interest (case-insensitive)", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    guardrails: { bannedInterests: ["Alcohol"] },
    campaigns: [
      {
        id: "c1",
        name: "c1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
        adsets: [
          {
            id: "as1",
            name: "as1",
            initialState: "paused",
            targeting: { interests: ["alcohol"] },
            ads: [],
          },
        ],
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find((f) => f.level === "error");
  assert.ok(err);
  assert.match(err!.message, /bannedInterests/);
});

test("buildExecutionPlan emits a warning when adset dailyUsd sum exceeds campaign dailyUsd", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 60 },
        adsets: [
          {
            id: "as1",
            name: "as1",
            initialState: "paused",
            budget: { dailyUsd: 40 },
            targeting: { countries: ["JP"] },
            ads: [],
          },
          {
            id: "as2",
            name: "as2",
            initialState: "paused",
            budget: { dailyUsd: 40 },
            targeting: { countries: ["JP"] },
            ads: [],
          },
        ],
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const warn = plan.findings.find((f) => f.level === "warning");
  assert.ok(warn);
  assert.match(warn!.message, /dailyUsd 合計/);
});

test("buildExecutionPlan flags experiments referencing a non-existent campaign", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [],
    experiments: [
      {
        id: "exp1",
        name: "Exp 1",
        campaignId: "ghost",
        variants: [
          { id: "v1", adsetIds: ["a1"], weight: 50 },
          { id: "v2", adsetIds: ["a1"], weight: 50 },
        ],
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find((f) => /campaigns\[\].id/.test(f.message));
  assert.ok(err);
  assert.equal(err!.level, "error");
});

test("buildExecutionPlan flags experiments whose variant weights do not sum to 100", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "c1",
        name: "c1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
        adsets: [
          {
            id: "as1",
            name: "as1",
            initialState: "paused",
            targeting: { countries: ["JP"] },
            ads: [],
          },
        ],
      },
    ],
    experiments: [
      {
        id: "exp1",
        name: "Exp 1",
        campaignId: "c1",
        variants: [
          { id: "v1", adsetIds: ["as1"], weight: 30 },
          { id: "v2", adsetIds: ["as1"], weight: 30 },
        ],
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find((f) => /weight 合計は 100/.test(f.message));
  assert.ok(err);
  assert.equal(err!.level, "error");
});

test("buildExecutionPlan flags experiment variants referencing adsets outside the parent campaign", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "c1",
        name: "c1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
        adsets: [
          {
            id: "as1",
            name: "as1",
            initialState: "paused",
            targeting: { countries: ["JP"] },
            ads: [],
          },
        ],
      },
      {
        id: "c2",
        name: "c2",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
        adsets: [
          {
            id: "as2",
            name: "as2",
            initialState: "paused",
            targeting: { countries: ["JP"] },
            ads: [],
          },
        ],
      },
    ],
    experiments: [
      {
        id: "exp1",
        name: "Exp 1",
        campaignId: "c1",
        variants: [
          { id: "v1", adsetIds: ["as1"], weight: 50 },
          { id: "v2", adsetIds: ["as2"], weight: 50 },
        ],
      },
    ],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find(
    (f) => f.level === "error" && /属さない adset/.test(f.message)
  );
  assert.ok(err);
});

test("buildExecutionPlan flags ad.creativeRef pointing to a non-existent creative", () => {
  const brand = brandFor({
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "c1",
        name: "c1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 10 },
        adsets: [
          {
            id: "as1",
            name: "as1",
            initialState: "paused",
            targeting: { countries: ["JP"] },
            ads: [
              {
                id: "ad1",
                name: "ad 1",
                creativeRef: "ghost",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [],
  });
  const plan = buildExecutionPlan({ account: "primary", next: brand, previous: null });
  const err = plan.findings.find(
    (f) => f.level === "error" && /creatives\[\]\.id に存在/.test(f.message)
  );
  assert.ok(err);
});

test("buildExecutionPlan returns no actions when previous and next are identical", () => {
  const yaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused" as const,
        budget: { dailyUsd: 50 },
      },
    ],
  };
  const previous = brandFor(yaml);
  const next = brandFor(yaml);
  const plan = buildExecutionPlan({ account: "primary", next, previous });
  const noopActions: PlanAction[] = [];
  assert.deepEqual(plan.actions, noopActions);
  assert.deepEqual(plan.findings, []);
});

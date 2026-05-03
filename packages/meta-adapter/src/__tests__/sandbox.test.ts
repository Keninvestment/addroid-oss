// AdDroid OSS — MockMetaSandbox harness tests.
//
// the current implementation の sandbox / mock 受入要件:
//   "A sandbox or mock Meta test harness can run without real production ad mutation."
//
// 本テスト一式は、MockMetaSandbox が
//   campaign → adset → ad → creative → activate → insights
// の主要フローを参照整合性付きで検証できることを実証する。Meta API には到達せず、
// 個人 path / personal account / 実 token を一切踏まない。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MockMetaSandbox,
  SandboxValidationError,
  deriveExternalId,
} from "../index.js";

function expectSandboxError(fn: () => unknown): SandboxValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SandboxValidationError) return err;
    throw err;
  }
  throw new Error("expected SandboxValidationError but call did not throw");
}

const ACCOUNT = "ads/accounts/test-fixture";
const FROZEN_NOW = new Date("2026-01-15T00:00:00.000Z");

function newSandbox(): MockMetaSandbox {
  return new MockMetaSandbox({
    clock: () => new Date(FROZEN_NOW.getTime()),
    insightsSeed: "addroid-test",
  });
}

test("MockMetaSandbox runs the full create→activate→insights flow", () => {
  const sb = newSandbox();

  // 1) creative を先に作る (ad が参照する)
  const creative = sb.applyAction({
    kind: "create_creative",
    account: ACCOUNT,
    creativeId: "cr-001",
    name: "Spring promo creative",
    mediaType: "image_static",
    headline: "Welcome",
    primaryText: "Try the new release",
    callToAction: "LEARN_MORE",
  });
  assert.equal(creative.status, "success");
  assert.equal(creative.resource, "creatives");
  assert.equal(creative.verb, "create");
  assert.equal(
    creative.externalId,
    deriveExternalId({ resource: "creatives", account: ACCOUNT, id: "cr-001" })
  );

  // 2) campaign を作る
  const campaign = sb.applyAction({
    kind: "create_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "Spring promo",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 50 },
  });
  assert.equal(campaign.status, "success");
  const campaignRow = sb.getCampaign(campaign.externalId);
  assert.ok(campaignRow);
  assert.equal(campaignRow!.status, "PAUSED");
  assert.equal(campaignRow!.budget.dailyUsd, 50);

  // 3) adset を campaign の下に作る
  const adset = sb.applyAction({
    kind: "create_adset",
    account: ACCOUNT,
    campaignId: "cmp-001",
    adsetId: "as-001",
    name: "JP 25-34",
    initialState: "paused",
    budget: { dailyUsd: 25 },
    targeting: {
      countries: ["JP"],
      ageMin: 25,
      ageMax: 34,
      interests: ["technology"],
      customAudiences: [],
    },
  });
  assert.equal(adset.status, "success");
  const adsetRow = sb.getAdSet(adset.externalId);
  assert.ok(adsetRow);
  assert.equal(adsetRow!.campaignId, "cmp-001");
  assert.equal(adsetRow!.campaignExternalId, campaign.externalId);

  // 4) ad を adset の下に作る (creativeRef は creativeId で参照)
  const ad = sb.applyAction({
    kind: "create_ad",
    account: ACCOUNT,
    campaignId: "cmp-001",
    adsetId: "as-001",
    adId: "ad-001",
    name: "Spring promo ad #1",
    creativeRef: "cr-001",
    initialState: "paused",
  });
  assert.equal(ad.status, "success");
  const adRow = sb.getAd(ad.externalId);
  assert.ok(adRow);
  assert.equal(adRow!.creativeRef, "cr-001");
  assert.equal(adRow!.creativeExternalId, creative.externalId);
  assert.equal(adRow!.status, "PAUSED");

  // 5) activate (PAUSED → ACTIVE)
  const acted = sb.activate({ resource: "ads", externalId: ad.externalId });
  assert.equal(acted.previousStatus, "PAUSED");
  assert.equal(acted.status, "ACTIVE");
  assert.equal(sb.getAd(ad.externalId)?.status, "ACTIVE");

  // 6) insights は決定論的 (同じ入力 → 同じ出力)
  const insights1 = sb.getInsights({
    resource: "ads",
    externalId: ad.externalId,
    dateStart: "2026-01-01",
    dateEnd: "2026-01-07",
  });
  const insights2 = sb.getInsights({
    resource: "ads",
    externalId: ad.externalId,
    dateStart: "2026-01-01",
    dateEnd: "2026-01-07",
  });
  assert.deepEqual(insights1, insights2);
  assert.ok(insights1);
  assert.ok(insights1!.impressions > 0);
  assert.ok(insights1!.clicks <= insights1!.impressions);
  assert.ok(insights1!.spendUsd > 0);
  assert.equal(insights1!.resource, "ads");
  assert.equal(insights1!.externalId, ad.externalId);

  // list APIs reflect everything we created
  assert.equal(sb.listCampaigns(ACCOUNT).length, 1);
  assert.equal(sb.listAdSets(ACCOUNT).length, 1);
  assert.equal(sb.listAds(ACCOUNT).length, 1);
  assert.equal(sb.listCreatives(ACCOUNT).length, 1);
});

test("MockMetaSandbox rejects adset whose parent campaign is missing", () => {
  const sb = newSandbox();
  const err = expectSandboxError(() =>
    sb.applyAction({
      kind: "create_adset",
      account: ACCOUNT,
      campaignId: "cmp-missing",
      adsetId: "as-001",
      name: "Orphan",
      initialState: "paused",
      targeting: {
        countries: ["JP"],
        interests: [],
        customAudiences: [],
      },
    })
  );
  assert.equal(err.code, "parent_campaign_not_found");
  assert.equal(sb.listAdSets(ACCOUNT).length, 0);
});

test("MockMetaSandbox rejects ad whose creative ref is unknown", () => {
  const sb = newSandbox();
  sb.applyAction({
    kind: "create_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "C",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  sb.applyAction({
    kind: "create_adset",
    account: ACCOUNT,
    campaignId: "cmp-001",
    adsetId: "as-001",
    name: "A",
    initialState: "paused",
    targeting: { countries: ["JP"], interests: [], customAudiences: [] },
  });
  const err = expectSandboxError(() =>
    sb.applyAction({
      kind: "create_ad",
      account: ACCOUNT,
      campaignId: "cmp-001",
      adsetId: "as-001",
      adId: "ad-001",
      name: "Ad",
      creativeRef: "cr-missing",
      initialState: "paused",
    })
  );
  assert.equal(err.code, "creative_ref_not_found");
  assert.equal(sb.listAds(ACCOUNT).length, 0);
});

test("MockMetaSandbox rejects duplicate create on the same id", () => {
  const sb = newSandbox();
  const action = {
    kind: "create_campaign" as const,
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "C",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused" as const,
    budget: { dailyUsd: 10 },
  };
  sb.applyAction(action);
  const err = expectSandboxError(() => sb.applyAction(action));
  assert.equal(err.code, "duplicate_create");
});

test("MockMetaSandbox.activate is idempotent on ACTIVE and rejects unknown ids", () => {
  const sb = newSandbox();
  sb.applyAction({
    kind: "create_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "C",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  const externalId = deriveExternalId({
    resource: "campaigns",
    account: ACCOUNT,
    id: "cmp-001",
  });
  const first = sb.activate({ resource: "campaigns", externalId });
  assert.equal(first.previousStatus, "PAUSED");
  assert.equal(first.status, "ACTIVE");
  const second = sb.activate({ resource: "campaigns", externalId });
  assert.equal(second.previousStatus, "ACTIVE");
  assert.equal(second.status, "ACTIVE");

  const unknown = expectSandboxError(() =>
    sb.activate({ resource: "campaigns", externalId: "nope" })
  );
  assert.equal(unknown.code, "target_not_found");
});

test("MockMetaSandbox update applies FieldChange.to into the live row", () => {
  const sb = newSandbox();
  sb.applyAction({
    kind: "create_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "Initial",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  const result = sb.applyAction({
    kind: "update_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    changes: {
      name: { from: "Initial", to: "Updated" },
      "budget.dailyUsd": { from: 10, to: 25 },
    },
  });
  assert.equal(result.status, "success");
  const row = sb.getCampaign(result.externalId);
  assert.ok(row);
  assert.equal(row!.name, "Updated");
  assert.equal(row!.budget.dailyUsd, 25);
});

test("MockMetaSandbox.delete is blocked while children still reference the row", () => {
  const sb = newSandbox();
  sb.applyAction({
    kind: "create_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "C",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  sb.applyAction({
    kind: "create_adset",
    account: ACCOUNT,
    campaignId: "cmp-001",
    adsetId: "as-001",
    name: "A",
    initialState: "paused",
    targeting: { countries: ["JP"], interests: [], customAudiences: [] },
  });
  const blocked = expectSandboxError(() =>
    sb.applyAction({
      kind: "delete_campaign",
      account: ACCOUNT,
      campaignId: "cmp-001",
    })
  );
  assert.equal(blocked.code, "delete_blocked_by_dependents");

  // 子を消してから親を消すと OK
  sb.applyAction({
    kind: "delete_adset",
    account: ACCOUNT,
    campaignId: "cmp-001",
    adsetId: "as-001",
  });
  const ok = sb.applyAction({
    kind: "delete_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
  });
  assert.equal(ok.status, "success");
  assert.equal(sb.getCampaign(ok.externalId)?.status, "DELETED");
});

test("MockMetaSandbox.getInsights returns null for unknown ids and skips for non-insights resources", () => {
  const sb = newSandbox();
  sb.applyAction({
    kind: "create_creative",
    account: ACCOUNT,
    creativeId: "cr-001",
    name: "C",
    mediaType: "image_static",
  });
  const creativeExternalId = deriveExternalId({
    resource: "creatives",
    account: ACCOUNT,
    id: "cr-001",
  });

  // creatives は insights 非対象 (Meta API も同様)
  assert.equal(
    sb.getInsights({
      resource: "creatives" as unknown as "ads",
      externalId: creativeExternalId,
      dateStart: "2026-01-01",
      dateEnd: "2026-01-07",
    }),
    null
  );

  // 存在しない id は null
  assert.equal(
    sb.getInsights({
      resource: "campaigns",
      externalId: "no-such-thing",
      dateStart: "2026-01-01",
      dateEnd: "2026-01-07",
    }),
    null
  );
});

test("MockMetaSandbox.reset clears all state across accounts", () => {
  const sb = newSandbox();
  sb.applyAction({
    kind: "create_campaign",
    account: ACCOUNT,
    campaignId: "cmp-001",
    name: "C",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  sb.applyAction({
    kind: "create_campaign",
    account: "ads/accounts/other",
    campaignId: "cmp-002",
    name: "C2",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  assert.equal(sb.listCampaigns().length, 2);
  sb.reset();
  assert.equal(sb.listCampaigns().length, 0);
});

test("MockMetaSandbox.applyAction skips experiment kinds (verified ops matrix)", () => {
  const sb = newSandbox();
  const result = sb.applyAction({
    kind: "create_experiment",
    account: ACCOUNT,
    experimentId: "exp-001",
    campaignId: "cmp-001",
    name: "E",
    variants: [],
  });
  assert.equal(result.status, "skipped");
  assert.match(result.message, /experiment/);
});

test("MockMetaSandbox account scoping: identical ids in different accounts do not collide", () => {
  const sb = newSandbox();
  const a = sb.applyAction({
    kind: "create_campaign",
    account: "ads/accounts/team-a",
    campaignId: "cmp-001",
    name: "Team A",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  const b = sb.applyAction({
    kind: "create_campaign",
    account: "ads/accounts/team-b",
    campaignId: "cmp-001",
    name: "Team B",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyUsd: 10 },
  });
  assert.notEqual(a.externalId, b.externalId);
  assert.equal(sb.getCampaign(a.externalId)?.name, "Team A");
  assert.equal(sb.getCampaign(b.externalId)?.name, "Team B");
});

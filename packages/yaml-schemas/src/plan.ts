// AdDroid OSS — Ads YAML を Meta 実行 plan へ変換する純粋関数群。
//
// the current implementation 受入基準:
//   - Ads YAML を campaign / adset / ad / creative の dry-run plan に変換できること。
//   - budget / targeting / guardrails / experiments のチェックを含むこと。
//
// 本モジュールは Prisma / fs / network を使わず、`BrandYaml` (前回 / 今回)
// を入力に取り、create_* / update_* / delete_* の plan action 配列と
// plan-level の findings (error / warning) を返す。CLI / Web UI / worker
// いずれもこの関数の結果を Meta 実行ステージに渡す前段として使う。

import type {
  Ad,
  Adset,
  BrandYaml,
  Budget,
  Campaign,
  Creative,
  Experiment,
  Guardrails,
  Targeting,
} from "./index.js";

// ---- action types --------------------------------------------------------

export type PlanActionKind =
  | "create_campaign"
  | "update_campaign"
  | "delete_campaign"
  | "create_adset"
  | "update_adset"
  | "delete_adset"
  | "create_ad"
  | "update_ad"
  | "delete_ad"
  | "create_creative"
  | "update_creative"
  | "delete_creative"
  | "create_experiment"
  | "update_experiment"
  | "delete_experiment";

interface ActionBase {
  account: string;
}

export interface CreateCampaignAction extends ActionBase {
  kind: "create_campaign";
  campaignId: string;
  name: string;
  objective: string;
  initialState: "paused" | "active";
  budget: { dailyBudget?: number; lifetimeBudget?: number };
  adsetBudgetSharing?: boolean;
}

export interface UpdateCampaignAction extends ActionBase {
  kind: "update_campaign";
  campaignId: string;
  changes: Record<string, FieldChange>;
}

export interface DeleteCampaignAction extends ActionBase {
  kind: "delete_campaign";
  campaignId: string;
}

export interface CreateAdsetAction extends ActionBase {
  kind: "create_adset";
  campaignId: string;
  adsetId: string;
  name: string;
  initialState: "paused" | "active";
  budget?: { dailyBudget?: number; lifetimeBudget?: number };
  optimizationGoal?: string;
  billingEvent?: string;
  bidAmount?: number;
  startTime?: string;
  endTime?: string;
  pixelId?: string;
  customEventType?: string;
  targeting: NormalizedTargeting;
}

export interface UpdateAdsetAction extends ActionBase {
  kind: "update_adset";
  campaignId: string;
  adsetId: string;
  changes: Record<string, FieldChange>;
}

export interface DeleteAdsetAction extends ActionBase {
  kind: "delete_adset";
  campaignId: string;
  adsetId: string;
}

export interface CreateAdAction extends ActionBase {
  kind: "create_ad";
  campaignId: string;
  adsetId: string;
  adId: string;
  name: string;
  creativeRef: string;
  initialState: "paused" | "active";
  pixelId?: string;
  trackingSpecs?: Record<string, unknown>;
}

export interface UpdateAdAction extends ActionBase {
  kind: "update_ad";
  campaignId: string;
  adsetId: string;
  adId: string;
  changes: Record<string, FieldChange>;
}

export interface DeleteAdAction extends ActionBase {
  kind: "delete_ad";
  campaignId: string;
  adsetId: string;
  adId: string;
}

export interface CreateCreativeAction extends ActionBase {
  kind: "create_creative";
  creativeId: string;
  name: string;
  mediaType: string;
  headline?: string;
  primaryText?: string;
  callToAction?: string;
  pageId?: string;
  title?: string;
  body?: string;
  linkUrl?: string;
  description?: string;
  instagramUserId?: string;
  images?: string[];
  videos?: string[];
  titles?: string[];
  bodies?: string[];
  descriptions?: string[];
  callToActions?: string[];
  storageKey?: string;
}

export interface UpdateCreativeAction extends ActionBase {
  kind: "update_creative";
  creativeId: string;
  changes: Record<string, FieldChange>;
}

export interface DeleteCreativeAction extends ActionBase {
  kind: "delete_creative";
  creativeId: string;
}

export interface CreateExperimentAction extends ActionBase {
  kind: "create_experiment";
  experimentId: string;
  campaignId: string;
  name: string;
  variants: Array<{ id: string; adsetIds: string[]; weight: number }>;
}

export interface UpdateExperimentAction extends ActionBase {
  kind: "update_experiment";
  experimentId: string;
  campaignId: string;
  changes: Record<string, FieldChange>;
}

export interface DeleteExperimentAction extends ActionBase {
  kind: "delete_experiment";
  experimentId: string;
}

export type PlanAction =
  | CreateCampaignAction
  | UpdateCampaignAction
  | DeleteCampaignAction
  | CreateAdsetAction
  | UpdateAdsetAction
  | DeleteAdsetAction
  | CreateAdAction
  | UpdateAdAction
  | DeleteAdAction
  | CreateCreativeAction
  | UpdateCreativeAction
  | DeleteCreativeAction
  | CreateExperimentAction
  | UpdateExperimentAction
  | DeleteExperimentAction;

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface NormalizedTargeting {
  countries: string[];
  ageMin?: number;
  ageMax?: number;
  interests: string[];
  customAudiences: string[];
}

export interface PlanFinding {
  level: "error" | "warning";
  pointer?: string;
  message: string;
}

export interface ExecutionPlan {
  account: string;
  actions: PlanAction[];
  findings: PlanFinding[];
}

// ---- public entry point --------------------------------------------------

export interface BuildExecutionPlanInput {
  /** ads/accounts/<key> パスから取得した安定キー。plan.action.account に焼き付ける。 */
  account: string;
  /** 今回の brand.yaml (検証済み)。 */
  next: BrandYaml;
  /** 直前 (= base ブランチ) の brand.yaml。なければ「全件新規」と扱う。 */
  previous: BrandYaml | null;
}

/**
 * BrandYaml を Meta 実行 plan に変換する。
 *
 * 出力順序は実 apply で必要な依存順を満たす:
 *   creates : creative -> campaign -> adset -> ad -> experiment (親が先)
 *   updates : creative -> campaign -> adset -> ad -> experiment (親が先)
 *   deletes : experiment -> ad -> adset -> campaign -> creative (依存元が先)
 *
 * 削除では experiment が campaign/adset/ad を、ad が adset/creative を参照するため、
 * 依存元 (experiment, ad) を先に消してから親 (campaign, adset, creative) を消す。
 * 特に creative は ad より後に消さないと、ad がまだ参照中の creative を消す形になる。
 *
 * findings は plan-level の問題 (guardrail 違反、未解決 ref、ad <-> adset の親不在 等) を
 * level=error/warning で返す。`error` は CLI からは validate-failure と同じ exit 1 として扱う。
 */
export function buildExecutionPlan(input: BuildExecutionPlanInput): ExecutionPlan {
  const { account, next, previous } = input;
  const findings: PlanFinding[] = [];
  const creates: PlanAction[] = [];
  const updates: PlanAction[] = [];
  // 削除は依存逆順で出力する必要があるため、kind 別バケットに振り分け、
  // 最後に experiment → ad → adset → campaign → creative の順で連結する。
  // experiment は campaign/adset/ad を参照し、ad は adset/creative を参照するため、
  // 親 (campaign/adset/creative) より先に依存元 (experiment/ad) を消さなければ
  // Meta 側で参照整合エラーが出る。
  const deleteBuckets: DeleteBuckets = {
    experiments: [],
    ads: [],
    adsets: [],
    campaigns: [],
    creatives: [],
  };

  // Index lookup tables for the next state.
  const nextCampaignsById = byId(next.campaigns, "id");
  const nextCreativesById = byId(next.creatives, "id");
  const nextExperimentsById = byId(next.experiments, "id");

  const prevCampaigns = previous?.campaigns ?? [];
  const prevCreatives = previous?.creatives ?? [];
  const prevExperiments = previous?.experiments ?? [];
  const prevCampaignsById = byId(prevCampaigns, "id");
  const prevCreativesById = byId(prevCreatives, "id");
  const prevExperimentsById = byId(prevExperiments, "id");

  // -- creatives ----------------------------------------------------------
  for (const c of next.creatives) {
    const prev = prevCreativesById.get(c.id) ?? null;
    if (prev === null) {
      creates.push(toCreateCreative(account, c));
    } else {
      const changes = diffCreative(prev, c);
      if (Object.keys(changes).length > 0) {
        updates.push({
          kind: "update_creative",
          account,
          creativeId: c.id,
          changes,
        });
      }
    }
  }
  for (const prev of prevCreatives) {
    if (!nextCreativesById.has(prev.id)) {
      deleteBuckets.creatives.push({
        kind: "delete_creative",
        account,
        creativeId: prev.id,
      });
    }
  }

  // -- campaigns / adsets / ads ------------------------------------------
  for (const camp of next.campaigns) {
    const prev = prevCampaignsById.get(camp.id) ?? null;
    if (prev === null && camp.importedExisting === true) {
      // Existing Meta objects that were adopted into brand.yaml are treated as
      // already present. This lets a PR add a new ad under a live campaign/adset
      // without emitting duplicate create_campaign/create_adset actions.
    } else if (prev === null) {
      creates.push(toCreateCampaign(account, camp));
    } else {
      const changes = diffCampaign(prev, camp);
      if (Object.keys(changes).length > 0) {
        updates.push({
          kind: "update_campaign",
          account,
          campaignId: camp.id,
          changes,
        });
      }
    }
    diffAdsets({
      account,
      campaignId: camp.id,
      nextAdsets: camp.adsets,
      previousAdsets:
        prev?.adsets ??
        (camp.importedExisting === true
          ? camp.adsets
              .filter((adset) => adset.importedExisting === true)
              .map((adset) => ({ ...adset, ads: [] }))
          : []),
      creates,
      updates,
      deleteBuckets,
      findings,
      knownCreativeIds: new Set(nextCreativesById.keys()),
    });
  }
  for (const prev of prevCampaigns) {
    if (!nextCampaignsById.has(prev.id)) {
      // Campaign 自体の削除 — ads/adsets はバケットに振り分けて、最終連結で
      // ad → adset → campaign の依存逆順を担保する。
      for (const adset of prev.adsets) {
        for (const ad of adset.ads) {
          deleteBuckets.ads.push({
            kind: "delete_ad",
            account,
            campaignId: prev.id,
            adsetId: adset.id,
            adId: ad.id,
          });
        }
        deleteBuckets.adsets.push({
          kind: "delete_adset",
          account,
          campaignId: prev.id,
          adsetId: adset.id,
        });
      }
      deleteBuckets.campaigns.push({
        kind: "delete_campaign",
        account,
        campaignId: prev.id,
      });
    }
  }

  // -- experiments --------------------------------------------------------
  for (const exp of next.experiments) {
    const prev = prevExperimentsById.get(exp.id) ?? null;
    if (prev === null) {
      creates.push({
        kind: "create_experiment",
        account,
        experimentId: exp.id,
        campaignId: exp.campaignId,
        name: exp.name,
        variants: exp.variants.map((v) => ({
          id: v.id,
          adsetIds: [...v.adsetIds],
          weight: v.weight,
        })),
      });
    } else {
      const changes = diffExperiment(prev, exp);
      if (Object.keys(changes).length > 0) {
        updates.push({
          kind: "update_experiment",
          account,
          experimentId: exp.id,
          campaignId: exp.campaignId,
          changes,
        });
      }
    }
  }
  for (const prev of prevExperiments) {
    if (!nextExperimentsById.has(prev.id)) {
      deleteBuckets.experiments.push({
        kind: "delete_experiment",
        account,
        experimentId: prev.id,
      });
    }
  }

  // -- guardrails / structural findings -----------------------------------
  collectStructuralFindings(next, findings);
  collectGuardrailFindings(next, findings);

  const deletes: PlanAction[] = [
    ...deleteBuckets.experiments,
    ...deleteBuckets.ads,
    ...deleteBuckets.adsets,
    ...deleteBuckets.campaigns,
    ...deleteBuckets.creatives,
  ];
  const actions = [...creates, ...updates, ...deletes];
  return { account, actions, findings };
}

// ---- helpers -------------------------------------------------------------

function byId<T extends { id: string }>(
  arr: readonly T[],
  _key: "id"
): Map<string, T> {
  const m = new Map<string, T>();
  for (const v of arr) m.set(v.id, v);
  return m;
}

function toCreateCampaign(account: string, c: Campaign): CreateCampaignAction {
  return {
    kind: "create_campaign",
    account,
    campaignId: c.id,
    name: c.name,
    objective: c.objective,
    initialState: c.initialState,
    budget: budgetToPlain(c.budget),
    ...(c.adsetBudgetSharing !== undefined ? { adsetBudgetSharing: c.adsetBudgetSharing } : {}),
  };
}

function toCreateCreative(account: string, c: Creative): CreateCreativeAction {
  const out: CreateCreativeAction = {
    kind: "create_creative",
    account,
    creativeId: c.id,
    name: c.name,
    mediaType: c.mediaType,
  };
  if (c.headline !== undefined) out.headline = c.headline;
  if (c.primaryText !== undefined) out.primaryText = c.primaryText;
  if (c.callToAction !== undefined) out.callToAction = c.callToAction;
  if (c.pageId !== undefined) out.pageId = c.pageId;
  if (c.title !== undefined) out.title = c.title;
  if (c.body !== undefined) out.body = c.body;
  if (c.linkUrl !== undefined) out.linkUrl = c.linkUrl;
  if (c.description !== undefined) out.description = c.description;
  if (c.instagramUserId !== undefined) out.instagramUserId = c.instagramUserId;
  if (c.images !== undefined) out.images = [...c.images];
  if (c.videos !== undefined) out.videos = [...c.videos];
  if (c.titles !== undefined) out.titles = [...c.titles];
  if (c.bodies !== undefined) out.bodies = [...c.bodies];
  if (c.descriptions !== undefined) out.descriptions = [...c.descriptions];
  if (c.callToActions !== undefined) out.callToActions = [...c.callToActions];
  if (c.storageKey !== undefined) out.storageKey = c.storageKey;
  return out;
}

function budgetToPlain(b: Budget): { dailyBudget?: number; lifetimeBudget?: number } {
  const out: { dailyBudget?: number; lifetimeBudget?: number } = {};
  if (b.dailyBudget !== undefined) out.dailyBudget = b.dailyBudget;
  if (b.lifetimeBudget !== undefined) out.lifetimeBudget = b.lifetimeBudget;
  return out;
}

function targetingToPlain(t: Targeting): NormalizedTargeting {
  const out: NormalizedTargeting = {
    countries: [...t.countries],
    interests: [...t.interests],
    customAudiences: [...t.customAudiences],
  };
  if (t.ageMin !== undefined) out.ageMin = t.ageMin;
  if (t.ageMax !== undefined) out.ageMax = t.ageMax;
  return out;
}

function diffCampaign(prev: Campaign, next: Campaign): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  if (prev.name !== next.name) changes.name = { from: prev.name, to: next.name };
  if (prev.objective !== next.objective)
    changes.objective = { from: prev.objective, to: next.objective };
  if (prev.initialState !== next.initialState)
    changes.initialState = {
      from: prev.initialState,
      to: next.initialState,
    };
  if (
    prev.budget.dailyBudget !== next.budget.dailyBudget ||
    prev.budget.lifetimeBudget !== next.budget.lifetimeBudget
  ) {
    changes.budget = {
      from: budgetToPlain(prev.budget),
      to: budgetToPlain(next.budget),
    };
  }
  if ((prev.adsetBudgetSharing ?? null) !== (next.adsetBudgetSharing ?? null)) {
    changes.adsetBudgetSharing = {
      from: prev.adsetBudgetSharing ?? null,
      to: next.adsetBudgetSharing ?? null,
    };
  }
  return changes;
}

function diffAdset(prev: Adset, next: Adset): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  if (prev.name !== next.name) changes.name = { from: prev.name, to: next.name };
  if (prev.initialState !== next.initialState)
    changes.initialState = {
      from: prev.initialState,
      to: next.initialState,
    };
  const prevBudget = prev.budget ? budgetToPlain(prev.budget) : null;
  const nextBudget = next.budget ? budgetToPlain(next.budget) : null;
  if (
    (prevBudget?.dailyBudget ?? null) !== (nextBudget?.dailyBudget ?? null) ||
    (prevBudget?.lifetimeBudget ?? null) !== (nextBudget?.lifetimeBudget ?? null)
  ) {
    changes.budget = { from: prevBudget, to: nextBudget };
  }
  for (const key of [
    "optimizationGoal",
    "billingEvent",
    "bidAmount",
    "startTime",
    "endTime",
    "pixelId",
    "customEventType",
  ] as const) {
    if ((prev[key] ?? null) !== (next[key] ?? null)) {
      changes[key] = { from: prev[key] ?? null, to: next[key] ?? null };
    }
  }
  const prevTargeting = targetingToPlain(prev.targeting);
  const nextTargeting = targetingToPlain(next.targeting);
  if (!targetingsEqual(prevTargeting, nextTargeting)) {
    changes.targeting = { from: prevTargeting, to: nextTargeting };
  }
  return changes;
}

function diffAd(prev: Ad, next: Ad): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  if (prev.name !== next.name) changes.name = { from: prev.name, to: next.name };
  if (prev.creativeRef !== next.creativeRef)
    changes.creativeRef = { from: prev.creativeRef, to: next.creativeRef };
  if (prev.initialState !== next.initialState)
    changes.initialState = {
      from: prev.initialState,
      to: next.initialState,
    };
  if ((prev.pixelId ?? null) !== (next.pixelId ?? null))
    changes.pixelId = { from: prev.pixelId ?? null, to: next.pixelId ?? null };
  const prevTrackingSpecs = JSON.stringify(prev.trackingSpecs ?? null);
  const nextTrackingSpecs = JSON.stringify(next.trackingSpecs ?? null);
  if (prevTrackingSpecs !== nextTrackingSpecs) {
    changes.trackingSpecs = {
      from: prev.trackingSpecs ?? null,
      to: next.trackingSpecs ?? null,
    };
  }
  return changes;
}

function diffCreative(prev: Creative, next: Creative): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  if (prev.name !== next.name) changes.name = { from: prev.name, to: next.name };
  if (prev.mediaType !== next.mediaType)
    changes.mediaType = { from: prev.mediaType, to: next.mediaType };
  if ((prev.headline ?? null) !== (next.headline ?? null))
    changes.headline = { from: prev.headline ?? null, to: next.headline ?? null };
  if ((prev.primaryText ?? null) !== (next.primaryText ?? null))
    changes.primaryText = {
      from: prev.primaryText ?? null,
      to: next.primaryText ?? null,
    };
  if ((prev.callToAction ?? null) !== (next.callToAction ?? null))
    changes.callToAction = {
      from: prev.callToAction ?? null,
      to: next.callToAction ?? null,
    };
  for (const key of [
    "pageId",
    "title",
    "body",
    "linkUrl",
    "description",
    "instagramUserId",
  ] as const) {
    if ((prev[key] ?? null) !== (next[key] ?? null)) {
      changes[key] = { from: prev[key] ?? null, to: next[key] ?? null };
    }
  }
  for (const key of [
    "images",
    "videos",
    "titles",
    "bodies",
    "descriptions",
    "callToActions",
  ] as const) {
    const prevValue = JSON.stringify(prev[key] ?? null);
    const nextValue = JSON.stringify(next[key] ?? null);
    if (prevValue !== nextValue) {
      changes[key] = { from: prev[key] ?? null, to: next[key] ?? null };
    }
  }
  if ((prev.storageKey ?? null) !== (next.storageKey ?? null))
    changes.storageKey = {
      from: prev.storageKey ?? null,
      to: next.storageKey ?? null,
    };
  return changes;
}

function diffExperiment(
  prev: Experiment,
  next: Experiment
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  if (prev.name !== next.name) changes.name = { from: prev.name, to: next.name };
  if (prev.campaignId !== next.campaignId)
    changes.campaignId = { from: prev.campaignId, to: next.campaignId };
  const prevVariants = JSON.stringify(prev.variants);
  const nextVariants = JSON.stringify(next.variants);
  if (prevVariants !== nextVariants) {
    changes.variants = { from: prev.variants, to: next.variants };
  }
  return changes;
}

function targetingsEqual(a: NormalizedTargeting, b: NormalizedTargeting): boolean {
  return (
    a.ageMin === b.ageMin &&
    a.ageMax === b.ageMax &&
    arraysEqualSorted(a.countries, b.countries) &&
    arraysEqualSorted(a.interests, b.interests) &&
    arraysEqualSorted(a.customAudiences, b.customAudiences)
  );
}

function arraysEqualSorted(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

interface DeleteBuckets {
  experiments: PlanAction[];
  ads: PlanAction[];
  adsets: PlanAction[];
  campaigns: PlanAction[];
  creatives: PlanAction[];
}

interface DiffAdsetsArgs {
  account: string;
  campaignId: string;
  nextAdsets: Adset[];
  previousAdsets: Adset[];
  creates: PlanAction[];
  updates: PlanAction[];
  deleteBuckets: DeleteBuckets;
  findings: PlanFinding[];
  knownCreativeIds: ReadonlySet<string>;
}

function diffAdsets(args: DiffAdsetsArgs): void {
  const {
    account,
    campaignId,
    nextAdsets,
    previousAdsets,
    creates,
    updates,
    deleteBuckets,
    findings,
    knownCreativeIds,
  } = args;

  const nextById = byId(nextAdsets, "id");
  const prevById = byId(previousAdsets, "id");

  for (const adset of nextAdsets) {
    const prev = prevById.get(adset.id) ?? null;
    if (prev === null && adset.importedExisting === true) {
      // Adopted live adsets are already present in Meta. Do not create them;
      // still diff their ads below so newly added ads are planned.
    } else if (prev === null) {
      creates.push({
        kind: "create_adset",
        account,
        campaignId,
        adsetId: adset.id,
        name: adset.name,
        initialState: adset.initialState,
        ...(adset.budget !== undefined
          ? { budget: budgetToPlain(adset.budget) }
          : {}),
        ...(adset.optimizationGoal !== undefined ? { optimizationGoal: adset.optimizationGoal } : {}),
        ...(adset.billingEvent !== undefined ? { billingEvent: adset.billingEvent } : {}),
        ...(adset.bidAmount !== undefined ? { bidAmount: adset.bidAmount } : {}),
        ...(adset.startTime !== undefined ? { startTime: adset.startTime } : {}),
        ...(adset.endTime !== undefined ? { endTime: adset.endTime } : {}),
        ...(adset.pixelId !== undefined ? { pixelId: adset.pixelId } : {}),
        ...(adset.customEventType !== undefined ? { customEventType: adset.customEventType } : {}),
        targeting: targetingToPlain(adset.targeting),
      });
    } else {
      const changes = diffAdset(prev, adset);
      if (Object.keys(changes).length > 0) {
        updates.push({
          kind: "update_adset",
          account,
          campaignId,
          adsetId: adset.id,
          changes,
        });
      }
    }
    diffAds({
      account,
      campaignId,
      adsetId: adset.id,
      nextAds: adset.ads,
      previousAds: prev?.ads ?? [],
      creates,
      updates,
      deleteBuckets,
      findings,
      knownCreativeIds,
    });
  }
  for (const prev of previousAdsets) {
    if (!nextById.has(prev.id)) {
      for (const ad of prev.ads) {
        deleteBuckets.ads.push({
          kind: "delete_ad",
          account,
          campaignId,
          adsetId: prev.id,
          adId: ad.id,
        });
      }
      deleteBuckets.adsets.push({
        kind: "delete_adset",
        account,
        campaignId,
        adsetId: prev.id,
      });
    }
  }
}

interface DiffAdsArgs {
  account: string;
  campaignId: string;
  adsetId: string;
  nextAds: Ad[];
  previousAds: Ad[];
  creates: PlanAction[];
  updates: PlanAction[];
  deleteBuckets: DeleteBuckets;
  findings: PlanFinding[];
  knownCreativeIds: ReadonlySet<string>;
}

function diffAds(args: DiffAdsArgs): void {
  const {
    account,
    campaignId,
    adsetId,
    nextAds,
    previousAds,
    creates,
    updates,
    deleteBuckets,
    findings,
    knownCreativeIds,
  } = args;
  const nextById = byId(nextAds, "id");
  const prevById = byId(previousAds, "id");
  for (const ad of nextAds) {
    if (!knownCreativeIds.has(ad.creativeRef)) {
      findings.push({
        level: "error",
        pointer: `campaigns[${campaignId}].adsets[${adsetId}].ads[${ad.id}].creativeRef`,
        message: `ad.creativeRef "${ad.creativeRef}" は creatives[].id に存在しません`,
      });
    }
    const prev = prevById.get(ad.id) ?? null;
    if (prev === null) {
      creates.push({
        kind: "create_ad",
        account,
        campaignId,
        adsetId,
        adId: ad.id,
        name: ad.name,
        creativeRef: ad.creativeRef,
        initialState: ad.initialState,
        ...(ad.pixelId !== undefined ? { pixelId: ad.pixelId } : {}),
        ...(ad.trackingSpecs !== undefined ? { trackingSpecs: ad.trackingSpecs } : {}),
      });
    } else {
      const changes = diffAd(prev, ad);
      if (Object.keys(changes).length > 0) {
        updates.push({
          kind: "update_ad",
          account,
          campaignId,
          adsetId,
          adId: ad.id,
          changes,
        });
      }
    }
  }
  for (const prev of previousAds) {
    if (!nextById.has(prev.id)) {
      deleteBuckets.ads.push({
        kind: "delete_ad",
        account,
        campaignId,
        adsetId,
        adId: prev.id,
      });
    }
  }
}

// ---- structural / guardrail checks ---------------------------------------

function collectStructuralFindings(brand: BrandYaml, findings: PlanFinding[]): void {
  const campaignIds = new Set(brand.campaigns.map((c) => c.id));
  const adsetIdsByCampaign = new Map<string, Set<string>>();
  for (const c of brand.campaigns) {
    adsetIdsByCampaign.set(c.id, new Set(c.adsets.map((a) => a.id)));
  }
  for (let i = 0; i < brand.experiments.length; i += 1) {
    const exp = brand.experiments[i]!;
    if (!campaignIds.has(exp.campaignId)) {
      findings.push({
        level: "error",
        pointer: `experiments[${i}].campaignId`,
        message: `experiment.campaignId "${exp.campaignId}" は campaigns[].id に存在しません`,
      });
      continue;
    }
    const adsetsInCampaign = adsetIdsByCampaign.get(exp.campaignId) ?? new Set<string>();
    let totalWeight = 0;
    for (let v = 0; v < exp.variants.length; v += 1) {
      const variant = exp.variants[v]!;
      totalWeight += variant.weight;
      for (const adsetId of variant.adsetIds) {
        if (!adsetsInCampaign.has(adsetId)) {
          findings.push({
            level: "error",
            pointer: `experiments[${i}].variants[${v}].adsetIds`,
            message: `experiment "${exp.id}" の variant "${variant.id}" は campaign "${exp.campaignId}" に属さない adset "${adsetId}" を参照しています`,
          });
        }
      }
    }
    if (totalWeight !== 100) {
      findings.push({
        level: "error",
        pointer: `experiments[${i}].variants`,
        message: `experiment "${exp.id}" の variants weight 合計は 100 である必要があります (got ${totalWeight})`,
      });
    }
  }
}

function collectGuardrailFindings(brand: BrandYaml, findings: PlanFinding[]): void {
  const g: Guardrails | undefined = brand.guardrails;
  for (let i = 0; i < brand.campaigns.length; i += 1) {
    const c = brand.campaigns[i]!;
    if (
      c.importedExisting !== true &&
      g?.maxDailyBudgetPerCampaign !== undefined &&
      c.budget.dailyBudget !== undefined
    ) {
      if (c.budget.dailyBudget > g.maxDailyBudgetPerCampaign) {
        findings.push({
          level: "error",
          pointer: `campaigns[${i}].budget.dailyBudget`,
          message: `campaign "${c.id}" の dailyBudget ${c.budget.dailyBudget} は guardrails.maxDailyBudgetPerCampaign (${g.maxDailyBudgetPerCampaign}) を超えています`,
        });
      }
    }
    if (
      c.importedExisting !== true &&
      g?.maxLifetimeBudgetPerCampaign !== undefined &&
      c.budget.lifetimeBudget !== undefined
    ) {
      if (c.budget.lifetimeBudget > g.maxLifetimeBudgetPerCampaign) {
        findings.push({
          level: "error",
          pointer: `campaigns[${i}].budget.lifetimeBudget`,
          message: `campaign "${c.id}" の lifetimeBudget ${c.budget.lifetimeBudget} は guardrails.maxLifetimeBudgetPerCampaign (${g.maxLifetimeBudgetPerCampaign}) を超えています`,
        });
      }
    }
    // Adset budgets > campaign budgets は warning (Meta 側が許容するケースもあるため)。
    if (c.importedExisting !== true && c.budget.dailyBudget !== undefined) {
      let adsetSum = 0;
      let allHaveDaily = c.adsets.length > 0;
      for (const a of c.adsets) {
        if (a.budget?.dailyBudget === undefined) {
          allHaveDaily = false;
          break;
        }
        adsetSum += a.budget.dailyBudget;
      }
      if (allHaveDaily && adsetSum > c.budget.dailyBudget) {
        findings.push({
          level: "warning",
          pointer: `campaigns[${i}].adsets`,
          message: `adset dailyBudget 合計 ${adsetSum} が campaign "${c.id}" の dailyBudget ${c.budget.dailyBudget} を超えています`,
        });
      }
    }
    for (let aIdx = 0; aIdx < c.adsets.length; aIdx += 1) {
      const adset = c.adsets[aIdx]!;
      const t = adset.targeting;
      if (g?.allowedCountries && g.allowedCountries.length > 0) {
        for (const country of t.countries) {
          if (!g.allowedCountries.includes(country)) {
            findings.push({
              level: "error",
              pointer: `campaigns[${i}].adsets[${aIdx}].targeting.countries`,
              message: `adset "${adset.id}" は guardrails.allowedCountries に含まれない国 "${country}" を targeting しています`,
            });
          }
        }
      }
      if (g?.bannedInterests && g.bannedInterests.length > 0) {
        const banned = new Set(g.bannedInterests.map((s) => s.toLowerCase()));
        for (const interest of t.interests) {
          if (banned.has(interest.toLowerCase())) {
            findings.push({
              level: "error",
              pointer: `campaigns[${i}].adsets[${aIdx}].targeting.interests`,
              message: `adset "${adset.id}" の interest "${interest}" は guardrails.bannedInterests により禁止されています`,
            });
          }
        }
      }
    }
  }
}

// AdDroid OSS — MockMetaSandbox.
//
// `MockMetaAdapter` (oauth + businesses + ad_accounts) を補完する、completely
// in-process な campaign / adset / ad / creative / insights ハーネス。
// `ADDROID_META_ADS_CLI_MOCK=1` 経路の MockApplyExecutor が「即 success を返すだけ」
// で Meta object 状態を持たなかった結果、E2E から見ると create_adset の親不在や
// activate 対象不在のような構造的ミスを検出できなかった。
//
// このサンドボックスは PlanAction を受けて in-memory state を更新し、参照整合性
// (adset → campaign / ad → adset & creative) と PAUSED-by-default / Activate を
// 実機と同じ語彙で再現する。the current implementation の sandbox-or-mock 受入要件を満たす E2E が
// 主要フロー (create_campaign → create_adset → create_ad → create_creative →
// activate → insights) を assertion 付きで検証できるようにする。
//
// 設計方針:
//   - graph.facebook.com に到達しない (network 呼び出しなし)。
//   - 個人 path / hardcoded act_id / personal token 由来の値を一切持たない。
//     external_id は account / YAML 上の id から決定論的に導出する。
//   - Prisma / fs / node:net を import しない (純関数的に保つ)。
//   - 失敗系は SandboxValidationError + code (machine-readable) で表現する。
//   - insights は (resource, externalId, dateStart, dateEnd) から決定論的に生成
//     する (random なし)。CI ハーネスから assertion 可能。

import type {
  CreateAdAction,
  CreateAdsetAction,
  CreateCampaignAction,
  CreateCreativeAction,
  DeleteAdAction,
  DeleteAdsetAction,
  DeleteCampaignAction,
  DeleteCreativeAction,
  PlanAction,
  UpdateAdAction,
  UpdateAdsetAction,
  UpdateCampaignAction,
  UpdateCreativeAction,
} from "@addroid/yaml-schemas";

// FieldChange / NormalizedTargeting は @addroid/yaml-schemas/src/plan.ts に
// 定義されているが現状 index 経由で export されていない。本ファイルだけのために
// 上流の export 面を拡げると scope 外の変更になるため、構造的に同型のローカル
// 別名を持って interop する。`UpdateCampaignAction.changes` 等、yaml-schemas 由来の
// 値はそのまま `LocalFieldChange` の形を満たす。
interface LocalFieldChange {
  from: unknown;
  to: unknown;
}

interface LocalNormalizedTargeting {
  countries: string[];
  ageMin?: number;
  ageMax?: number;
  interests: string[];
  customAudiences: string[];
}

export type SandboxResource = "campaigns" | "adsets" | "ads" | "creatives";
export type SandboxInsightsResource = "campaigns" | "adsets" | "ads";
export type SandboxVerb = "create" | "update" | "delete";

export type MetaObjectStatus = "PAUSED" | "ACTIVE" | "ARCHIVED" | "DELETED";

export interface SandboxBudget {
  dailyUsd?: number;
  lifetimeUsd?: number;
}

export interface SandboxCampaign {
  externalId: string;
  account: string;
  campaignId: string;
  name: string;
  objective: string;
  status: MetaObjectStatus;
  budget: SandboxBudget;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxAdSet {
  externalId: string;
  account: string;
  campaignExternalId: string;
  campaignId: string;
  adsetId: string;
  name: string;
  status: MetaObjectStatus;
  budget: SandboxBudget;
  targeting: LocalNormalizedTargeting;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxAd {
  externalId: string;
  account: string;
  adsetExternalId: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  name: string;
  creativeRef: string;
  creativeExternalId: string;
  status: MetaObjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxCreative {
  externalId: string;
  account: string;
  creativeId: string;
  name: string;
  mediaType: string;
  headline: string | null;
  primaryText: string | null;
  callToAction: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxApplyResult {
  status: "success" | "skipped";
  resource: SandboxResource;
  verb: SandboxVerb;
  externalId: string;
  message: string;
}

export interface SandboxInsights {
  resource: SandboxInsightsResource;
  externalId: string;
  dateStart: string;
  dateEnd: string;
  impressions: number;
  clicks: number;
  spendUsd: number;
  reach: number;
  ctr: number;
  cpcUsd: number;
}

export type SandboxValidationCode =
  | "duplicate_create"
  | "parent_campaign_not_found"
  | "parent_adset_not_found"
  | "creative_ref_not_found"
  | "target_not_found"
  | "target_deleted"
  | "unsupported_action"
  | "delete_blocked_by_dependents"
  | "activate_unsupported_resource";

export class SandboxValidationError extends Error {
  readonly code: SandboxValidationCode;
  readonly resource: SandboxResource | null;
  readonly externalId: string | null;
  constructor(input: {
    code: SandboxValidationCode;
    resource: SandboxResource | null;
    externalId: string | null;
    message: string;
  }) {
    super(input.message);
    this.name = "SandboxValidationError";
    this.code = input.code;
    this.resource = input.resource;
    this.externalId = input.externalId;
  }
}

export interface MockMetaSandboxOptions {
  /**
   * test seam: 現在時刻を返す関数。決定論的なテスト向けに上書き可能。
   */
  clock?: () => Date;
  /**
   * Insights 値の決定論的シード (account / externalId と組み合わせて生成)。
   */
  insightsSeed?: string;
}

interface AccountState {
  campaignsById: Map<string, SandboxCampaign>;
  adsetsById: Map<string, SandboxAdSet>;
  adsById: Map<string, SandboxAd>;
  creativesById: Map<string, SandboxCreative>;
}

const SUPPORTED_INSIGHTS_RESOURCES: ReadonlySet<SandboxInsightsResource> = new Set([
  "campaigns",
  "adsets",
  "ads",
]);

/**
 * In-memory campaign/adset/ad/creative/insights サンドボックス。
 *
 * 1 つのインスタンス = 1 つのテストワークスペースに対応。`reset()` で状態を捨てる。
 * 並行アクセスは想定していない (テストハーネス用途)。
 */
export class MockMetaSandbox {
  private readonly accounts = new Map<string, AccountState>();
  private readonly clock: () => Date;
  private readonly insightsSeed: string;

  constructor(opts: MockMetaSandboxOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.insightsSeed = opts.insightsSeed ?? "addroid-mock-meta-sandbox";
  }

  /**
   * 1 つの PlanAction をサンドボックスに適用する。
   *
   * - `create_*` は account / id 単位で重複を拒否する。
   * - `create_adset` は parent campaign の存在を要求する。
   * - `create_ad` は parent adset と参照 creative の存在を要求する。
   * - `update_*` は target object の存在を要求し、`changes` を idempotent に適用する。
   * - `delete_*` は親→子の削除順序を緩く検証する (依存子が残っていればブロック)。
   * - サポート外の kind (`*_experiment`) は skipped で返す (META_CLI_SUPPORTED_OPERATIONS 未登録)。
   *
   * 参照整合性違反は SandboxValidationError を投げる (status を返さない)。
   * caller は try/catch で `code` をキャプチャして audit に残す。
   */
  applyAction(action: PlanAction): SandboxApplyResult {
    switch (action.kind) {
      case "create_campaign":
        return this.createCampaign(action);
      case "update_campaign":
        return this.updateCampaign(action);
      case "delete_campaign":
        return this.deleteCampaign(action);
      case "create_adset":
        return this.createAdSet(action);
      case "update_adset":
        return this.updateAdSet(action);
      case "delete_adset":
        return this.deleteAdSet(action);
      case "create_ad":
        return this.createAd(action);
      case "update_ad":
        return this.updateAd(action);
      case "delete_ad":
        return this.deleteAd(action);
      case "create_creative":
        return this.createCreative(action);
      case "update_creative":
        return this.updateCreative(action);
      case "delete_creative":
        return this.deleteCreative(action);
      case "create_experiment":
      case "update_experiment":
      case "delete_experiment":
        return {
          status: "skipped",
          resource: "campaigns",
          verb: actionVerb(action.kind),
          externalId: "",
          message: `experiment actions are not supported by MockMetaSandbox (kind=${action.kind})`,
        };
      default: {
        const exhaustive: never = action;
        throw new SandboxValidationError({
          code: "unsupported_action",
          resource: null,
          externalId: null,
          message: `MockMetaSandbox cannot handle action ${JSON.stringify(exhaustive)}`,
        });
      }
    }
  }

  /**
   * PAUSED で作成された campaign / adset / ad を ACTIVE に遷移させる。
   * すでに ACTIVE な場合は idempotent に成功扱い。DELETED / ARCHIVED は拒否する。
   */
  activate(input: { resource: SandboxInsightsResource; externalId: string }): {
    resource: SandboxInsightsResource;
    externalId: string;
    previousStatus: MetaObjectStatus;
    status: MetaObjectStatus;
  } {
    if (!SUPPORTED_INSIGHTS_RESOURCES.has(input.resource)) {
      throw new SandboxValidationError({
        code: "activate_unsupported_resource",
        resource: null,
        externalId: input.externalId,
        message: `Activate is only supported for campaigns / adsets / ads (got "${input.resource}")`,
      });
    }
    const found = this.findActivatable(input.resource, input.externalId);
    const previousStatus = found.status;
    if (found.status === "DELETED" || found.status === "ARCHIVED") {
      throw new SandboxValidationError({
        code: "target_deleted",
        resource: input.resource,
        externalId: input.externalId,
        message: `Cannot activate ${input.resource}/${input.externalId}: status is ${found.status}`,
      });
    }
    found.status = "ACTIVE";
    found.updatedAt = this.now();
    return {
      resource: input.resource,
      externalId: input.externalId,
      previousStatus,
      status: found.status,
    };
  }

  /**
   * 決定論的な Insights を返す。サンドボックス上に存在しない externalId は null。
   * 値は `insightsSeed` + resource + externalId + dateStart + dateEnd から
   * 再現可能なハッシュで生成する (random を使わない)。
   */
  getInsights(input: {
    resource: SandboxInsightsResource;
    externalId: string;
    dateStart: string;
    dateEnd: string;
  }): SandboxInsights | null {
    if (!SUPPORTED_INSIGHTS_RESOURCES.has(input.resource)) {
      return null;
    }
    const exists =
      input.resource === "campaigns"
        ? this.findCampaignByExternalId(input.externalId)
        : input.resource === "adsets"
          ? this.findAdSetByExternalId(input.externalId)
          : this.findAdByExternalId(input.externalId);
    if (!exists) return null;
    return synthesizeInsights({
      seed: this.insightsSeed,
      resource: input.resource,
      externalId: input.externalId,
      dateStart: input.dateStart,
      dateEnd: input.dateEnd,
    });
  }

  // ---- read helpers --------------------------------------------------

  getCampaign(externalId: string): SandboxCampaign | null {
    return this.findCampaignByExternalId(externalId);
  }
  getAdSet(externalId: string): SandboxAdSet | null {
    return this.findAdSetByExternalId(externalId);
  }
  getAd(externalId: string): SandboxAd | null {
    return this.findAdByExternalId(externalId);
  }
  getCreative(externalId: string): SandboxCreative | null {
    return this.findCreativeByExternalId(externalId);
  }

  listCampaigns(account?: string): SandboxCampaign[] {
    const out: SandboxCampaign[] = [];
    for (const [acc, state] of this.accounts.entries()) {
      if (account && acc !== account) continue;
      for (const c of state.campaignsById.values()) out.push(c);
    }
    return out;
  }
  listAdSets(account?: string): SandboxAdSet[] {
    const out: SandboxAdSet[] = [];
    for (const [acc, state] of this.accounts.entries()) {
      if (account && acc !== account) continue;
      for (const a of state.adsetsById.values()) out.push(a);
    }
    return out;
  }
  listAds(account?: string): SandboxAd[] {
    const out: SandboxAd[] = [];
    for (const [acc, state] of this.accounts.entries()) {
      if (account && acc !== account) continue;
      for (const a of state.adsById.values()) out.push(a);
    }
    return out;
  }
  listCreatives(account?: string): SandboxCreative[] {
    const out: SandboxCreative[] = [];
    for (const [acc, state] of this.accounts.entries()) {
      if (account && acc !== account) continue;
      for (const c of state.creativesById.values()) out.push(c);
    }
    return out;
  }

  /** 全 account の状態を捨てる (テスト間 cleanup)。 */
  reset(): void {
    this.accounts.clear();
  }

  // ---- internals -----------------------------------------------------

  private now(): Date {
    return this.clock();
  }

  private state(account: string): AccountState {
    let s = this.accounts.get(account);
    if (!s) {
      s = {
        campaignsById: new Map(),
        adsetsById: new Map(),
        adsById: new Map(),
        creativesById: new Map(),
      };
      this.accounts.set(account, s);
    }
    return s;
  }

  private createCampaign(action: CreateCampaignAction): SandboxApplyResult {
    const externalId = deriveExternalId({
      resource: "campaigns",
      account: action.account,
      id: action.campaignId,
    });
    const s = this.state(action.account);
    if (s.campaignsById.has(action.campaignId)) {
      throw new SandboxValidationError({
        code: "duplicate_create",
        resource: "campaigns",
        externalId,
        message: `campaign ${action.campaignId} already exists in account ${action.account}`,
      });
    }
    const now = this.now();
    s.campaignsById.set(action.campaignId, {
      externalId,
      account: action.account,
      campaignId: action.campaignId,
      name: action.name,
      objective: action.objective,
      status: action.initialState === "active" ? "ACTIVE" : "PAUSED",
      budget: { ...action.budget },
      createdAt: now,
      updatedAt: now,
    });
    return successResult({
      resource: "campaigns",
      verb: "create",
      externalId,
      message: `created campaign ${action.campaignId}`,
    });
  }

  private updateCampaign(action: UpdateCampaignAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.campaignsById.get(action.campaignId);
    if (!target || target.status === "DELETED") {
      throw new SandboxValidationError({
        code: target ? "target_deleted" : "target_not_found",
        resource: "campaigns",
        externalId: target?.externalId ?? null,
        message: `cannot update campaign ${action.campaignId}: not found in account ${action.account}`,
      });
    }
    applyFieldChanges(target, action.changes);
    target.updatedAt = this.now();
    return successResult({
      resource: "campaigns",
      verb: "update",
      externalId: target.externalId,
      message: `updated campaign ${action.campaignId}`,
    });
  }

  private deleteCampaign(action: DeleteCampaignAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.campaignsById.get(action.campaignId);
    if (!target) {
      throw new SandboxValidationError({
        code: "target_not_found",
        resource: "campaigns",
        externalId: null,
        message: `cannot delete campaign ${action.campaignId}: not found in account ${action.account}`,
      });
    }
    for (const child of s.adsetsById.values()) {
      if (child.campaignId === action.campaignId && child.status !== "DELETED") {
        throw new SandboxValidationError({
          code: "delete_blocked_by_dependents",
          resource: "campaigns",
          externalId: target.externalId,
          message: `cannot delete campaign ${action.campaignId}: adset ${child.adsetId} still references it`,
        });
      }
    }
    target.status = "DELETED";
    target.updatedAt = this.now();
    return successResult({
      resource: "campaigns",
      verb: "delete",
      externalId: target.externalId,
      message: `deleted campaign ${action.campaignId}`,
    });
  }

  private createAdSet(action: CreateAdsetAction): SandboxApplyResult {
    const externalId = deriveExternalId({
      resource: "adsets",
      account: action.account,
      id: action.adsetId,
    });
    const s = this.state(action.account);
    const parent = s.campaignsById.get(action.campaignId);
    if (!parent || parent.status === "DELETED") {
      throw new SandboxValidationError({
        code: "parent_campaign_not_found",
        resource: "adsets",
        externalId,
        message: `cannot create adset ${action.adsetId}: parent campaign ${action.campaignId} not found in account ${action.account}`,
      });
    }
    if (s.adsetsById.has(action.adsetId)) {
      throw new SandboxValidationError({
        code: "duplicate_create",
        resource: "adsets",
        externalId,
        message: `adset ${action.adsetId} already exists in account ${action.account}`,
      });
    }
    const now = this.now();
    s.adsetsById.set(action.adsetId, {
      externalId,
      account: action.account,
      campaignExternalId: parent.externalId,
      campaignId: action.campaignId,
      adsetId: action.adsetId,
      name: action.name,
      status: action.initialState === "active" ? "ACTIVE" : "PAUSED",
      budget: { ...(action.budget ?? {}) },
      targeting: cloneTargeting(action.targeting),
      createdAt: now,
      updatedAt: now,
    });
    return successResult({
      resource: "adsets",
      verb: "create",
      externalId,
      message: `created adset ${action.adsetId} under campaign ${action.campaignId}`,
    });
  }

  private updateAdSet(action: UpdateAdsetAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.adsetsById.get(action.adsetId);
    if (!target || target.status === "DELETED") {
      throw new SandboxValidationError({
        code: target ? "target_deleted" : "target_not_found",
        resource: "adsets",
        externalId: target?.externalId ?? null,
        message: `cannot update adset ${action.adsetId}: not found in account ${action.account}`,
      });
    }
    applyFieldChanges(target, action.changes);
    target.updatedAt = this.now();
    return successResult({
      resource: "adsets",
      verb: "update",
      externalId: target.externalId,
      message: `updated adset ${action.adsetId}`,
    });
  }

  private deleteAdSet(action: DeleteAdsetAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.adsetsById.get(action.adsetId);
    if (!target) {
      throw new SandboxValidationError({
        code: "target_not_found",
        resource: "adsets",
        externalId: null,
        message: `cannot delete adset ${action.adsetId}: not found in account ${action.account}`,
      });
    }
    for (const child of s.adsById.values()) {
      if (child.adsetId === action.adsetId && child.status !== "DELETED") {
        throw new SandboxValidationError({
          code: "delete_blocked_by_dependents",
          resource: "adsets",
          externalId: target.externalId,
          message: `cannot delete adset ${action.adsetId}: ad ${child.adId} still references it`,
        });
      }
    }
    target.status = "DELETED";
    target.updatedAt = this.now();
    return successResult({
      resource: "adsets",
      verb: "delete",
      externalId: target.externalId,
      message: `deleted adset ${action.adsetId}`,
    });
  }

  private createAd(action: CreateAdAction): SandboxApplyResult {
    const externalId = deriveExternalId({
      resource: "ads",
      account: action.account,
      id: action.adId,
    });
    const s = this.state(action.account);
    const parentAdSet = s.adsetsById.get(action.adsetId);
    if (!parentAdSet || parentAdSet.status === "DELETED") {
      throw new SandboxValidationError({
        code: "parent_adset_not_found",
        resource: "ads",
        externalId,
        message: `cannot create ad ${action.adId}: parent adset ${action.adsetId} not found in account ${action.account}`,
      });
    }
    const creative = s.creativesById.get(action.creativeRef);
    if (!creative) {
      throw new SandboxValidationError({
        code: "creative_ref_not_found",
        resource: "ads",
        externalId,
        message: `cannot create ad ${action.adId}: creative ref ${action.creativeRef} not found in account ${action.account}`,
      });
    }
    if (s.adsById.has(action.adId)) {
      throw new SandboxValidationError({
        code: "duplicate_create",
        resource: "ads",
        externalId,
        message: `ad ${action.adId} already exists in account ${action.account}`,
      });
    }
    const now = this.now();
    s.adsById.set(action.adId, {
      externalId,
      account: action.account,
      adsetExternalId: parentAdSet.externalId,
      campaignId: action.campaignId,
      adsetId: action.adsetId,
      adId: action.adId,
      name: action.name,
      creativeRef: action.creativeRef,
      creativeExternalId: creative.externalId,
      status: action.initialState === "active" ? "ACTIVE" : "PAUSED",
      createdAt: now,
      updatedAt: now,
    });
    return successResult({
      resource: "ads",
      verb: "create",
      externalId,
      message: `created ad ${action.adId} under adset ${action.adsetId}`,
    });
  }

  private updateAd(action: UpdateAdAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.adsById.get(action.adId);
    if (!target || target.status === "DELETED") {
      throw new SandboxValidationError({
        code: target ? "target_deleted" : "target_not_found",
        resource: "ads",
        externalId: target?.externalId ?? null,
        message: `cannot update ad ${action.adId}: not found in account ${action.account}`,
      });
    }
    applyFieldChanges(target, action.changes);
    target.updatedAt = this.now();
    return successResult({
      resource: "ads",
      verb: "update",
      externalId: target.externalId,
      message: `updated ad ${action.adId}`,
    });
  }

  private deleteAd(action: DeleteAdAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.adsById.get(action.adId);
    if (!target) {
      throw new SandboxValidationError({
        code: "target_not_found",
        resource: "ads",
        externalId: null,
        message: `cannot delete ad ${action.adId}: not found in account ${action.account}`,
      });
    }
    target.status = "DELETED";
    target.updatedAt = this.now();
    return successResult({
      resource: "ads",
      verb: "delete",
      externalId: target.externalId,
      message: `deleted ad ${action.adId}`,
    });
  }

  private createCreative(action: CreateCreativeAction): SandboxApplyResult {
    const externalId = deriveExternalId({
      resource: "creatives",
      account: action.account,
      id: action.creativeId,
    });
    const s = this.state(action.account);
    if (s.creativesById.has(action.creativeId)) {
      throw new SandboxValidationError({
        code: "duplicate_create",
        resource: "creatives",
        externalId,
        message: `creative ${action.creativeId} already exists in account ${action.account}`,
      });
    }
    const now = this.now();
    s.creativesById.set(action.creativeId, {
      externalId,
      account: action.account,
      creativeId: action.creativeId,
      name: action.name,
      mediaType: action.mediaType,
      headline: action.headline ?? null,
      primaryText: action.primaryText ?? null,
      callToAction: action.callToAction ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return successResult({
      resource: "creatives",
      verb: "create",
      externalId,
      message: `created creative ${action.creativeId}`,
    });
  }

  private updateCreative(action: UpdateCreativeAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.creativesById.get(action.creativeId);
    if (!target) {
      throw new SandboxValidationError({
        code: "target_not_found",
        resource: "creatives",
        externalId: null,
        message: `cannot update creative ${action.creativeId}: not found in account ${action.account}`,
      });
    }
    applyFieldChanges(target, action.changes);
    target.updatedAt = this.now();
    return successResult({
      resource: "creatives",
      verb: "update",
      externalId: target.externalId,
      message: `updated creative ${action.creativeId}`,
    });
  }

  private deleteCreative(action: DeleteCreativeAction): SandboxApplyResult {
    const s = this.state(action.account);
    const target = s.creativesById.get(action.creativeId);
    if (!target) {
      throw new SandboxValidationError({
        code: "target_not_found",
        resource: "creatives",
        externalId: null,
        message: `cannot delete creative ${action.creativeId}: not found in account ${action.account}`,
      });
    }
    for (const ad of s.adsById.values()) {
      if (ad.creativeRef === action.creativeId && ad.status !== "DELETED") {
        throw new SandboxValidationError({
          code: "delete_blocked_by_dependents",
          resource: "creatives",
          externalId: target.externalId,
          message: `cannot delete creative ${action.creativeId}: ad ${ad.adId} still references it`,
        });
      }
    }
    s.creativesById.delete(action.creativeId);
    return successResult({
      resource: "creatives",
      verb: "delete",
      externalId: target.externalId,
      message: `deleted creative ${action.creativeId}`,
    });
  }

  private findCampaignByExternalId(externalId: string): SandboxCampaign | null {
    for (const state of this.accounts.values()) {
      for (const c of state.campaignsById.values()) {
        if (c.externalId === externalId) return c;
      }
    }
    return null;
  }
  private findAdSetByExternalId(externalId: string): SandboxAdSet | null {
    for (const state of this.accounts.values()) {
      for (const a of state.adsetsById.values()) {
        if (a.externalId === externalId) return a;
      }
    }
    return null;
  }
  private findAdByExternalId(externalId: string): SandboxAd | null {
    for (const state of this.accounts.values()) {
      for (const a of state.adsById.values()) {
        if (a.externalId === externalId) return a;
      }
    }
    return null;
  }
  private findCreativeByExternalId(externalId: string): SandboxCreative | null {
    for (const state of this.accounts.values()) {
      for (const c of state.creativesById.values()) {
        if (c.externalId === externalId) return c;
      }
    }
    return null;
  }

  private findActivatable(
    resource: SandboxInsightsResource,
    externalId: string
  ): SandboxCampaign | SandboxAdSet | SandboxAd {
    const found =
      resource === "campaigns"
        ? this.findCampaignByExternalId(externalId)
        : resource === "adsets"
          ? this.findAdSetByExternalId(externalId)
          : this.findAdByExternalId(externalId);
    if (!found) {
      throw new SandboxValidationError({
        code: "target_not_found",
        resource,
        externalId,
        message: `cannot activate ${resource}/${externalId}: not found in sandbox`,
      });
    }
    return found;
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function actionVerb(kind: PlanAction["kind"]): SandboxVerb {
  if (kind.startsWith("create_")) return "create";
  if (kind.startsWith("update_")) return "update";
  return "delete";
}

function successResult(input: {
  resource: SandboxResource;
  verb: SandboxVerb;
  externalId: string;
  message: string;
}): SandboxApplyResult {
  return {
    status: "success",
    resource: input.resource,
    verb: input.verb,
    externalId: input.externalId,
    message: input.message,
  };
}

/**
 * 決定論的な external_id。worker 側の `deterministicMockExternalId` と意図的に
 * 異なる prefix (`mms`) を持たせ、両者が混在したログでも追跡可能にする。
 */
export function deriveExternalId(input: {
  resource: SandboxResource;
  account: string;
  id: string;
}): string {
  const tag =
    input.resource === "campaigns"
      ? "cmp"
      : input.resource === "adsets"
        ? "as"
        : input.resource === "ads"
          ? "ad"
          : "cr";
  return `mms-${input.account}-${tag}-${input.id}`;
}

function applyFieldChanges(
  target: object,
  changes: Record<string, LocalFieldChange>
): void {
  const t = target as Record<string, unknown>;
  for (const [field, change] of Object.entries(changes)) {
    setDeepField(t, field, change.to);
  }
}

function setDeepField(
  target: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    const next = cur[key];
    if (!next || typeof next !== "object") {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1] as string] = value;
}

function cloneTargeting(t: LocalNormalizedTargeting): LocalNormalizedTargeting {
  const out: LocalNormalizedTargeting = {
    countries: [...t.countries],
    interests: [...t.interests],
    customAudiences: [...t.customAudiences],
  };
  if (t.ageMin !== undefined) out.ageMin = t.ageMin;
  if (t.ageMax !== undefined) out.ageMax = t.ageMax;
  return out;
}

/**
 * 文字列を 32-bit FNV-1a でハッシュする (random 不使用、seed 入力で決定論)。
 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function synthesizeInsights(input: {
  seed: string;
  resource: SandboxInsightsResource;
  externalId: string;
  dateStart: string;
  dateEnd: string;
}): SandboxInsights {
  const base = `${input.seed}|${input.resource}|${input.externalId}|${input.dateStart}|${input.dateEnd}`;
  const h1 = fnv1a(base);
  const h2 = fnv1a(`${base}|impressions`);
  const h3 = fnv1a(`${base}|clicks`);
  const h4 = fnv1a(`${base}|spend`);
  const impressions = 1_000 + (h2 % 50_000);
  const clicks = Math.min(impressions, 10 + (h3 % 2_500));
  const spendCents = 1_00 + (h4 % 100_000);
  const spendUsd = round2(spendCents / 100);
  const reach = Math.max(1, Math.floor(impressions * (0.4 + (h1 % 40) / 100)));
  const ctr = round4(impressions === 0 ? 0 : clicks / impressions);
  const cpcUsd = round2(clicks === 0 ? 0 : spendUsd / clicks);
  return {
    resource: input.resource,
    externalId: input.externalId,
    dateStart: input.dateStart,
    dateEnd: input.dateEnd,
    impressions,
    clicks,
    spendUsd,
    reach,
    ctr,
    cpcUsd,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

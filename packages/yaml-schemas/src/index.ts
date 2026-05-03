// AdDroid OSS — YAML Zod schemas + ops repo loader.
//
// the current implementation の Acceptance:
//   - malformed Ads YAML
//   - malformed cron.yaml
//   - account.key パスとファイル位置の不整合
//   - 安全でない予算変更
//   - 初期 active キャンペーン作成
// を拒否する Zod スキーマと検証ヘルパを提供する。
//
// 公開 API:
//   - ProjectYamlSchema / CronYamlSchema / BrandYamlSchema (Zod)
//   - assertBrandYamlPathMatches / assertInitialCampaignsArePaused / assertBudgetChangeIsSafe
//   - loadAndValidateOpsRepo: ops repo ディレクトリを走査して全ファイルを検証
//
// CLI (apps/cli の validate / plan) と CI ワークフロー (npx addroid-cli validate)
// 双方からこのモジュールが呼ばれる。

import fs from "node:fs";
import path from "node:path";
import { z, type ZodIssue } from "zod";
import YAML from "yaml";

// ---- project.yaml --------------------------------------------------------

export const ProjectYamlSchema = z
  .object({
    version: z.literal(1),
    workspace: z.object({
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, "slug は小文字英数字とハイフンのみ"),
      displayName: z.string().min(1),
    }),
  })
  .strict();

export type ProjectYaml = z.infer<typeof ProjectYamlSchema>;

// ---- cron.yaml -----------------------------------------------------------

// Cron 式を「文字種 + フィールド数」だけでなくセマンティックに検証する。
// 各フィールドの範囲外値 (例: 60 分, 24 時) や、`5-3` のような不正レンジ、
// `*/0` のような不正 step を確実に拒否することで、pg-boss に登録される前に
// 壊れた schedule を弾く。
//
// サポートする atom 形式 (フィールドはカンマ区切りで並べられる):
//   *           ワイルドカード
//   N           単一値 (フィールドの範囲内)
//   A-B         レンジ (A <= B、両端ともフィールド範囲内)
//   */N         全範囲ステップ (N >= 1)
//   A-B/N       レンジステップ
//   N/M         開始値ステップ
const CRON_FIELDS: ReadonlyArray<{
  name: string;
  min: number;
  max: number;
}> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // day-of-week は 0 と 7 の双方が日曜を表すため 0..7 を許容する
  { name: "dayOfWeek", min: 0, max: 7 },
];

function parseCronInteger(s: string): number | null {
  if (s.length === 0 || !/^\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

function validateCronAtom(
  atom: string,
  field: { name: string; min: number; max: number }
): string | null {
  if (atom.length === 0) {
    return `${field.name}: empty atom`;
  }

  let body = atom;
  const slashIdx = atom.indexOf("/");
  if (slashIdx !== -1) {
    body = atom.slice(0, slashIdx);
    const stepStr = atom.slice(slashIdx + 1);
    const step = parseCronInteger(stepStr);
    if (step === null || step <= 0) {
      return `${field.name}: step must be a positive integer (got "${stepStr}")`;
    }
  }

  if (body === "*") return null;
  if (body.length === 0) {
    return `${field.name}: missing value before "/"`;
  }

  const dashIdx = body.indexOf("-");
  if (dashIdx !== -1) {
    const startStr = body.slice(0, dashIdx);
    const endStr = body.slice(dashIdx + 1);
    const start = parseCronInteger(startStr);
    const end = parseCronInteger(endStr);
    if (start === null || end === null) {
      return `${field.name}: invalid range "${body}"`;
    }
    if (start < field.min || start > field.max) {
      return `${field.name}: range start ${start} not in [${field.min}, ${field.max}]`;
    }
    if (end < field.min || end > field.max) {
      return `${field.name}: range end ${end} not in [${field.min}, ${field.max}]`;
    }
    if (start > end) {
      return `${field.name}: range start (${start}) is greater than end (${end})`;
    }
    return null;
  }

  const n = parseCronInteger(body);
  if (n === null) {
    return `${field.name}: invalid value "${body}"`;
  }
  if (n < field.min || n > field.max) {
    return `${field.name}: value ${n} not in [${field.min}, ${field.max}]`;
  }
  return null;
}

function validateCronField(
  raw: string,
  field: { name: string; min: number; max: number }
): string | null {
  if (raw.length === 0) return `${field.name}: empty field`;
  const atoms = raw.split(",");
  for (const atom of atoms) {
    const err = validateCronAtom(atom, field);
    if (err !== null) return err;
  }
  return null;
}

function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return "cron 式が空です";
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return `5 フィールドの cron 式である必要があります (got ${fields.length} fields)`;
  }
  for (let i = 0; i < CRON_FIELDS.length; i += 1) {
    const fieldDef = CRON_FIELDS[i]!;
    const err = validateCronField(fields[i]!, fieldDef);
    if (err !== null) return err;
  }
  return null;
}

const CronExpressionSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const err = validateCronExpression(value);
    if (err !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err,
      });
    }
  });

export const CronEntrySchema = z
  .object({
    name: z.enum([
      "github_poll",
      "daily_report",
      "budget_guard",
      "improvement_pr",
    ]),
    cron: CronExpressionSchema,
    enabled: z.boolean().default(false),
  })
  .strict();

export const CronYamlSchema = z
  .object({
    version: z.literal(1),
    schedules: z.array(CronEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.schedules.length; i += 1) {
      const name = value.schedules[i]!.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedules", i, "name"],
          message: `duplicate schedule name: ${name}`,
        });
      }
      seen.add(name);
    }
  });

export type CronYaml = z.infer<typeof CronYamlSchema>;

// ---- brand.yaml (Ads YAML 入口) -----------------------------------------

// the current implementation での budget は USD 単位の整数 (cents は導入しない)。
// 予算暴走を構造的に防ぐため、上限は schema 段階で抑える。
export const BUDGET_HARD_CAP_USD = 10_000; // 1 日/1 案件あたりの絶対上限
export const BUDGET_INCREASE_RATIO_LIMIT = 2; // 既存比 2 倍を超える増額は unsafe

const BudgetSchema = z
  .object({
    dailyUsd: z.number().int().nonnegative().max(BUDGET_HARD_CAP_USD).optional(),
    lifetimeUsd: z
      .number()
      .int()
      .nonnegative()
      .max(BUDGET_HARD_CAP_USD * 365)
      .optional(),
  })
  .strict()
  .refine(
    (b) => b.dailyUsd !== undefined || b.lifetimeUsd !== undefined,
    "budget は dailyUsd か lifetimeUsd の少なくとも一方を指定してください"
  );

export type Budget = z.infer<typeof BudgetSchema>;

export const CampaignObjectiveSchema = z.enum([
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
]);

// the current implementation: adset / ad / creative / targeting / guardrails / experiments を Ads YAML
// に取り込み、buildExecutionPlan で Meta 実行 plan に変換できるようにする。
// 既存 fixtures (campaigns のみ) との後方互換のため、追加フィールドはすべて optional。

const ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export const TargetingSchema = z
  .object({
    countries: z
      .array(
        z
          .string()
          .regex(
            /^[A-Z]{2}$/,
            "country は ISO 3166-1 alpha-2 (2 文字大文字)"
          )
      )
      .default([]),
    ageMin: z.number().int().min(13).max(65).optional(),
    ageMax: z.number().int().min(13).max(65).optional(),
    interests: z.array(z.string().min(1)).default([]),
    customAudiences: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine(
    (t) =>
      t.ageMin === undefined ||
      t.ageMax === undefined ||
      t.ageMin <= t.ageMax,
    "targeting.ageMin must be <= ageMax"
  );

export type Targeting = z.infer<typeof TargetingSchema>;

export const AdSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(ID_REGEX, "ad id は小文字英数字 / アンダースコア / ハイフン (先頭は英数字)"),
    name: z.string().min(1),
    creativeRef: z
      .string()
      .min(1)
      .regex(ID_REGEX, "creativeRef は creatives[].id を参照する小文字英数字"),
    initialState: z.enum(["paused", "active"]).default("paused"),
  })
  .strict();

export type Ad = z.infer<typeof AdSchema>;

export const AdsetSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(ID_REGEX, "adset id は小文字英数字 / アンダースコア / ハイフン (先頭は英数字)"),
    name: z.string().min(1),
    initialState: z.enum(["paused", "active"]).default("paused"),
    /** adset 単位で予算を切り直す場合のみ。未指定なら親 campaign 予算で配信。 */
    budget: BudgetSchema.optional(),
    targeting: TargetingSchema.default({
      countries: [],
      interests: [],
      customAudiences: [],
    }),
    ads: z.array(AdSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.ads.length; i += 1) {
      const id = value.ads[i]!.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ads", i, "id"],
          message: `duplicate ad id: ${id}`,
        });
      }
      seen.add(id);
    }
  });

export type Adset = z.infer<typeof AdsetSchema>;

export const CreativeSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(ID_REGEX, "creative id は小文字英数字 / アンダースコア / ハイフン (先頭は英数字)"),
    name: z.string().min(1),
    mediaType: z.enum(["image", "video", "carousel", "text"]),
    headline: z.string().min(1).optional(),
    primaryText: z.string().min(1).optional(),
    callToAction: z
      .enum([
        "LEARN_MORE",
        "SHOP_NOW",
        "SIGN_UP",
        "DOWNLOAD",
        "BOOK_TRAVEL",
        "CONTACT_US",
        "SUBSCRIBE",
        "APPLY_NOW",
        "GET_QUOTE",
      ])
      .optional(),
    /** ローカル storage に保存された素材の相対パス。the current implementation では参照のみ。 */
    storageKey: z.string().min(1).optional(),
  })
  .strict();

export type Creative = z.infer<typeof CreativeSchema>;

export const GuardrailsSchema = z
  .object({
    /** 1 キャンペーンあたり許容する dailyUsd の上限 (これを超える plan は plan error)。 */
    maxDailyUsdPerCampaign: z.number().int().positive().optional(),
    /** 同 lifetimeUsd の上限。 */
    maxLifetimeUsdPerCampaign: z.number().int().positive().optional(),
    /** Targeting で許容する国コード。空配列なら制限なし。 */
    allowedCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/, "country は ISO 3166-1 alpha-2"))
      .default([]),
    /** 禁止 interests (大小区別なし、先頭末尾空白除去)。 */
    bannedInterests: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Guardrails = z.infer<typeof GuardrailsSchema>;

export const ExperimentVariantSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(ID_REGEX, "variant id は小文字英数字 / アンダースコア / ハイフン (先頭は英数字)"),
    /** この variant に紐付く adset id 集合。空は不可。 */
    adsetIds: z.array(z.string().min(1)).min(1),
    /** 配信比率 (1..100、合計は plan 側で 100 を要求)。 */
    weight: z.number().int().min(1).max(100),
  })
  .strict();

export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>;

export const ExperimentSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(ID_REGEX, "experiment id は小文字英数字 / アンダースコア / ハイフン (先頭は英数字)"),
    name: z.string().min(1),
    /** 親 campaign id への参照。 */
    campaignId: z.string().min(1),
    variants: z.array(ExperimentVariantSchema).min(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.variants.length; i += 1) {
      const id = value.variants[i]!.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants", i, "id"],
          message: `duplicate variant id: ${id}`,
        });
      }
      seen.add(id);
    }
  });

export type Experiment = z.infer<typeof ExperimentSchema>;

export const CampaignSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        ID_REGEX,
        "campaign id は小文字英数字 / アンダースコア / ハイフン (先頭は英数字)"
      ),
    name: z.string().min(1),
    objective: CampaignObjectiveSchema,
    /**
     * the current implementation の安全弁: 初回 apply 時は必ず paused で生成し、人間の確認を経て
     * `addroid activate` 相当の別経路で active 化させる。
     */
    initialState: z.enum(["paused", "active"]).default("paused"),
    budget: BudgetSchema,
    adsets: z.array(AdsetSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.adsets.length; i += 1) {
      const id = value.adsets[i]!.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adsets", i, "id"],
          message: `duplicate adset id: ${id}`,
        });
      }
      seen.add(id);
    }
  });

export type Campaign = z.infer<typeof CampaignSchema>;

export const BrandYamlSchema = z
  .object({
    version: z.literal(1),
    account: z
      .object({
        key: z
          .string()
          .min(1)
          .regex(
            /^[a-z0-9_-]+$/,
            "account.key は小文字英数字 / アンダースコア / ハイフン"
          ),
        displayName: z.string().min(1),
        metaAccountId: z.string().optional(),
      })
      .strict(),
    guardrails: GuardrailsSchema.optional(),
    campaigns: z.array(CampaignSchema).default([]),
    creatives: z.array(CreativeSchema).default([]),
    experiments: z.array(ExperimentSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenIds = new Set<string>();
    for (let i = 0; i < value.campaigns.length; i += 1) {
      const id = value.campaigns[i]!.id;
      if (seenIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["campaigns", i, "id"],
          message: `duplicate campaign id: ${id}`,
        });
      }
      seenIds.add(id);
    }
    const seenCreatives = new Set<string>();
    for (let i = 0; i < value.creatives.length; i += 1) {
      const id = value.creatives[i]!.id;
      if (seenCreatives.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["creatives", i, "id"],
          message: `duplicate creative id: ${id}`,
        });
      }
      seenCreatives.add(id);
    }
    const seenExperiments = new Set<string>();
    for (let i = 0; i < value.experiments.length; i += 1) {
      const id = value.experiments[i]!.id;
      if (seenExperiments.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["experiments", i, "id"],
          message: `duplicate experiment id: ${id}`,
        });
      }
      seenExperiments.add(id);
    }
  });

export type BrandYaml = z.infer<typeof BrandYamlSchema>;

// ---- 整合性チェック ------------------------------------------------------

export interface AdsPathContext {
  /** ads/accounts/<key>/brand.yaml の <key> 部分。ファイル位置から取得した値。 */
  expectedAccountKey: string;
}

export class AdsValidationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "AdsValidationError";
    this.issues = issues;
  }
}

/**
 * brand.yaml の `account.key` がファイルパスと一致するか検証する。
 * 不整合の場合は `AdsValidationError` を投げる。
 */
export function assertBrandYamlPathMatches(
  yaml: BrandYaml,
  ctx: AdsPathContext
): void {
  if (yaml.account.key !== ctx.expectedAccountKey) {
    throw new AdsValidationError(
      `account.key (${yaml.account.key}) does not match path key (${ctx.expectedAccountKey})`,
      [`account.key=${yaml.account.key}`, `path.key=${ctx.expectedAccountKey}`]
    );
  }
}

/**
 * 「初期 active キャンペーン作成は禁止」チェック。
 * `previousIds` を渡すと、その集合に含まれない (= 新規作成された) キャンペーンのみ
 * `initialState` をチェックする。the current implementation の skeleton では
 * 「過去の状態は不明 → 全件チェック」がデフォルト。
 */
export function assertInitialCampaignsArePaused(
  yaml: BrandYaml,
  options: { previousIds?: ReadonlySet<string> } = {}
): void {
  const previousIds = options.previousIds ?? new Set<string>();
  for (let i = 0; i < yaml.campaigns.length; i += 1) {
    const c = yaml.campaigns[i]!;
    if (previousIds.has(c.id)) continue;
    if (c.initialState !== "paused") {
      throw new AdsValidationError(
        `campaigns[${i}] (${c.id}) must have initialState: "paused" on first apply`,
        [`index=${i}`, `id=${c.id}`, `initialState=${c.initialState}`]
      );
    }
  }
}

/**
 * 安全でない予算変更を弾く。dailyUsd / lifetimeUsd の双方を対称に扱う。
 *  - 新規キャンペーン (previous=null): 絶対上限のみ schema で済んでいるため、ここでは
 *    宣言された予算フィールド (dailyUsd / lifetimeUsd) が `> 0` であることのみ確認する
 *    (= 完全 0 で active 化していないか)。
 *  - 既存キャンペーン: dailyUsd / lifetimeUsd のいずれかを `BUDGET_INCREASE_RATIO_LIMIT`
 *    倍より増やす変更を unsafe とする。
 *  - 既存キャンペーン: dailyUsd / lifetimeUsd を 0 に落とす変更も unsafe
 *    (停止は initialState 経由で表現すべき)。
 */
export function assertBudgetChangeIsSafe(
  previous: Budget | null,
  next: Budget
): void {
  if (next.dailyUsd === undefined && next.lifetimeUsd === undefined) {
    throw new AdsValidationError(
      "budget must declare dailyUsd or lifetimeUsd",
      ["budget=empty"]
    );
  }
  if (previous === null) {
    if (next.dailyUsd !== undefined && next.dailyUsd <= 0) {
      throw new AdsValidationError(
        "initial dailyUsd must be > 0",
        [`dailyUsd=${next.dailyUsd}`]
      );
    }
    if (next.lifetimeUsd !== undefined && next.lifetimeUsd <= 0) {
      throw new AdsValidationError(
        "initial lifetimeUsd must be > 0",
        [`lifetimeUsd=${next.lifetimeUsd}`]
      );
    }
    return;
  }
  assertBudgetFieldChangeIsSafe(
    "dailyUsd",
    previous.dailyUsd,
    next.dailyUsd
  );
  assertBudgetFieldChangeIsSafe(
    "lifetimeUsd",
    previous.lifetimeUsd,
    next.lifetimeUsd
  );
}

function assertBudgetFieldChangeIsSafe(
  field: "dailyUsd" | "lifetimeUsd",
  previousValue: number | undefined,
  nextValue: number | undefined
): void {
  if (
    previousValue !== undefined &&
    nextValue !== undefined &&
    previousValue > 0 &&
    nextValue === 0
  ) {
    throw new AdsValidationError(
      `${field} cannot be reduced to 0 — pause the campaign via initialState instead`,
      [`previous.${field}=${previousValue}`, `next.${field}=${nextValue}`]
    );
  }
  if (
    previousValue !== undefined &&
    nextValue !== undefined &&
    previousValue > 0 &&
    nextValue > previousValue * BUDGET_INCREASE_RATIO_LIMIT
  ) {
    throw new AdsValidationError(
      `${field} increase exceeds ${BUDGET_INCREASE_RATIO_LIMIT}x previous (${previousValue} → ${nextValue})`,
      [
        `previous.${field}=${previousValue}`,
        `next.${field}=${nextValue}`,
        `limit_ratio=${BUDGET_INCREASE_RATIO_LIMIT}`,
      ]
    );
  }
}

// ---- workflows/budget-guard.yaml (this implementation) -------------------

// `evaluateBudgetGuardPolicy` (packages/queue) が参照する 5 種類のしきい値を
// 表現する。すべて optional / 0 = 無効。
//
// 例:
//   alerts:
//     dailyBudgetAlertRatio: 0.8     # 当日 spend / dailyBudget >= 0.8 で alert
//     monthlyPaceRatio:      1.0     # MTD spend / 月予算 prorated >= 1.0 で alert
//     dayOverDayRatio:       1.5     # todaySpend / yesterdaySpend >= 1.5 で alert
//     noConversionsSpendMin: 5000    # CV=0 かつ todaySpend >= 5000 で alert
//   autoPause:
//     enabled: false                 # true のときのみ auto_pause 候補を生成
//     minDailyBudgetRatio:  1.5
//     minDayOverDayRatio:   2.0
//     safeCategories: ["auto_pause"] # audit agent が auto_approve できる category 群
//
// 既定: ファイルが存在しない場合 (= ops repo に未配置) は worker 側で
// fail-closed (= `policy_missing` status) として扱う。
export const BudgetGuardPolicyAlertsSchema = z
  .object({
    dailyBudgetAlertRatio: z.number().nonnegative().optional(),
    monthlyPaceRatio: z.number().nonnegative().optional(),
    dayOverDayRatio: z.number().nonnegative().optional(),
    noConversionsSpendMin: z.number().nonnegative().optional(),
  })
  .strict();

export const BudgetGuardAutoPauseSchema = z
  .object({
    enabled: z.boolean(),
    minDailyBudgetRatio: z.number().nonnegative().optional(),
    minDayOverDayRatio: z.number().nonnegative().optional(),
    safeCategories: z.array(z.string().min(1)).default([]),
  })
  .strict();

// Optional per-account budgets (currency major unit). worker は ad_accounts.key
// と一致するキーを参照し、daily_budget_80 / monthly_pace 評価で使う。
// 未指定の account は budget=0 として扱われ、それらの 2 ルールは静かに skip。
export const BudgetGuardAccountBudgetSchema = z
  .object({
    dailyBudget: z.number().nonnegative().default(0),
    monthlyBudget: z.number().nonnegative().default(0),
    currency: z.string().min(1).optional(),
  })
  .strict();

export const BudgetGuardPolicyYamlSchema = z
  .object({
    version: z.literal(1),
    alerts: BudgetGuardPolicyAlertsSchema.default({}),
    autoPause: BudgetGuardAutoPauseSchema.optional(),
    accounts: z.record(BudgetGuardAccountBudgetSchema).default({}),
  })
  .strict();

export type BudgetGuardPolicyYaml = z.infer<typeof BudgetGuardPolicyYamlSchema>;

// ---- ops repo loader -----------------------------------------------------

export interface OpsRepoLayout {
  projectYaml: string; // .addroid/project.yaml
  cronYaml: string; // workflows/cron.yaml
  budgetGuardYaml: string; // workflows/budget-guard.yaml (the current implementation)
  accountsDir: string; // ads/accounts
}

export const DEFAULT_OPS_REPO_LAYOUT: OpsRepoLayout = {
  projectYaml: ".addroid/project.yaml",
  cronYaml: "workflows/cron.yaml",
  budgetGuardYaml: "workflows/budget-guard.yaml",
  accountsDir: "ads/accounts",
};

/**
 * `loadBudgetGuardPolicy` — ops repo から `workflows/budget-guard.yaml` を
 * lenient に読み込む。ファイルが存在しない / 不正なら null を返し、worker は
 * fail-closed (`policy_missing`) として扱う。
 */
export function loadBudgetGuardPolicy(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): BudgetGuardPolicyYaml | null {
  const abs = path.join(rootDir, layout.budgetGuardYaml);
  if (!fs.existsSync(abs)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return null;
  }
  const out = BudgetGuardPolicyYamlSchema.safeParse(parsed);
  if (!out.success) return null;
  return out.data;
}

export interface ValidationFinding {
  file: string;
  /** 0-based line/column when known. file-level findings には付かない */
  pointer?: string;
  message: string;
}

export interface OpsRepoValidationResult {
  ok: boolean;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  loaded: {
    project?: ProjectYaml;
    cron?: CronYaml;
    brands: Array<{
      relPath: string;
      accountKey: string;
      brand: BrandYaml;
    }>;
  };
}

/**
 * 比較対象となる「前回 / base 状態」。
 *
 * the current implementation の skeleton では brand.yaml の集合のみを保持する。
 * `accountKey -> BrandYaml` の Map を介して、target 側の各キャンペーンに
 * 対応する previous budget / 既存 id を引ける。
 */
export interface PreviousOpsRepoState {
  brands: Map<string, BrandYaml>;
}

/**
 * base ディレクトリ (例えば PR の base ブランチを worktree で取得したもの) から
 * 前回 brand.yaml を lenient に読み込み、budget / initialState 比較に使える形で返す。
 *
 * - 読み込めない / 壊れている / schema を満たさない brand は単に無視する。
 *   (base が壊れていることは validate の責務ではなく、target 側の不整合検出を阻害しない)
 * - account.key とパスの不整合がある base も「previous なし」として扱う。
 */
export function loadPreviousOpsRepoState(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): PreviousOpsRepoState {
  const brands = new Map<string, BrandYaml>();
  const accountsDirAbs = path.join(rootDir, layout.accountsDir);
  if (!fs.existsSync(accountsDirAbs)) return { brands };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(accountsDirAbs, { withFileTypes: true });
  } catch {
    return { brands };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const accountKey = entry.name;
    const brandAbs = path.join(accountsDirAbs, accountKey, "brand.yaml");
    if (!fs.existsSync(brandAbs)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(brandAbs, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      continue;
    }
    const out = BrandYamlSchema.safeParse(parsed);
    if (!out.success) continue;
    if (out.data.account.key !== accountKey) continue;
    brands.set(accountKey, out.data);
  }
  return { brands };
}

export interface LoadAndValidateOptions {
  /**
   * 前回 / base 状態。指定されたとき、target 側の各キャンペーンは
   *   - id が previous に含まれていれば既存扱い (initialState=active を許容)
   *   - 既存 budget との比較で安全性チェック
   * を行う。指定されなければ「全件新規」として従来通りの挙動。
   */
  previous?: PreviousOpsRepoState;
}

/**
 * Ops repo (ユーザーの GitOps リポジトリ、もしくは AdDroid 本体内 fixture) を走査し、
 * 全 YAML ファイルを Zod スキーマと整合性チェックでまとめて検証する。
 *
 * 失敗時も throw せず、`errors` 配列に詰めて結果を返す。CLI 側は exit code を
 * `errors.length > 0` で決める。
 */
export function loadAndValidateOpsRepo(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT,
  options: LoadAndValidateOptions = {}
): OpsRepoValidationResult {
  const result: OpsRepoValidationResult = {
    ok: true,
    errors: [],
    warnings: [],
    loaded: { brands: [] },
  };

  // project.yaml
  const projectPath = path.join(rootDir, layout.projectYaml);
  if (!fs.existsSync(projectPath)) {
    result.errors.push({
      file: layout.projectYaml,
      message: "missing required file",
    });
  } else {
    const parsed = parseYamlFileSafely(projectPath, layout.projectYaml, result);
    if (parsed !== undefined) {
      const out = ProjectYamlSchema.safeParse(parsed);
      if (out.success) {
        result.loaded.project = out.data;
      } else {
        for (const issue of out.error.issues) {
          result.errors.push(zodIssueToFinding(layout.projectYaml, issue));
        }
      }
    }
  }

  // workflows/cron.yaml
  const cronPath = path.join(rootDir, layout.cronYaml);
  if (!fs.existsSync(cronPath)) {
    result.errors.push({
      file: layout.cronYaml,
      message: "missing required file",
    });
  } else {
    const parsed = parseYamlFileSafely(cronPath, layout.cronYaml, result);
    if (parsed !== undefined) {
      const out = CronYamlSchema.safeParse(parsed);
      if (out.success) {
        result.loaded.cron = out.data;
        // github_poll は the current implementation で必須プリセット
        if (
          !out.data.schedules.some(
            (s) => s.name === "github_poll" && s.enabled
          )
        ) {
          result.warnings.push({
            file: layout.cronYaml,
            message:
              "github_poll が enabled で登録されていません。merged PR の検出が機能しない可能性があります。",
          });
        }
      } else {
        for (const issue of out.error.issues) {
          result.errors.push(zodIssueToFinding(layout.cronYaml, issue));
        }
      }
    }
  }

  // ads/accounts/<key>/brand.yaml
  const accountsDirAbs = path.join(rootDir, layout.accountsDir);
  if (!fs.existsSync(accountsDirAbs)) {
    result.errors.push({
      file: layout.accountsDir,
      message: "missing accounts directory",
    });
  } else {
    const entries = fs.readdirSync(accountsDirAbs, { withFileTypes: true });
    if (entries.length === 0) {
      result.warnings.push({
        file: layout.accountsDir,
        message: "no accounts present",
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const accountKey = entry.name;
      const brandRel = path.posix.join(
        layout.accountsDir,
        accountKey,
        "brand.yaml"
      );
      const brandAbs = path.join(accountsDirAbs, accountKey, "brand.yaml");
      if (!fs.existsSync(brandAbs)) {
        result.errors.push({
          file: brandRel,
          message: "missing brand.yaml for account",
        });
        continue;
      }
      const parsed = parseYamlFileSafely(brandAbs, brandRel, result);
      if (parsed === undefined) continue;
      const out = BrandYamlSchema.safeParse(parsed);
      if (!out.success) {
        for (const issue of out.error.issues) {
          result.errors.push(zodIssueToFinding(brandRel, issue));
        }
        continue;
      }
      const brand = out.data;
      try {
        assertBrandYamlPathMatches(brand, { expectedAccountKey: accountKey });
      } catch (err) {
        if (err instanceof AdsValidationError) {
          result.errors.push({ file: brandRel, message: err.message });
          continue;
        }
        throw err;
      }
      const previousBrand = options.previous?.brands.get(accountKey);
      const previousCampaignsById = new Map<string, Campaign>();
      if (previousBrand) {
        for (const pc of previousBrand.campaigns) {
          previousCampaignsById.set(pc.id, pc);
        }
      }
      const previousIds = new Set(previousCampaignsById.keys());
      try {
        assertInitialCampaignsArePaused(brand, { previousIds });
      } catch (err) {
        if (err instanceof AdsValidationError) {
          result.errors.push({ file: brandRel, message: err.message });
          continue;
        }
        throw err;
      }
      // 既存キャンペーンは previous budget と比較、新規キャンペーンは previous=null。
      for (let i = 0; i < brand.campaigns.length; i += 1) {
        const c = brand.campaigns[i]!;
        const prev = previousCampaignsById.get(c.id) ?? null;
        try {
          assertBudgetChangeIsSafe(prev ? prev.budget : null, c.budget);
        } catch (err) {
          if (err instanceof AdsValidationError) {
            result.errors.push({
              file: brandRel,
              pointer: `campaigns[${i}].budget`,
              message: err.message,
            });
            continue;
          }
          throw err;
        }
      }
      result.loaded.brands.push({ relPath: brandRel, accountKey, brand });
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

function parseYamlFileSafely(
  absPath: string,
  relPath: string,
  result: OpsRepoValidationResult
): unknown | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    result.errors.push({
      file: relPath,
      message: `読み込み失敗: ${(err as Error).message}`,
    });
    return undefined;
  }
  try {
    return YAML.parse(raw);
  } catch (err) {
    result.errors.push({
      file: relPath,
      message: `YAML パースエラー: ${(err as Error).message}`,
    });
    return undefined;
  }
}

function zodIssueToFinding(file: string, issue: ZodIssue): ValidationFinding {
  const pointer = issue.path.length > 0 ? issue.path.join(".") : undefined;
  return {
    file,
    ...(pointer ? { pointer } : {}),
    message: issue.message,
  };
}

export {
  buildExecutionPlan,
  type ExecutionPlan,
  type PlanAction,
  type PlanActionKind,
  type PlanFinding,
  type CreateCampaignAction,
  type UpdateCampaignAction,
  type DeleteCampaignAction,
  type CreateAdsetAction,
  type UpdateAdsetAction,
  type DeleteAdsetAction,
  type CreateAdAction,
  type UpdateAdAction,
  type DeleteAdAction,
  type CreateCreativeAction,
  type UpdateCreativeAction,
  type DeleteCreativeAction,
  type CreateExperimentAction,
  type UpdateExperimentAction,
  type DeleteExperimentAction,
} from "./plan.js";

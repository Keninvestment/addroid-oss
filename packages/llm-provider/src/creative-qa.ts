// AdDroid OSS — Creative QA (Implementation item).
//
// 画像 Provider が返した `ImageGeneratedAsset[]` に対し、PR 添付前に必ず
// 通る 5 種の決定論的検査を実装する:
//
//   1. dimensions           — width / height / aspect_ratio / 短辺最低値
//   2. format               — MIME type / 拡張子整合
//   3. quality              — byte size 上下限 / Provider quality score
//   4. forbidden_expression — prompt / styleNotes / OCR テキストに対する
//                              禁止語マッチ
//   5. brand_tone           — prompt / styleNotes に対するブランドガイド整合
//
// 設計原則:
//   - 副作用なし。Prisma も外部ネットワークも触らない。worker / route handler
//     から `evaluateCreativeQa(...)` を直接呼べる純関数。
//   - LLM 呼び出しは行わない。本モジュールは LLM ベースの prompt-level audit
//     (`runCreativeQaAgent`) とは別物で、生成された **アセットそのもの** に対する
//     確定的な検査を担当する。LLM が落ちている / Provider が落ちている状況でも
//     QA は走る。
//   - 各 check は per-check の outcome (pass / warn / fail / skipped) と
//     evidence を返す。UI は「⚠ 1 issue」のような単一 verdict で隠蔽せず、
//     必ず per-check 展開で見せる (UI design plan §3, principle 25)。
//   - 失敗の severity は workspace_settings.creativeQaPolicy で上書き可能。
//     既定値は UI design plan の `default_severity` と整合させる (blocking:
//     dimensions / format / forbidden_expression、non_blocking: quality /
//     brand_tone)。
//   - prompt / 禁止語 / 検出テキストは sanitize 済みの想定だが、evidence 文字列
//     を組み立てる際にも token-shaped substring を [REDACTED] に置換する
//     (defense-in-depth)。
//   - severity="info_only" の check は、outcome が fail でも overall を
//     qa_failed/qa_warned に降格させない。あくまで観測用。
//
// 統合補助:
//   - `generateAndQaCreative()` は ImageProvider.generateImage を 1 度呼び、
//     成功時は per-asset の Creative QA を走らせ、失敗時は fallback_text_only
//     を返す (the current implementation principle 27 "Provider 失敗は workflow 失敗ではない")。

import {
  ImageProviderError,
  ImageProviderNotConfiguredError,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImageProvider,
} from "./image-provider.js";
import type { ImagePromptVariant } from "./agents.js";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export const CREATIVE_QA_CHECK_KINDS = [
  "dimensions",
  "format",
  "quality",
  "forbidden_expression",
  "brand_tone",
] as const;
export type CreativeQaCheckKind = (typeof CREATIVE_QA_CHECK_KINDS)[number];

export const CREATIVE_QA_OUTCOMES = ["pass", "warn", "fail", "skipped"] as const;
export type CreativeQaOutcome = (typeof CREATIVE_QA_OUTCOMES)[number];

export const CREATIVE_QA_SEVERITIES = [
  "blocking",
  "non_blocking",
  "info_only",
] as const;
export type CreativeQaSeverity = (typeof CREATIVE_QA_SEVERITIES)[number];

export const CREATIVE_QA_OVERALL_OUTCOMES = [
  "qa_passed",
  "qa_warned",
  "qa_failed",
] as const;
export type CreativeQaOverallOutcome = (typeof CREATIVE_QA_OVERALL_OUTCOMES)[number];

/**
 * UI design plan の `default_severity` と整合する既定値。
 * workspace_settings.creativeQaPolicy で上書き可能。
 */
export const DEFAULT_CREATIVE_QA_SEVERITY: Readonly<
  Record<CreativeQaCheckKind, CreativeQaSeverity>
> = Object.freeze({
  dimensions: "blocking",
  format: "blocking",
  quality: "non_blocking",
  forbidden_expression: "blocking",
  brand_tone: "non_blocking",
});

/**
 * Provider が起動した時点では QA を走らせなくても済む「fallback_text_only」
 * を表す sentinel。`generateAndQaCreative` の戻り値で利用する。
 */
export const CREATIVE_QA_FALLBACK_TEXT_ONLY = "fallback_text_only" as const;

/**
 * regression fix: Production で `runImprovementPrOnce` が `creativeQaPolicy` を
 * 明示しなかった場合に適用される **非空の既定 policy**。
 *
 * the current implementation acceptance "Creative QA checks dimensions, format, quality,
 * forbidden expressions, and brand-tone constraints before PR attachment"
 * は、空 policy で全 check が `skipped` に倒れて素通りする状況を許容しない。
 * 本 constant は dimensions / format / quality / forbiddenExpression / brandTone
 * のすべてに対して最低限のガードを設定し、workspace_settings.creativeQaPolicy
 * 等で上書き可能であることを前提としている。
 *
 * 値の意図:
 *   - dimensions: Meta primary placements (feed square / landscape / portrait /
 *     stories) の aspect ratio をホワイトリスト + 短辺最低/長辺最大で枠取り。
 *   - format: PNG/JPEG のみを許可 (Provider 抽象が返す 2 形式)。
 *   - quality: 単一ピクセル PNG / 30MB 超過を弾く Meta 互換のサイズレンジ。
 *     Codex 生成の 1080px PNG は 1.5MB を自然に超えることがあるため、
 *     default では独自の推奨上限 warning を置かず、Meta 互換の hard max のみを見る。
 *   - forbiddenExpression: 業界共通の確証広告表現 (絶対保証 / miracle cure 等)。
 *     workspace 固有の禁止語は workspace_settings から追加で重ねる想定。
 *   - brandTone: 攻撃的/扇情的トーンを fail で防ぐ最小セット。
 *
 * `severityOverrides` は付けない。`DEFAULT_CREATIVE_QA_SEVERITY` (blocking:
 * dimensions / format / forbidden_expression、non_blocking: quality /
 * brand_tone) がそのまま効く。
 */
export const DEFAULT_CREATIVE_QA_POLICY: CreativeQaPolicy = {
  dimensions: {
    aspectRatios: ["1:1", "1.91:1", "4:5", "9:16"],
    minShortSidePx: 320,
    maxSidePx: 4096,
  },
  format: {
    allowedMimeTypes: ["image/png", "image/jpeg"],
  },
  quality: {
    minByteSize: 64,
    maxByteSize: 30_000_000,
  },
  forbiddenExpression: {
    terms: [
      "guaranteed",
      "100% guaranteed",
      "guaranteed results",
      "miracle cure",
      "click here",
      "保証します",
      "必ず儲かる",
      "ここをクリック",
    ],
  },
  brandTone: {
    forbiddenTones: [
      "aggressive",
      "shocking",
      "煽り",
      "scam",
      "miracle",
    ],
  },
};

// ---------------------------------------------------------------------------
// Policy 型
// ---------------------------------------------------------------------------

export interface DimensionAllowedSize {
  width: number;
  height: number;
  /** 表示用ラベル (例: "1:1 feed square")。任意。 */
  label?: string;
}

export interface DimensionPolicy {
  /**
   * 完全一致で通すサイズ。1 件以上ヒットすれば pass。空配列でも
   * `aspectRatios` / `minShortSidePx` / `maxSidePx` のいずれかが指定されていれば
   * dimensions check は走る。
   */
  allowed?: DimensionAllowedSize[];
  /**
   * 許容アスペクト比 (例: ["1:1", "4:5", "1.91:1"])。比率は文字列 "W:H" で
   * 受け取り、`width / height` と一致する (tolerance 内) なら pass。
   */
  aspectRatios?: string[];
  /** Aspect ratio 比較時の許容差 (相対誤差)。既定 0.02 (= 2%)。 */
  aspectTolerance?: number;
  /** 短辺の最低画素数 (例: 600)。これ未満は fail。 */
  minShortSidePx?: number;
  /** 単辺の最大画素数 (例: 4096)。超過は fail。 */
  maxSidePx?: number;
}

export interface FormatPolicy {
  /**
   * 許容 MIME type。省略時は ["image/png", "image/jpeg"]。
   * Provider abstraction で扱える 2 種類のみが既定。
   */
  allowedMimeTypes?: string[];
}

export interface QualityPolicy {
  /** これ未満の byteSize は fail (single-pixel / 破損 PNG 検出)。 */
  minByteSize?: number;
  /** 推奨上限を超えると warn。fail にはしない。 */
  recommendedMaxByteSize?: number;
  /** 絶対上限を超えると fail。Meta 配信限界 30MB を超えていないか等。 */
  maxByteSize?: number;
  /**
   * Provider が報告する quality score (0..1)。これ未満で fail。
   * `providerQualityScore` が input に含まれない場合は skipped。
   */
  minProviderQualityScore?: number;
}

export interface ForbiddenExpressionPolicy {
  /** 禁止語句 (literal substring)。 */
  terms: string[];
  /** 既定は false (case-insensitive)。 */
  caseSensitive?: boolean;
}

export interface BrandTonePolicy {
  /**
   * 含まれていてほしい keyword 群。1 つもヒットしなければ warn。空 / 未指定なら
   * このサブチェックは走らない。
   */
  recommendedKeywords?: string[];
  /** 含まれていたら fail にしたい単語 (例: "アグレッシブ" "煽り")。 */
  forbiddenTones?: string[];
  /** 既定は false (case-insensitive)。 */
  caseSensitive?: boolean;
}

export interface CreativeQaPolicy {
  dimensions?: DimensionPolicy;
  format?: FormatPolicy;
  quality?: QualityPolicy;
  forbiddenExpression?: ForbiddenExpressionPolicy;
  brandTone?: BrandTonePolicy;
  /** 既定 severity を check 単位で上書きする。 */
  severityOverrides?: Partial<Record<CreativeQaCheckKind, CreativeQaSeverity>>;
}

// ---------------------------------------------------------------------------
// 入出力
// ---------------------------------------------------------------------------

export interface CreativeQaAssetInput {
  asset: ImageGeneratedAsset;
  /**
   * Image Prompt Agent の variant。forbidden_expression / brand_tone に使う
   * テキスト材料を引く。null/undefined 可 (mock / minimal 経路で使う)。
   */
  variant?: ImagePromptVariant | null;
  /**
   * 画像内テキスト (OCR / Vision LLM 由来)。本モジュールは OCR 自体を
   * 行わないため、外部から渡される sanitize 済み文字列のみ受け取る。
   */
  detectedText?: string | null;
  /** Provider 報告の quality score (0..1)。 */
  providerQualityScore?: number | null;
}

export interface CreativeQaCheckResult {
  kind: CreativeQaCheckKind;
  severity: CreativeQaSeverity;
  outcome: CreativeQaOutcome;
  /** 1 行の人間可読サマリ。UI のチェック行に表示される。 */
  detail: string;
  /** 詳細根拠 (例: "matched term: 'sale 80% off'")。空ならば null。 */
  evidence: string | null;
}

export interface CreativeQaAssetResult {
  variantKey: string;
  width: number;
  height: number;
  byteSize: number;
  mimeType: string;
  checks: CreativeQaCheckResult[];
  overall: CreativeQaOverallOutcome;
}

export interface CreativeQaBatchResult {
  /** Per-asset の評価。 */
  assets: CreativeQaAssetResult[];
  /** Batch 全体の集約 outcome (1 つでも qa_failed があれば qa_failed)。 */
  overall: CreativeQaOverallOutcome;
  /** overall ∈ {qa_passed, qa_warned} の asset 数 (PR 添付候補)。 */
  passingCount: number;
  /** overall === "qa_failed" の asset 数。 */
  failingCount: number;
}

// ---------------------------------------------------------------------------
// 単一 asset 評価
// ---------------------------------------------------------------------------

export function evaluateCreativeQa(
  input: CreativeQaAssetInput,
  policy: CreativeQaPolicy = {}
): CreativeQaAssetResult {
  const checks: CreativeQaCheckResult[] = [
    evaluateDimensions(input, policy),
    evaluateFormat(input, policy),
    evaluateQuality(input, policy),
    evaluateForbiddenExpression(input, policy),
    evaluateBrandTone(input, policy),
  ];

  return {
    variantKey: input.asset.variantKey,
    width: input.asset.width,
    height: input.asset.height,
    byteSize: input.asset.byteSize,
    mimeType: input.asset.mimeType,
    checks,
    overall: aggregateOverall(checks),
  };
}

export function evaluateCreativeQaBatch(
  inputs: readonly CreativeQaAssetInput[],
  policy: CreativeQaPolicy = {}
): CreativeQaBatchResult {
  const assets = inputs.map((i) => evaluateCreativeQa(i, policy));
  let failing = 0;
  let passing = 0;
  let anyWarn = false;
  for (const a of assets) {
    if (a.overall === "qa_failed") failing += 1;
    else passing += 1;
    if (a.overall === "qa_warned") anyWarn = true;
  }
  let overall: CreativeQaOverallOutcome;
  if (failing > 0) overall = "qa_failed";
  else if (anyWarn) overall = "qa_warned";
  else overall = "qa_passed";

  return {
    assets,
    overall,
    passingCount: passing,
    failingCount: failing,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateOverall(
  checks: readonly CreativeQaCheckResult[]
): CreativeQaOverallOutcome {
  let anyBlockingFail = false;
  let anyWarnLike = false;
  for (const c of checks) {
    if (c.severity === "info_only") continue; // 観測用。overall に影響しない。
    if (c.outcome === "fail") {
      if (c.severity === "blocking") {
        anyBlockingFail = true;
      } else {
        anyWarnLike = true;
      }
    } else if (c.outcome === "warn") {
      anyWarnLike = true;
    } else if (c.outcome === "skipped") {
      // regression fix: "generated assets with skipped required checks must
      // not be attachable" を aggregator で強制する。`blocking` severity check
      // が policy 未設定 / haystack 欠落で `skipped` に倒れた場合、当該 asset
      // は qa_failed として扱い、PR 添付経路から外す (queue/improvement-pr
      // の `attachableCreativeAttachments` filter が status='qa_failed' を弾く
      // 既存実装と接続する)。`non_blocking` / `info_only` の skipped は
      // 引き続き overall に影響しない。
      if (c.severity === "blocking") {
        anyBlockingFail = true;
      }
    }
  }
  if (anyBlockingFail) return "qa_failed";
  if (anyWarnLike) return "qa_warned";
  return "qa_passed";
}

function severityFor(
  policy: CreativeQaPolicy,
  kind: CreativeQaCheckKind
): CreativeQaSeverity {
  return (
    policy.severityOverrides?.[kind] ??
    DEFAULT_CREATIVE_QA_SEVERITY[kind]
  );
}

// ---------------------------------------------------------------------------
// 1) dimensions
// ---------------------------------------------------------------------------

function evaluateDimensions(
  input: CreativeQaAssetInput,
  policy: CreativeQaPolicy
): CreativeQaCheckResult {
  const severity = severityFor(policy, "dimensions");
  const dim = policy.dimensions;
  const a = input.asset;

  if (
    !dim ||
    ((!dim.allowed || dim.allowed.length === 0) &&
      (!dim.aspectRatios || dim.aspectRatios.length === 0) &&
      dim.minShortSidePx === undefined &&
      dim.maxSidePx === undefined)
  ) {
    return {
      kind: "dimensions",
      severity,
      outcome: "skipped",
      detail: "no dimension policy configured",
      evidence: null,
    };
  }

  // 完全一致が指定されている場合、その集合を最優先で確認する
  if (dim.allowed && dim.allowed.length > 0) {
    const hit = dim.allowed.find(
      (d) => d.width === a.width && d.height === a.height
    );
    if (!hit) {
      const allowedStr = dim.allowed
        .map((d) => (d.label ? `${d.width}x${d.height} (${d.label})` : `${d.width}x${d.height}`))
        .join(", ");
      return {
        kind: "dimensions",
        severity,
        outcome: "fail",
        detail: `expected one of [${allowedStr}], got ${a.width}x${a.height}`,
        evidence: `${a.width}x${a.height}`,
      };
    }
  }

  // aspect ratio
  if (dim.aspectRatios && dim.aspectRatios.length > 0) {
    const tolerance = dim.aspectTolerance ?? 0.02;
    const actualRatio = a.width / a.height;
    let match: { label: string; expected: number } | null = null;
    for (const ar of dim.aspectRatios) {
      const parsed = parseAspectRatio(ar);
      if (parsed === null) continue;
      const rel = Math.abs(actualRatio - parsed) / parsed;
      if (rel <= tolerance) {
        match = { label: ar, expected: parsed };
        break;
      }
    }
    if (match === null) {
      return {
        kind: "dimensions",
        severity,
        outcome: "fail",
        detail: `aspect ratio ${a.width}:${a.height} (~${actualRatio.toFixed(3)}) does not match any of [${dim.aspectRatios.join(", ")}] within tolerance ${tolerance}`,
        evidence: `${a.width}x${a.height}`,
      };
    }
  }

  // short side floor
  if (dim.minShortSidePx !== undefined) {
    const shortSide = Math.min(a.width, a.height);
    if (shortSide < dim.minShortSidePx) {
      return {
        kind: "dimensions",
        severity,
        outcome: "fail",
        detail: `short side ${shortSide}px < required ${dim.minShortSidePx}px`,
        evidence: `${a.width}x${a.height}`,
      };
    }
  }

  // max side ceiling
  if (dim.maxSidePx !== undefined) {
    const longSide = Math.max(a.width, a.height);
    if (longSide > dim.maxSidePx) {
      return {
        kind: "dimensions",
        severity,
        outcome: "fail",
        detail: `long side ${longSide}px > limit ${dim.maxSidePx}px`,
        evidence: `${a.width}x${a.height}`,
      };
    }
  }

  return {
    kind: "dimensions",
    severity,
    outcome: "pass",
    detail: `${a.width}x${a.height}`,
    evidence: null,
  };
}

function parseAspectRatio(s: string): number | null {
  // "1:1", "4:5", "1.91:1", "16:9"
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

// ---------------------------------------------------------------------------
// 2) format
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg"] as const;

function evaluateFormat(
  input: CreativeQaAssetInput,
  policy: CreativeQaPolicy
): CreativeQaCheckResult {
  const severity = severityFor(policy, "format");
  const allowed =
    policy.format?.allowedMimeTypes && policy.format.allowedMimeTypes.length > 0
      ? policy.format.allowedMimeTypes
      : (DEFAULT_ALLOWED_MIME_TYPES as readonly string[]);
  const mime = input.asset.mimeType;
  if (!allowed.includes(mime)) {
    return {
      kind: "format",
      severity,
      outcome: "fail",
      detail: `mime '${mime}' not in [${allowed.join(", ")}]`,
      evidence: mime,
    };
  }
  // PNG signature / JPEG SOI を確認 (defense in depth)
  const sigDetail = checkMagicBytes(input.asset.bytes, mime);
  if (sigDetail !== null) {
    return {
      kind: "format",
      severity,
      outcome: "fail",
      detail: sigDetail,
      evidence: mime,
    };
  }
  return {
    kind: "format",
    severity,
    outcome: "pass",
    detail: mime,
    evidence: null,
  };
}

function checkMagicBytes(bytes: Uint8Array, mime: string): string | null {
  if (mime === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < sig.length) {
      return `bytes too short for PNG signature (got ${bytes.length})`;
    }
    for (let i = 0; i < sig.length; i += 1) {
      if (bytes[i] !== sig[i]) {
        return "bytes do not start with PNG signature";
      }
    }
    return null;
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 3) return `bytes too short for JPEG SOI (got ${bytes.length})`;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return "bytes do not start with JPEG SOI marker";
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3) quality
// ---------------------------------------------------------------------------

function evaluateQuality(
  input: CreativeQaAssetInput,
  policy: CreativeQaPolicy
): CreativeQaCheckResult {
  const severity = severityFor(policy, "quality");
  const q = policy.quality;
  const a = input.asset;

  if (
    !q ||
    (q.minByteSize === undefined &&
      q.recommendedMaxByteSize === undefined &&
      q.maxByteSize === undefined &&
      q.minProviderQualityScore === undefined)
  ) {
    return {
      kind: "quality",
      severity,
      outcome: "skipped",
      detail: "no quality policy configured",
      evidence: null,
    };
  }

  if (q.minByteSize !== undefined && a.byteSize < q.minByteSize) {
    return {
      kind: "quality",
      severity,
      outcome: "fail",
      detail: `byte size ${a.byteSize} < minimum ${q.minByteSize}`,
      evidence: `byteSize=${a.byteSize}`,
    };
  }
  if (q.maxByteSize !== undefined && a.byteSize > q.maxByteSize) {
    return {
      kind: "quality",
      severity,
      outcome: "fail",
      detail: `byte size ${a.byteSize} > hard maximum ${q.maxByteSize}`,
      evidence: `byteSize=${a.byteSize}`,
    };
  }
  if (q.minProviderQualityScore !== undefined) {
    const score = input.providerQualityScore;
    if (typeof score === "number" && Number.isFinite(score)) {
      if (score < q.minProviderQualityScore) {
        return {
          kind: "quality",
          severity,
          outcome: "fail",
          detail: `provider quality score ${score.toFixed(3)} < required ${q.minProviderQualityScore}`,
          evidence: `score=${score}`,
        };
      }
    }
  }
  if (
    q.recommendedMaxByteSize !== undefined &&
    a.byteSize > q.recommendedMaxByteSize
  ) {
    return {
      kind: "quality",
      severity,
      outcome: "warn",
      detail: `byte size ${a.byteSize} > recommended ${q.recommendedMaxByteSize}`,
      evidence: `byteSize=${a.byteSize}`,
    };
  }
  return {
    kind: "quality",
    severity,
    outcome: "pass",
    detail: `byteSize=${a.byteSize}`,
    evidence: null,
  };
}

// ---------------------------------------------------------------------------
// 4) forbidden_expression
// ---------------------------------------------------------------------------

function evaluateForbiddenExpression(
  input: CreativeQaAssetInput,
  policy: CreativeQaPolicy
): CreativeQaCheckResult {
  const severity = severityFor(policy, "forbidden_expression");
  const fe = policy.forbiddenExpression;
  if (!fe || !Array.isArray(fe.terms) || fe.terms.length === 0) {
    return {
      kind: "forbidden_expression",
      severity,
      outcome: "skipped",
      detail: "no forbidden expression policy configured",
      evidence: null,
    };
  }
  const haystack = collectInspectionText(input);
  if (haystack.length === 0) {
    return {
      kind: "forbidden_expression",
      severity,
      outcome: "skipped",
      detail: "no prompt / detected text available",
      evidence: null,
    };
  }
  const caseSensitive = fe.caseSensitive === true;
  const cmpHay = caseSensitive ? haystack : haystack.toLowerCase();
  const matches: string[] = [];
  for (const term of fe.terms) {
    if (typeof term !== "string" || term.length === 0) continue;
    const cmpTerm = caseSensitive ? term : term.toLowerCase();
    if (cmpHay.includes(cmpTerm)) {
      matches.push(term);
    }
  }
  if (matches.length === 0) {
    return {
      kind: "forbidden_expression",
      severity,
      outcome: "pass",
      detail: `no forbidden term matched (${fe.terms.length} terms checked)`,
      evidence: null,
    };
  }
  const evidence = sanitizeEvidence(`matched term(s): ${matches.join(", ")}`);
  return {
    kind: "forbidden_expression",
    severity,
    outcome: "fail",
    detail: `forbidden term(s) detected: ${matches.length}`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 5) brand_tone
// ---------------------------------------------------------------------------

function evaluateBrandTone(
  input: CreativeQaAssetInput,
  policy: CreativeQaPolicy
): CreativeQaCheckResult {
  const severity = severityFor(policy, "brand_tone");
  const bt = policy.brandTone;
  if (
    !bt ||
    ((!Array.isArray(bt.recommendedKeywords) || bt.recommendedKeywords.length === 0) &&
      (!Array.isArray(bt.forbiddenTones) || bt.forbiddenTones.length === 0))
  ) {
    return {
      kind: "brand_tone",
      severity,
      outcome: "skipped",
      detail: "no brand tone policy configured",
      evidence: null,
    };
  }
  const haystack = collectInspectionText(input);
  if (haystack.length === 0) {
    return {
      kind: "brand_tone",
      severity,
      outcome: "skipped",
      detail: "no prompt / detected text available",
      evidence: null,
    };
  }
  const caseSensitive = bt.caseSensitive === true;
  const cmpHay = caseSensitive ? haystack : haystack.toLowerCase();

  // forbiddenTones を最優先 (fail)
  if (Array.isArray(bt.forbiddenTones) && bt.forbiddenTones.length > 0) {
    const hits: string[] = [];
    for (const tone of bt.forbiddenTones) {
      if (typeof tone !== "string" || tone.length === 0) continue;
      const cmpTone = caseSensitive ? tone : tone.toLowerCase();
      if (cmpHay.includes(cmpTone)) hits.push(tone);
    }
    if (hits.length > 0) {
      return {
        kind: "brand_tone",
        severity,
        outcome: "fail",
        detail: `forbidden tone(s) present: ${hits.length}`,
        evidence: sanitizeEvidence(`matched: ${hits.join(", ")}`),
      };
    }
  }

  // recommendedKeywords が無い場合は、forbiddenTones がパスした時点で pass。
  if (!Array.isArray(bt.recommendedKeywords) || bt.recommendedKeywords.length === 0) {
    return {
      kind: "brand_tone",
      severity,
      outcome: "pass",
      detail: "no forbidden tone matched",
      evidence: null,
    };
  }

  const matched: string[] = [];
  for (const kw of bt.recommendedKeywords) {
    if (typeof kw !== "string" || kw.length === 0) continue;
    const cmpKw = caseSensitive ? kw : kw.toLowerCase();
    if (cmpHay.includes(cmpKw)) matched.push(kw);
  }
  if (matched.length === 0) {
    return {
      kind: "brand_tone",
      severity,
      outcome: "warn",
      detail: `none of ${bt.recommendedKeywords.length} recommended keyword(s) matched`,
      evidence: null,
    };
  }
  return {
    kind: "brand_tone",
    severity,
    outcome: "pass",
    detail: `${matched.length}/${bt.recommendedKeywords.length} recommended keyword(s) present`,
    evidence: null,
  };
}

// ---------------------------------------------------------------------------
// 共有 helper
// ---------------------------------------------------------------------------

function collectInspectionText(input: CreativeQaAssetInput): string {
  const parts: string[] = [];
  const v = input.variant ?? null;
  if (v) {
    if (typeof v.prompt === "string") parts.push(v.prompt);
    if (typeof v.styleNotes === "string") parts.push(v.styleNotes);
    if (typeof v.negativePrompt === "string") parts.push(v.negativePrompt);
  }
  if (typeof input.detectedText === "string" && input.detectedText.length > 0) {
    parts.push(input.detectedText);
  }
  return parts.join("\n");
}

/**
 * evidence 文字列内に偶然 access_token / api_key / signed URL らしき
 * substring が紛れた場合の最終 redact。`agents.ts.sanitizeErrorMessage` と
 * 同じパターンに、画像 Provider が返す可能性のある signed URL も追加した。
 */
export function sanitizeEvidence(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-[REDACTED]")
    .replace(/EAA[A-Za-z0-9]{20,}/g, "EAA[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, "xox[REDACTED]")
    .replace(
      /https?:\/\/[^\s]*[?&](?:signature|sig|x-amz-signature|token)=[^\s&]+/gi,
      "[REDACTED-SIGNED-URL]"
    );
}

// ---------------------------------------------------------------------------
// 統合: ImageProvider.generateImage + Creative QA
// ---------------------------------------------------------------------------

export interface GenerateAndQaCreativeOptions {
  provider: ImageProvider;
  request: ImageGenerateRequest;
  /**
   * Image Prompt Agent が出力した variant 配列。length は
   * `request.variationConditions.length` と一致している必要はないが、
   * `variantKey` で対応付ける。一致する key が見つからなかった asset には
   * `variant=null` で QA を走らせる。
   */
  variants?: readonly ImagePromptVariant[];
  policy?: CreativeQaPolicy;
  /** 画像内テキスト (OCR 等) を `variantKey` 経由で渡したい場合の map。 */
  detectedTextByVariantKey?: Readonly<Record<string, string>>;
  /** Provider の quality score を `variantKey` 経由で渡したい場合の map。 */
  providerQualityScoreByVariantKey?: Readonly<Record<string, number>>;
  /**
   * 完了後に `generation.meta.qaResult.qaRef` に書き込む永続参照
   * (例: ai_run id, `storage://...`)。指定なしなら null のまま。
   */
  qaRef?: string | null;
}

export interface GenerateAndQaCreativeResult {
  /** Provider 成功時のみ非 null。失敗時は null。 */
  generation: ImageGenerateResult | null;
  /** Provider 成功時のみ非 null。失敗時は null。 */
  qa: CreativeQaBatchResult | null;
  /**
   * `qa_passed | qa_warned | qa_failed | fallback_text_only`。
   * Provider 失敗時は `fallback_text_only` (the current implementation principle 27)。
   */
  outcome: CreativeQaOverallOutcome | typeof CREATIVE_QA_FALLBACK_TEXT_ONLY;
  /** Provider 失敗時に sanitize 済みのメッセージ。成功時は null。 */
  providerError: string | null;
  /**
   * `provider_not_configured` (stub / 未設定) は Provider 失敗の中でも特に
   * benign idle 状態。UI design plan principle 27 で error と区別される。
   */
  providerErrorKind:
    | null
    | "provider_not_configured"
    | "provider_error"
    | "invalid_request"
    | "unknown";
}

/**
 * ImageProvider 経由で複数バリエーションを生成し、各 asset に対して
 * Creative QA を実行する。Provider 失敗時は `fallback_text_only` outcome を
 * 返し、上位 workflow が prompt-only PR に縮退できるようにする。
 *
 * 失敗の分類:
 *   - `ImageProviderNotConfiguredError`  → providerErrorKind="provider_not_configured"
 *   - `ImageProviderError`               → providerErrorKind="provider_error"
 *   - `ImageProviderInvalidRequestError` → providerErrorKind="invalid_request"
 *   - その他                             → providerErrorKind="unknown"
 *
 * いずれの場合も throw せず、戻り値で表現する。これにより improvement_pr の
 * worker hop は try/catch を 1 段だけ書けば済む。
 */
export async function generateAndQaCreative(
  options: GenerateAndQaCreativeOptions
): Promise<GenerateAndQaCreativeResult> {
  let generation: ImageGenerateResult;
  try {
    generation = await options.provider.generateImage(options.request);
  } catch (err) {
    return {
      generation: null,
      qa: null,
      outcome: CREATIVE_QA_FALLBACK_TEXT_ONLY,
      providerError: sanitizeEvidence(
        err instanceof Error ? err.message : String(err)
      ),
      providerErrorKind: classifyProviderError(err),
    };
  }

  const variantByKey = new Map<string, ImagePromptVariant>();
  if (Array.isArray(options.variants)) {
    for (const v of options.variants) {
      const k = typeof v.variantKey === "string" && v.variantKey.length > 0 ? v.variantKey : null;
      if (k !== null) variantByKey.set(k, v);
    }
  }

  const inputs: CreativeQaAssetInput[] = generation.assets.map((asset) => {
    const variant = variantByKey.get(asset.variantKey) ?? null;
    const ocr = options.detectedTextByVariantKey?.[asset.variantKey] ?? null;
    const score =
      options.providerQualityScoreByVariantKey?.[asset.variantKey] ?? null;
    const input: CreativeQaAssetInput = { asset };
    if (variant !== null) input.variant = variant;
    if (ocr !== null) input.detectedText = ocr;
    if (score !== null) input.providerQualityScore = score;
    return input;
  });

  const qa = evaluateCreativeQaBatch(inputs, options.policy ?? {});
  // the current implementation: metadata は QA 結果も保持する。Provider が返した meta に
  // `qaResult` linkage を埋めて、creative metadata.json / ai_runs.outputs に
  // そのまま流せる shape にする (per-variant outcome は assets と同じ順序)。
  generation.meta.qaResult = {
    overall: qa.overall,
    perVariant: qa.assets.map((a) => ({
      variantKey: a.variantKey,
      outcome: a.overall,
    })),
    qaRef: options.qaRef ?? null,
  };
  return {
    generation,
    qa,
    outcome: qa.overall,
    providerError: null,
    providerErrorKind: null,
  };
}

function classifyProviderError(
  err: unknown
): GenerateAndQaCreativeResult["providerErrorKind"] {
  if (err instanceof ImageProviderNotConfiguredError) return "provider_not_configured";
  if (err instanceof ImageProviderError) return "provider_error";
  // ImageProviderInvalidRequestError は ImageProviderError とは別 class なので
  // name で判定 (import すると循環の心配は無いが defensive に)
  if (err instanceof Error && err.name === "ImageProviderInvalidRequestError") {
    return "invalid_request";
  }
  return "unknown";
}

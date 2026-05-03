// AdDroid OSS — ImageProvider abstraction (the current implementation).
//
// 広告クリエイティブ生成の唯一の入口。LLMProvider が chat completion を扱うのと
// 同じく、画像生成 Provider (openai / stability / replicate / mock) はすべて本
// interface の実装として書き、worker / route handler / improvement_pr の hop
// から個別 SDK を直接叩かないことで:
//   - 「画像 Provider は完全に任意」(the current implementation principle 21) を保ちつつ、
//   - Provider 失敗時に prompt-only に縮退できる単一の窓口を提供し、
//   - mock provider を tests / CI で UI と worker pipeline と同じ shape で走らせる。
//
// 設計原則:
//   - access token / api key の **平文は本 interface の外に漏らさない**。実装は
//     env / oauth_tokens から取得し、メソッドのスコープに閉じる。
//   - 結果は **必ず bytes (Uint8Array) で返す**。Provider が signed URL を返した
//     場合でも、実装側で fetch して bytes に正規化する。これにより
//     「画像バイナリは LocalDisk Storage Adapter からのみ配信」(the current implementation
//     principle 23) を上位レイヤで担保できる。
//   - 単一呼び出しで複数の variation_conditions を要求できる (multi-variant
//     generation)。Provider が複数バリアントを native サポートしない場合は
//     adapter 側で逐次呼び出しに展開する。
//   - エラーは sanitize 済みのメッセージのみを露出する。`Error.message` /
//     `payload` に絶対に access_token / api_key / signed URL を含めない。

/**
 * 既知の画像生成 Provider 名。`mock` は tests / dev 用。
 */
export type ImageProviderName = "openai" | "stability" | "replicate" | "codex" | "mock";

/**
 * 1 バリアント分の生成条件。Image Prompt Agent (agents.ts) が生成する
 * `ImagePromptVariant` を Provider 呼び出しに変換したもの。
 *
 * `width` / `height` は Meta placement 要件 (例: 1080x1080 = feed square,
 * 1200x628 = feed landscape) に合わせる。`format` は既定 "png"。
 */
export interface ImageVariationCondition {
  /** Pixel 幅 (1 以上の整数)。 */
  width: number;
  /** Pixel 高 (1 以上の整数)。 */
  height: number;
  /** 出力フォーマット。既定 "png"。 */
  format?: "png" | "jpeg";
  /** Provider に渡す追加 style ヒント (任意)。 */
  styleNotes?: string;
  /** Negative prompt をサポートする Provider のみ使用 (任意)。 */
  negativePrompt?: string;
  /**
   * Variation を上位 (creative_assets / ai_runs) で識別するための任意キー。
   * 指定されない場合は adapter 側で `variant-<index>` を採番する。
   */
  variantKey?: string;
}

export interface ImageGenerateRequest {
  /** 生成プロンプト本文 (Image Prompt Agent の出力)。 */
  prompt: string;
  /** 1 件以上の variation 条件。 */
  variationConditions: ImageVariationCondition[];
  /** Model id (例: "gpt-image-1", "sd3-large", "placeholder-1080")。 */
  model?: string;
  /**
   * 呼び出しの起点 (例: "agent:image_prompt", "workflow:improvement_pr")。
   * Provider には送らず、ai_runs / 監査ログに残す。
   */
  purpose?: string;
}

/**
 * 1 アセット分の生成結果。bytes は LocalDisk Storage Adapter にそのまま
 * 書き出せる形 (UI / client には絶対に渡さない)。
 */
export interface ImageGeneratedAsset {
  /**
   * Generation 内での variant キー。`ImageVariationCondition.variantKey` が
   * 指定されていればそれを採用、なければ `variant-<index>` を採番。
   * 永続的な creative_asset_id とは別物 (Storage Adapter 側で採番される)。
   */
  variantKey: string;
  /** 画像バイナリ。 */
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  /** 生成された画像の実寸 (Provider が条件と異なる出力を返す可能性に備えて再採取)。 */
  width: number;
  height: number;
  /** bytes.byteLength を冗長に保持 (Storage Adapter が Content-Length を埋めるのに使う)。 */
  byteSize: number;
}

/**
 * 生成パラメータの監査用スナップショット。Provider が実際に呼び出された
 * ときの条件を `ImageGenerateResponseMeta.parameters` に保持する。
 *
 * the current implementation acceptance: "Metadata must preserve prompt, model/provider,
 * parameters, and QA result." の `parameters` 部分を担う。creative
 * metadata.json / ai_runs.outputs に同じ shape で書き出される想定。
 */
export interface ImageGenerateResponseParameters {
  /**
   * 呼び出し時に渡された variation 条件のスナップショット。Provider 側で
   * format などの既定値を補ったあとの値を保持する。
   */
  variationConditions: ImageVariationCondition[];
  /** `ImageGenerateRequest.purpose` のコピー (audit 用)。指定なしなら null。 */
  purpose: string | null;
  /** Variant 数 (= variationConditions.length)。冗長コピー。 */
  variantCount: number;
}

/**
 * QA 結果の linkage。Provider 自体は QA を実行しないため `generateImage` の
 * 戻り値では常に null。上位レイヤ (`generateAndQaCreative` など) が QA 実行
 * 後に populate する。
 *
 * 循環依存を避けるため creative-qa.ts の型を import せず、文字列リテラル
 * ユニオンで outcome を表現する (creative-qa.ts の `CreativeQaOverallOutcome`
 * + the current implementation principle 27 の `fallback_text_only` sentinel と整合)。
 */
export interface ImageGenerateResponseQaLinkage {
  /**
   * QA 全体 outcome。`qa_passed | qa_warned | qa_failed | fallback_text_only`。
   * `fallback_text_only` は Provider 失敗で QA を走らせなかったケース。
   */
  overall: "qa_passed" | "qa_warned" | "qa_failed" | "fallback_text_only";
  /**
   * Per-variant outcome。`assets` と同じ順序・同じ variantKey で並ぶ。
   * fallback_text_only の場合は空配列。
   */
  perVariant: ReadonlyArray<{
    variantKey: string;
    outcome: "qa_passed" | "qa_warned" | "qa_failed";
  }>;
  /**
   * QA 結果の永続参照 (例: ai_run id, `storage://...` 参照)。UI / audit が
   * deep-link に使う。確定していない場合 null。
   */
  qaRef: string | null;
}

export interface ImageGenerateResponseMeta {
  provider: ImageProviderName;
  /** 実際に応答を返した model id。 */
  model: string;
  /** Provider が返す request id (ある場合)。失敗時 null。 */
  requestId: string | null;
  /** ISO 8601。 */
  generatedAt: string;
  /**
   * 生成に使われた prompt。`ImageGenerateRequest.prompt` をそのまま保持する。
   * the current implementation acceptance: prompt 保存の契約。
   */
  prompt: string;
  /** 生成パラメータのスナップショット (variation 条件 / purpose / variant 数)。 */
  parameters: ImageGenerateResponseParameters;
  /**
   * QA result linkage。`generateImage` 直後は常に null。QA hop が完了次第
   * 上位レイヤが populate する。
   */
  qaResult: ImageGenerateResponseQaLinkage | null;
}

export interface ImageGenerateResult {
  assets: ImageGeneratedAsset[];
  meta: ImageGenerateResponseMeta;
  /** 概算 USD コスト。pricing.ts と将来統合する余地あり。0 = 不明 / mock。 */
  costUsd: number;
}

export interface ImageProvider {
  readonly name: ImageProviderName;
  readonly defaultModel: string;
  /**
   * Provider が「設定済みで実呼び出し可能」かどうか。stub は false、
   * mock / 実 adapter は true。UI 側の health 表示に直結する。
   */
  readonly enabled: boolean;
  /**
   * 1 リクエストで複数 variant を生成する。Provider が native multi-variant を
   * 持たない場合は adapter 側で逐次呼び出しに展開する。
   *
   * 失敗時は `ImageProviderError` 系を throw する。Error.message には
   * 絶対に access_token / api_key / signed URL を含めない。
   */
  generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResult>;
}

// ---- エラー ---------------------------------------------------------------

export class ImageProviderNotConfiguredError extends Error {
  readonly providerName: ImageProviderName | "unknown";
  constructor(providerName: ImageProviderName | "unknown", method: string) {
    super(
      `Image provider '${providerName}' is not configured. Image generation is optional — set ENABLE_MOCK_IMAGE_PROVIDER=1 for the mock adapter or configure a real provider in ~/.addroid/.env.local. [${method}]`
    );
    this.name = "ImageProviderNotConfiguredError";
    this.providerName = providerName;
  }
}

export class ImageProviderInvalidRequestError extends Error {
  readonly providerName: ImageProviderName;
  constructor(providerName: ImageProviderName, detail: string) {
    super(`Image provider '${providerName}' rejected request: ${detail}`);
    this.name = "ImageProviderInvalidRequestError";
    this.providerName = providerName;
  }
}

/**
 * Provider への外向き呼び出しのエラー。HTTP status / sanitize 済み payload を
 * 保持する。`message` には絶対に access_token / api_key / signed URL を
 * 含めない。
 */
export class ImageProviderError extends Error {
  readonly providerName: ImageProviderName;
  readonly status?: number;
  readonly code?: string;
  readonly payload?: unknown;
  constructor(
    providerName: ImageProviderName,
    message: string,
    opts?: { status?: number; code?: string; payload?: unknown }
  ) {
    super(`[${providerName}] ${message}`);
    this.name = "ImageProviderError";
    this.providerName = providerName;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.code !== undefined) this.code = opts.code;
    if (opts?.payload !== undefined) this.payload = opts.payload;
  }
}

// ---- Validation helpers ---------------------------------------------------

/**
 * Adapter 共通の入力チェック。call site の重複を避けるため公開している。
 * `prompt` 空 / `variationConditions` 空 / 異常な dimensions を検出する。
 */
export function validateImageGenerateRequest(
  providerName: ImageProviderName,
  req: ImageGenerateRequest
): void {
  if (typeof req.prompt !== "string" || req.prompt.trim().length === 0) {
    throw new ImageProviderInvalidRequestError(
      providerName,
      "prompt must be a non-empty string"
    );
  }
  if (!Array.isArray(req.variationConditions) || req.variationConditions.length === 0) {
    throw new ImageProviderInvalidRequestError(
      providerName,
      "variationConditions must contain at least one entry"
    );
  }
  for (let i = 0; i < req.variationConditions.length; i += 1) {
    const v = req.variationConditions[i]!;
    if (!Number.isInteger(v.width) || v.width <= 0 || v.width > 4096) {
      throw new ImageProviderInvalidRequestError(
        providerName,
        `variationConditions[${i}].width must be an integer in (0, 4096], got ${v.width}`
      );
    }
    if (!Number.isInteger(v.height) || v.height <= 0 || v.height > 4096) {
      throw new ImageProviderInvalidRequestError(
        providerName,
        `variationConditions[${i}].height must be an integer in (0, 4096], got ${v.height}`
      );
    }
    if (v.format !== undefined && v.format !== "png" && v.format !== "jpeg") {
      throw new ImageProviderInvalidRequestError(
        providerName,
        `variationConditions[${i}].format must be 'png' or 'jpeg' if provided, got ${String(v.format)}`
      );
    }
  }
}

// AdDroid OSS — MockImageProvider (the current implementation).
//
// `ENABLE_MOCK_IMAGE_PROVIDER=1` (または `ADDROID_IMAGE_MOCK=1`) のときに
// 採用される、ネットワーク不要・credentials 不要の image provider。
//
// 役割:
//   - tests / CI / dev で improvement_pr の image hop を **実 Provider と同じ
//     shape** (Uint8Array bytes + width + height + mimeType) で走らせる。
//   - 同じ (prompt, variationConditions, seed) に対して **決定論的に同じ bytes**
//     を返す (テストのスナップショット安定化)。
//
// 実装上の注意:
//   - 外部依存ゼロで動かすため、Node 標準の `zlib` / `crypto` のみで完結させる
//     (npm 依存を増やさない — Contract Prohibited)。
//   - 出力は単色 PNG (truecolor RGB)。`format: "jpeg"` を要求された場合は
//     `ImageProviderInvalidRequestError` を投げる (mock の表明スコープ外)。
//     実 Provider 追加時に JPEG 経路が必要になったら、その adapter 側で
//     対応する。
//   - 生成画像は SHA-256(prompt|variantKey) 由来のソリッド色。creative QA の
//     dimensions / format チェックはこの bytes で通る。quality /
//     forbidden_expression / brand_tone は別 hop の責務。

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import {
  ImageProviderError,
  ImageProviderInvalidRequestError,
  validateImageGenerateRequest,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImageProvider,
  type ImageProviderName,
  type ImageVariationCondition,
} from "./image-provider.js";

/**
 * Mock provider が advertise する model id 一覧。`placeholder-1080` を既定とし、
 * 将来 carousel 用に追加する余地を残す (現状 UI / Storage には固有意味なし)。
 */
export const MOCK_IMAGE_MODELS = ["placeholder-1080", "placeholder-1200x628"] as const;

export interface MockImageProviderOptions {
  /** 既定 model。指定がなければ "placeholder-1080"。 */
  defaultModel?: string;
  /**
   * 失敗モード (tests 用)。"provider_error" が指定されると generateImage が
   * `ImageProviderError` を投げる。fallback (prompt-only) 経路の検証に使う。
   */
  failureMode?: "provider_error" | null;
  /**
   * 決定論性に使う seed (tests 用)。同じ seed + 同じ request で同じ bytes が
   * 返ることを保証する。既定 "addroid-mock-image"。
   */
  seed?: string;
}

const DEFAULT_MODEL = "placeholder-1080";
const DEFAULT_SEED = "addroid-mock-image";

export class MockImageProvider implements ImageProvider {
  readonly name: ImageProviderName = "mock";
  readonly defaultModel: string;
  readonly enabled = true;

  private readonly seed: string;
  private failureMode: "provider_error" | null;

  constructor(opts: MockImageProviderOptions = {}) {
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.seed = opts.seed ?? DEFAULT_SEED;
    this.failureMode = opts.failureMode ?? null;
  }

  async generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    validateImageGenerateRequest(this.name, req);
    if (this.failureMode === "provider_error") {
      throw new ImageProviderError(
        this.name,
        "mock provider failure (failureMode=provider_error)",
        { status: 503, code: "mock_failure" }
      );
    }
    // Mock supports PNG only — Meta accepts both, but encoding a valid JPEG
    // here would require a non-trivial encoder we don't want to ship as part
    // of the abstraction package. Real Provider adapters can opt in to JPEG.
    for (let i = 0; i < req.variationConditions.length; i += 1) {
      const fmt = req.variationConditions[i]!.format ?? "png";
      if (fmt !== "png") {
        throw new ImageProviderInvalidRequestError(
          this.name,
          `variationConditions[${i}].format='${fmt}' is not supported by the mock provider (PNG only)`
        );
      }
    }

    const model = req.model ?? this.defaultModel;
    const generatedAt = "1970-01-01T00:00:00.000Z"; // 決定論的な固定値。実呼び出しでは adapter 外で実時刻を採取する想定。

    const normalizedConditions: ImageVariationCondition[] = req.variationConditions.map(
      (cond, idx) => {
        const variantKey = cond.variantKey ?? `variant-${idx}`;
        // 既定値を埋めたスナップショットを保持 (audit / metadata.json 用)。
        const out: ImageVariationCondition = {
          width: cond.width,
          height: cond.height,
          format: cond.format ?? "png",
          variantKey,
        };
        if (cond.styleNotes !== undefined) out.styleNotes = cond.styleNotes;
        if (cond.negativePrompt !== undefined) out.negativePrompt = cond.negativePrompt;
        return out;
      }
    );

    const assets: ImageGeneratedAsset[] = normalizedConditions.map((cond) => {
      const color = deriveDeterministicColor(this.seed, req.prompt, cond.variantKey!);
      const bytes = encodePng(cond.width, cond.height, color);
      return {
        variantKey: cond.variantKey!,
        bytes,
        mimeType: "image/png",
        width: cond.width,
        height: cond.height,
        byteSize: bytes.byteLength,
      };
    });
    const requestId = `mock-img-${shortHash(
      req.prompt + ":" + JSON.stringify(req.variationConditions)
    )}`;
    return {
      assets,
      meta: {
        provider: this.name,
        model,
        requestId,
        generatedAt,
        prompt: req.prompt,
        parameters: {
          variationConditions: normalizedConditions,
          purpose: req.purpose ?? null,
          variantCount: normalizedConditions.length,
          referenceImageCount: req.referenceImages?.length ?? 0,
        },
        qaResult: null,
      },
      costUsd: 0,
    };
  }

  // ---- test seam ----
  setFailureMode(mode: "provider_error" | null): void {
    this.failureMode = mode;
  }
}

// ---------------------------------------------------------------------------
// Deterministic color derivation
// ---------------------------------------------------------------------------

function deriveDeterministicColor(
  seed: string,
  prompt: string,
  variantKey: string
): { r: number; g: number; b: number } {
  const h = createHash("sha256").update(`${seed}|${prompt}|${variantKey}`).digest();
  return { r: h[0]!, g: h[1]!, b: h[2]! };
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGB truecolor, no alpha, single solid color)
// ---------------------------------------------------------------------------
//
// RFC 2083 (PNG) + RFC 1950 (zlib) + RFC 1951 (deflate)。外部依存を増やさず
// Node の `zlib.deflateRawSync` を使い、zlib stream のヘッダ / Adler32 を
// 自前で付ける。CRC32 / Adler32 は標準 polynomial を素直に実装。

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function encodePng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
): Uint8Array {
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * rowLen;
    raw[off] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const px = off + 1 + x * 3;
      raw[px] = color.r;
      raw[px + 1] = color.g;
      raw[px + 2] = color.b;
    }
  }
  const deflated = deflateRawSync(raw);
  const adler = adler32(raw);
  const zlibStream = Buffer.concat([
    Buffer.from([0x78, 0x01]), // CMF (deflate, 32K window) + FLG (no preset, FCHECK adjusted)
    deflated,
    u32be(adler),
  ]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: 2 = truecolor RGB (no alpha)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStream),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuf, data]));
  return Buffer.concat([len, typeBuf, data, u32be(crc)]);
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

let CRC_TABLE: Uint32Array | null = null;
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) CRC_TABLE = buildCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i += 1) {
    a = (a + buf[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

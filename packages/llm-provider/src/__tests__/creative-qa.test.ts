import test from "node:test";
import assert from "node:assert/strict";

import {
  CREATIVE_QA_CHECK_KINDS,
  CREATIVE_QA_FALLBACK_TEXT_ONLY,
  DEFAULT_CREATIVE_QA_POLICY,
  DEFAULT_CREATIVE_QA_SEVERITY,
  ImageProviderError,
  ImageProviderInvalidRequestError,
  ImageProviderNotConfiguredError,
  MockImageProvider,
  StubImageProvider,
  evaluateCreativeQa,
  evaluateCreativeQaBatch,
  generateAndQaCreative,
  sanitizeEvidence,
  type CreativeQaAssetInput,
  type CreativeQaAssetResult,
  type CreativeQaCheckResult,
  type CreativeQaPolicy,
  type ImageGeneratedAsset,
  type ImagePromptVariant,
} from "../index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

function makePngAsset(opts: {
  variantKey?: string;
  width?: number;
  height?: number;
  byteSize?: number;
  bytes?: Uint8Array;
  mimeType?: ImageGeneratedAsset["mimeType"];
}): ImageGeneratedAsset {
  const bytes = opts.bytes ?? Uint8Array.from([...PNG_SIG, 0, 0, 0, 0, 0, 0, 0, 0]);
  return {
    variantKey: opts.variantKey ?? "v0",
    bytes,
    mimeType: opts.mimeType ?? "image/png",
    width: opts.width ?? 1080,
    height: opts.height ?? 1080,
    byteSize: opts.byteSize ?? bytes.byteLength,
  };
}

function findCheck(
  result: CreativeQaAssetResult,
  kind: CreativeQaCheckResult["kind"]
): CreativeQaCheckResult {
  const c = result.checks.find((c) => c.kind === kind);
  if (!c) throw new Error(`check ${kind} missing from result`);
  return c;
}

// ---------------------------------------------------------------------------
// CREATIVE_QA_CHECK_KINDS / DEFAULT_CREATIVE_QA_SEVERITY
// ---------------------------------------------------------------------------

test("CREATIVE_QA_CHECK_KINDS lists exactly the 5 contracted check kinds", () => {
  assert.deepEqual([...CREATIVE_QA_CHECK_KINDS].sort(), [
    "brand_tone",
    "dimensions",
    "forbidden_expression",
    "format",
    "quality",
  ]);
});

test("DEFAULT_CREATIVE_QA_SEVERITY matches the contracted defaults", () => {
  assert.equal(DEFAULT_CREATIVE_QA_SEVERITY.dimensions, "blocking");
  assert.equal(DEFAULT_CREATIVE_QA_SEVERITY.format, "blocking");
  assert.equal(DEFAULT_CREATIVE_QA_SEVERITY.quality, "non_blocking");
  assert.equal(DEFAULT_CREATIVE_QA_SEVERITY.forbidden_expression, "blocking");
  assert.equal(DEFAULT_CREATIVE_QA_SEVERITY.brand_tone, "non_blocking");
});

// ---------------------------------------------------------------------------
// evaluateCreativeQa — every result has 5 checks
// ---------------------------------------------------------------------------

test("evaluateCreativeQa always returns one entry per check kind", () => {
  const result = evaluateCreativeQa({ asset: makePngAsset({}) }, {});
  assert.equal(result.checks.length, 5);
  const kinds = result.checks.map((c) => c.kind).sort();
  assert.deepEqual(kinds, [
    "brand_tone",
    "dimensions",
    "forbidden_expression",
    "format",
    "quality",
  ]);
});

test("evaluateCreativeQa with empty policy keeps per-check skipped, but overall fails because blocking checks are skipped", () => {
  // regression fix: 空 policy 下では dimensions / forbidden_expression
  // (どちらも default severity = blocking) が `skipped` に倒れるため、
  // overall は qa_failed (= PR 添付禁止) でなければならない。これにより
  // 「skipped required checks must not be attachable」が aggregator 自身で
  // 担保される (orchestrator 側の DEFAULT_CREATIVE_QA_POLICY 注入とは別軸の
  // 二重防御)。
  const result = evaluateCreativeQa({ asset: makePngAsset({}) }, {});
  // dimensions: skipped (no policy) — blocking severity
  assert.equal(findCheck(result, "dimensions").outcome, "skipped");
  assert.equal(findCheck(result, "dimensions").severity, "blocking");
  // format: pass (default mime allowlist + valid PNG signature)
  assert.equal(findCheck(result, "format").outcome, "pass");
  // quality: skipped (no policy) — non_blocking severity, does not fail overall
  assert.equal(findCheck(result, "quality").outcome, "skipped");
  assert.equal(findCheck(result, "quality").severity, "non_blocking");
  // forbidden_expression: skipped (no policy) — blocking severity
  assert.equal(findCheck(result, "forbidden_expression").outcome, "skipped");
  assert.equal(findCheck(result, "forbidden_expression").severity, "blocking");
  // brand_tone: skipped (no policy) — non_blocking severity
  assert.equal(findCheck(result, "brand_tone").outcome, "skipped");
  // overall: blocking-severity skipped checks ⇒ qa_failed
  assert.equal(result.overall, "qa_failed");
});

// ---------------------------------------------------------------------------
// 1) dimensions
// ---------------------------------------------------------------------------

test("dimensions: exact allowed list — pass on hit", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1080, height: 1080 }) },
    {
      dimensions: {
        allowed: [
          { width: 1080, height: 1080, label: "feed square" },
          { width: 1200, height: 628, label: "landscape" },
        ],
      },
    }
  );
  assert.equal(findCheck(result, "dimensions").outcome, "pass");
});

test("dimensions: exact allowed list — fail when no entry matches", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1024, height: 1024 }) },
    {
      dimensions: {
        allowed: [{ width: 1080, height: 1080 }],
      },
    }
  );
  const c = findCheck(result, "dimensions");
  assert.equal(c.outcome, "fail");
  assert.match(c.detail, /1080x1080/);
  assert.match(c.detail, /1024x1024/);
});

test("dimensions: aspect ratio passes within 2% tolerance", () => {
  // 1080x1080 = 1:1, exact match
  const exact = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1080, height: 1080 }) },
    { dimensions: { aspectRatios: ["1:1"] } }
  );
  assert.equal(findCheck(exact, "dimensions").outcome, "pass");

  // 1100x1080 ratio 1.0185 — within 2% of 1.0
  const close = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1100, height: 1080 }) },
    { dimensions: { aspectRatios: ["1:1"] } }
  );
  assert.equal(findCheck(close, "dimensions").outcome, "pass");

  // 1200x1080 ratio 1.111 — outside 2%
  const off = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1200, height: 1080 }) },
    { dimensions: { aspectRatios: ["1:1"] } }
  );
  assert.equal(findCheck(off, "dimensions").outcome, "fail");
});

test("dimensions: 1.91:1 landscape parsing", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1200, height: 628 }) },
    { dimensions: { aspectRatios: ["1.91:1"] } }
  );
  assert.equal(findCheck(result, "dimensions").outcome, "pass");
});

test("dimensions: minShortSidePx fail", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 320, height: 320 }) },
    { dimensions: { minShortSidePx: 600 } }
  );
  const c = findCheck(result, "dimensions");
  assert.equal(c.outcome, "fail");
  assert.match(c.detail, /short side 320/);
});

test("dimensions: maxSidePx fail", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 5000, height: 1000 }) },
    { dimensions: { maxSidePx: 4096 } }
  );
  const c = findCheck(result, "dimensions");
  assert.equal(c.outcome, "fail");
  assert.match(c.detail, /5000/);
});

// ---------------------------------------------------------------------------
// 2) format
// ---------------------------------------------------------------------------

test("format: default allowlist accepts PNG", () => {
  const result = evaluateCreativeQa({ asset: makePngAsset({}) }, {});
  assert.equal(findCheck(result, "format").outcome, "pass");
});

test("format: rejects mime not in allowlist", () => {
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({
        mimeType: "image/jpeg",
        bytes: Uint8Array.from([...JPEG_SIG, 0]),
      }),
    },
    { format: { allowedMimeTypes: ["image/png"] } }
  );
  const c = findCheck(result, "format");
  assert.equal(c.outcome, "fail");
  assert.match(c.detail, /image\/jpeg/);
});

test("format: PNG with broken signature fails magic-byte check", () => {
  const broken = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ bytes: broken, byteSize: broken.byteLength }) },
    {}
  );
  const c = findCheck(result, "format");
  assert.equal(c.outcome, "fail");
  assert.match(c.detail, /PNG signature/);
});

test("format: JPEG SOI passes", () => {
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({
        mimeType: "image/jpeg",
        bytes: Uint8Array.from([...JPEG_SIG, 0]),
      }),
    },
    {}
  );
  assert.equal(findCheck(result, "format").outcome, "pass");
});

// ---------------------------------------------------------------------------
// 3) quality
// ---------------------------------------------------------------------------

test("quality: skipped when no policy configured", () => {
  const result = evaluateCreativeQa({ asset: makePngAsset({}) }, {});
  assert.equal(findCheck(result, "quality").outcome, "skipped");
});

test("quality: byteSize > recommendedMaxByteSize ⇒ warn (non-blocking)", () => {
  // regression fix: blocking severity の dimensions / forbidden_expression が
  // skip に倒れると aggregator は overall を qa_failed に押し下げる。本テストは
  // quality check 単体の severity / outcome を検証する目的なので、それ以外の
  // blocking check は明示的に pass させる。
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ byteSize: 1_500_000 }), variant },
    {
      dimensions: { aspectRatios: ["1:1"] },
      forbiddenExpression: { terms: ["__never_match__"] },
      quality: { recommendedMaxByteSize: 1_000_000 },
    }
  );
  const c = findCheck(result, "quality");
  assert.equal(c.outcome, "warn");
  assert.equal(c.severity, "non_blocking");
  // overall stays qa_warned (default severity is non_blocking)
  assert.equal(result.overall, "qa_warned");
});

test("quality: byteSize > maxByteSize ⇒ fail", () => {
  // regression fix: 同上。quality 単体検証のため他 blocking check を pass 化。
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ byteSize: 50_000_000 }), variant },
    {
      dimensions: { aspectRatios: ["1:1"] },
      forbiddenExpression: { terms: ["__never_match__"] },
      quality: { maxByteSize: 30_000_000 },
    }
  );
  const c = findCheck(result, "quality");
  assert.equal(c.outcome, "fail");
  // default severity is non_blocking — overall should be qa_warned, not qa_failed
  assert.equal(result.overall, "qa_warned");
});

test("quality: byteSize < minByteSize ⇒ fail (treated as broken/empty)", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ byteSize: 100 }) },
    { quality: { minByteSize: 256 } }
  );
  assert.equal(findCheck(result, "quality").outcome, "fail");
});

test("quality: minProviderQualityScore fail", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({}), providerQualityScore: 0.4 },
    { quality: { minProviderQualityScore: 0.7 } }
  );
  const c = findCheck(result, "quality");
  assert.equal(c.outcome, "fail");
  assert.match(c.detail, /0\.400/);
});

test("quality: with recommended-max + score thresholds — fail wins over warn", () => {
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({ byteSize: 1_500_000 }),
      providerQualityScore: 0.2,
    },
    {
      quality: {
        recommendedMaxByteSize: 1_000_000,
        minProviderQualityScore: 0.7,
      },
    }
  );
  // fail (score) should be reported, not the warn (size)
  assert.equal(findCheck(result, "quality").outcome, "fail");
});

// ---------------------------------------------------------------------------
// 4) forbidden_expression
// ---------------------------------------------------------------------------

const variant: ImagePromptVariant = {
  prompt: "A clean operator console with subtle indigo accent",
  styleNotes: "minimalist, monochrome",
  negativePrompt: "logos, mascots, sparkles",
};

test("forbidden_expression: skipped when no terms configured", () => {
  const result = evaluateCreativeQa({ asset: makePngAsset({}), variant }, {});
  assert.equal(findCheck(result, "forbidden_expression").outcome, "skipped");
});

test("forbidden_expression: matches term in prompt (case-insensitive default)", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({}), variant },
    { forbiddenExpression: { terms: ["INDIGO"] } }
  );
  const c = findCheck(result, "forbidden_expression");
  assert.equal(c.outcome, "fail");
  assert.match(c.evidence ?? "", /INDIGO/i);
  // overall: blocking severity ⇒ qa_failed
  assert.equal(result.overall, "qa_failed");
});

test("forbidden_expression: case-sensitive mode honors casing", () => {
  const r1 = evaluateCreativeQa(
    { asset: makePngAsset({}), variant },
    { forbiddenExpression: { terms: ["INDIGO"], caseSensitive: true } }
  );
  // Case-sensitive miss
  assert.equal(findCheck(r1, "forbidden_expression").outcome, "pass");

  const r2 = evaluateCreativeQa(
    { asset: makePngAsset({}), variant },
    { forbiddenExpression: { terms: ["indigo"], caseSensitive: true } }
  );
  assert.equal(findCheck(r2, "forbidden_expression").outcome, "fail");
});

test("forbidden_expression: matches detectedText (OCR-style)", () => {
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({}),
      variant,
      detectedText: "SALE 80% OFF",
    },
    { forbiddenExpression: { terms: ["sale", "free trial"] } }
  );
  assert.equal(findCheck(result, "forbidden_expression").outcome, "fail");
});

test("forbidden_expression: skipped when no haystack available", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({}) },
    { forbiddenExpression: { terms: ["whatever"] } }
  );
  assert.equal(findCheck(result, "forbidden_expression").outcome, "skipped");
});

// ---------------------------------------------------------------------------
// 5) brand_tone
// ---------------------------------------------------------------------------

test("brand_tone: skipped when no policy configured", () => {
  const result = evaluateCreativeQa({ asset: makePngAsset({}), variant }, {});
  assert.equal(findCheck(result, "brand_tone").outcome, "skipped");
});

test("brand_tone: warn when no recommended keyword matches", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({}), variant },
    {
      brandTone: {
        recommendedKeywords: ["operator-grade", "calm", "instrumented"],
      },
    }
  );
  const c = findCheck(result, "brand_tone");
  // "operator console" contains "operator" but not "operator-grade"
  // (we look for substring) — it should warn since none of the FULL phrases match
  assert.equal(c.outcome, "warn");
});

test("brand_tone: pass when at least one keyword matches", () => {
  const result = evaluateCreativeQa(
    { asset: makePngAsset({}), variant },
    {
      brandTone: {
        recommendedKeywords: ["minimalist", "loud"],
      },
    }
  );
  assert.equal(findCheck(result, "brand_tone").outcome, "pass");
});

test("brand_tone: forbidden tones override pass", () => {
  const variantSpicy: ImagePromptVariant = {
    prompt: "An aggressive sales banner with shouting copy",
    styleNotes: "neon, punchy, urgent",
    negativePrompt: "",
  };
  const result = evaluateCreativeQa(
    { asset: makePngAsset({}), variant: variantSpicy },
    {
      brandTone: {
        recommendedKeywords: ["urgent"],
        forbiddenTones: ["aggressive", "煽り"],
      },
    }
  );
  const c = findCheck(result, "brand_tone");
  assert.equal(c.outcome, "fail");
  assert.match(c.evidence ?? "", /aggressive/);
});

// ---------------------------------------------------------------------------
// severity overrides + overall aggregation
// ---------------------------------------------------------------------------

test("severityOverrides downgrade dimensions to non-blocking", () => {
  // regression fix: forbidden_expression は default で blocking severity であり、
  // skipped に倒れると overall を qa_failed に押し下げる。本テストは
  // 「dimensions の severity downgrade」を検証する目的なので、それ以外の
  // blocking check は skip しないように non-empty な terms を渡す。
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 320, height: 320 }), variant },
    {
      dimensions: { minShortSidePx: 600 },
      forbiddenExpression: { terms: ["__never_match__"] },
      severityOverrides: { dimensions: "non_blocking" },
    }
  );
  const c = findCheck(result, "dimensions");
  assert.equal(c.outcome, "fail");
  assert.equal(c.severity, "non_blocking");
  // overall: non_blocking fail ⇒ qa_warned, not qa_failed
  assert.equal(result.overall, "qa_warned");
});

test("severityOverrides=info_only is purely observational and never blocks", () => {
  // regression fix: forbidden_expression は default blocking severity のため、
  // policy が空だと skip → qa_failed に倒れる。本テストは info_only severity
  // が overall に効かないことを検証する目的なので、forbidden_expression を
  // 不一致 terms で明示的に pass させる。
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 320, height: 320 }), variant },
    {
      dimensions: { minShortSidePx: 600 },
      forbiddenExpression: { terms: ["__never_match__"] },
      severityOverrides: { dimensions: "info_only" },
    }
  );
  // The fail is recorded but does NOT affect overall
  const c = findCheck(result, "dimensions");
  assert.equal(c.outcome, "fail");
  assert.equal(c.severity, "info_only");
  assert.equal(result.overall, "qa_passed");
});

test("overall aggregation: blocking fail dominates warn / non_blocking fail", () => {
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({
        mimeType: "image/png",
        // valid PNG, but big size triggers a non-blocking warn
        byteSize: 5_000_000,
      }),
      variant,
    },
    {
      // forbidden_expression fail (blocking)
      forbiddenExpression: { terms: ["indigo"] },
      // quality warn (non_blocking)
      quality: { recommendedMaxByteSize: 1_000_000 },
    }
  );
  // forbidden_expression fails blocking, qualifying overall as qa_failed
  assert.equal(result.overall, "qa_failed");
});

// ---------------------------------------------------------------------------
// evaluateCreativeQaBatch
// ---------------------------------------------------------------------------

test("evaluateCreativeQaBatch reports per-asset and aggregate counts", () => {
  const policy: CreativeQaPolicy = {
    dimensions: { allowed: [{ width: 1080, height: 1080 }] },
    forbiddenExpression: { terms: ["indigo"] },
  };
  // regression fix: asset 0 を qa_passed にするには forbidden_expression が
  // skip しないよう haystack (variant) を渡す必要がある (terms="indigo" を
  // 含まない安全な variant)。
  const safeVariant: ImagePromptVariant = {
    prompt: "operator console clean",
    styleNotes: "minimalist",
    negativePrompt: "logos",
    variantKey: "ok",
  };
  const inputs: CreativeQaAssetInput[] = [
    {
      asset: makePngAsset({ variantKey: "ok", width: 1080, height: 1080 }),
      variant: safeVariant,
    },
    {
      asset: makePngAsset({ variantKey: "bad-dim", width: 800, height: 800 }),
      variant: safeVariant,
    },
    {
      asset: makePngAsset({ variantKey: "bad-text", width: 1080, height: 1080 }),
      variant,
    },
  ];
  const r = evaluateCreativeQaBatch(inputs, policy);
  assert.equal(r.assets.length, 3);
  // 0: pass
  assert.equal(r.assets[0]!.overall, "qa_passed");
  // 1: dimensions blocking fail
  assert.equal(r.assets[1]!.overall, "qa_failed");
  // 2: forbidden_expression blocking fail (variant.prompt contains 'indigo')
  assert.equal(r.assets[2]!.overall, "qa_failed");
  assert.equal(r.failingCount, 2);
  assert.equal(r.passingCount, 1);
  assert.equal(r.overall, "qa_failed");
});

test("evaluateCreativeQaBatch overall=qa_warned when no fail but at least one warn", () => {
  // regression fix: blocking severity の dimensions / forbidden_expression が
  // skip に倒れると overall=qa_failed になるため、本テストは warn のみが
  // overall に乗ることを確認できるよう非空の policy を全 blocking check に
  // 与える (1080x1080 は aspect "1:1" でクリア、forbidden は不一致 terms)。
  const policy: CreativeQaPolicy = {
    dimensions: { aspectRatios: ["1:1"] },
    forbiddenExpression: { terms: ["__never_match__"] },
    quality: { recommendedMaxByteSize: 100 },
  };
  const inputs: CreativeQaAssetInput[] = [
    {
      asset: makePngAsset({ variantKey: "warn", byteSize: 200 }),
      variant,
    },
    {
      asset: makePngAsset({ variantKey: "pass-skipped" }),
      variant,
    },
  ];
  // Adjust the second asset to keep its quality result at "pass" (under threshold)
  const tinyBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  inputs[1]!.asset = makePngAsset({
    variantKey: "ok",
    bytes: tinyBytes,
    byteSize: tinyBytes.byteLength,
  });
  const r = evaluateCreativeQaBatch(inputs, policy);
  assert.equal(r.assets[0]!.overall, "qa_warned");
  assert.equal(r.assets[1]!.overall, "qa_passed");
  assert.equal(r.overall, "qa_warned");
});

// ---------------------------------------------------------------------------
// sanitizeEvidence
// ---------------------------------------------------------------------------

test("sanitizeEvidence redacts token-shaped substrings", () => {
  const out = sanitizeEvidence(
    "matched: sk-abcdef0123456 / Bearer sometokenvalueXYZ / xoxb-12345-abcdef-secret"
  );
  assert.match(out, /sk-\[REDACTED\]/);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.match(out, /xox\[REDACTED\]/);
  assert.doesNotMatch(out, /sometokenvalueXYZ/);
});

test("sanitizeEvidence redacts signed URLs", () => {
  const out = sanitizeEvidence(
    "preview: https://example.com/foo.png?signature=abc123XYZ&extra=1"
  );
  assert.match(out, /\[REDACTED-SIGNED-URL\]/);
});

// ---------------------------------------------------------------------------
// generateAndQaCreative — Mock provider integration
// ---------------------------------------------------------------------------

test("generateAndQaCreative: success path with MockImageProvider runs QA on every variant", async () => {
  const provider = new MockImageProvider();
  const variants: ImagePromptVariant[] = [
    {
      prompt: "operator console hero, calm indigo accent",
      styleNotes: "minimalist",
      negativePrompt: "logos",
      variantKey: "feed_square",
    },
    {
      prompt: "landscape banner, monochrome",
      styleNotes: "minimalist",
      negativePrompt: "mascots",
      variantKey: "feed_landscape",
    },
  ];
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "operator-grade ad creative",
      variationConditions: [
        { width: 1080, height: 1080, variantKey: "feed_square" },
        { width: 1200, height: 628, variantKey: "feed_landscape" },
      ],
    },
    variants,
    // regression fix: 全 5 check が pass する必要があるため、blocking 系の
    // dimensions / forbidden_expression を明示的に渡す。variant は
    // "indigo" / "monochrome" などの安全な語句のみで、forbidden terms には
    // 該当しない。
    policy: {
      dimensions: {
        allowed: [
          { width: 1080, height: 1080 },
          { width: 1200, height: 628 },
        ],
      },
      forbiddenExpression: { terms: ["__never_match__"] },
    },
  });
  assert.notEqual(r.generation, null);
  assert.notEqual(r.qa, null);
  assert.equal(r.qa!.assets.length, 2);
  assert.equal(r.outcome, "qa_passed");
  assert.equal(r.providerError, null);
  assert.equal(r.providerErrorKind, null);
  // each asset got 5 checks
  for (const a of r.qa!.assets) {
    assert.equal(a.checks.length, 5);
  }
  // the current implementation: QA result is linked back into generation.meta so persistors
  // (creative metadata.json / ai_runs.outputs) get a single self-describing
  // payload (prompt + parameters + qaResult).
  assert.equal(r.generation!.meta.prompt, "operator-grade ad creative");
  assert.equal(r.generation!.meta.parameters.variantCount, 2);
  assert.notEqual(r.generation!.meta.qaResult, null);
  assert.equal(r.generation!.meta.qaResult!.overall, "qa_passed");
  assert.equal(r.generation!.meta.qaResult!.perVariant.length, 2);
  assert.equal(r.generation!.meta.qaResult!.perVariant[0]!.variantKey, "feed_square");
  assert.equal(r.generation!.meta.qaResult!.perVariant[0]!.outcome, "qa_passed");
  assert.equal(r.generation!.meta.qaResult!.qaRef, null);
});

test("generateAndQaCreative: qaRef option propagates into generation.meta.qaResult", async () => {
  const provider = new MockImageProvider();
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "p",
      variationConditions: [{ width: 64, height: 64, variantKey: "v0" }],
    },
    qaRef: "ai_run_abc123",
  });
  assert.equal(r.generation!.meta.qaResult!.qaRef, "ai_run_abc123");
});

test("generateAndQaCreative: variant lookup is by variantKey", async () => {
  const provider = new MockImageProvider();
  const variants: ImagePromptVariant[] = [
    {
      prompt: "contains the forbidden phrase NEONFLASH",
      styleNotes: "",
      negativePrompt: "",
      variantKey: "v1",
    },
  ];
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "doesn't matter for QA",
      variationConditions: [{ width: 64, height: 64, variantKey: "v1" }],
    },
    variants,
    policy: { forbiddenExpression: { terms: ["neonflash"] } },
  });
  assert.equal(r.qa!.assets[0]!.overall, "qa_failed");
  const fe = r.qa!.assets[0]!.checks.find((c) => c.kind === "forbidden_expression");
  assert.equal(fe!.outcome, "fail");
});

test("generateAndQaCreative: ImageProviderNotConfiguredError ⇒ fallback_text_only", async () => {
  const provider = new StubImageProvider({ name: "openai", defaultModel: "gpt-image-1" });
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "anything",
      variationConditions: [{ width: 64, height: 64 }],
    },
  });
  assert.equal(r.outcome, CREATIVE_QA_FALLBACK_TEXT_ONLY);
  assert.equal(r.generation, null);
  assert.equal(r.qa, null);
  assert.equal(r.providerErrorKind, "provider_not_configured");
  assert.match(r.providerError ?? "", /optional/i);
  // sanitize check: the error message must not contain the api_key constant
  assert.doesNotMatch(r.providerError ?? "", /Bearer\s+|sk-[A-Za-z0-9]/);
  // No generation means no meta to mutate — qaResult linkage is N/A on the
  // fallback path (the upper layer records outcome=fallback_text_only on the
  // ai_run / creative table directly).
  assert.equal(r.generation, null);
});

test("generateAndQaCreative: ImageProviderError ⇒ fallback_text_only with provider_error kind", async () => {
  const provider = new MockImageProvider({ failureMode: "provider_error" });
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "anything",
      variationConditions: [{ width: 64, height: 64 }],
    },
  });
  assert.equal(r.outcome, CREATIVE_QA_FALLBACK_TEXT_ONLY);
  assert.equal(r.providerErrorKind, "provider_error");
  assert.equal(r.generation, null);
  assert.equal(r.qa, null);
});

test("generateAndQaCreative: invalid request (jpeg via mock) ⇒ providerErrorKind=invalid_request", async () => {
  const provider = new MockImageProvider();
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "p",
      variationConditions: [{ width: 64, height: 64, format: "jpeg" }],
    },
  });
  assert.equal(r.providerErrorKind, "invalid_request");
  assert.equal(r.outcome, CREATIVE_QA_FALLBACK_TEXT_ONLY);
});

test("generateAndQaCreative: detectedText / providerQualityScore maps are honored", async () => {
  const provider = new MockImageProvider();
  const r = await generateAndQaCreative({
    provider,
    request: {
      prompt: "p",
      variationConditions: [{ width: 64, height: 64, variantKey: "k1" }],
    },
    detectedTextByVariantKey: { k1: "SALE 80% OFF" },
    providerQualityScoreByVariantKey: { k1: 0.4 },
    policy: {
      forbiddenExpression: { terms: ["sale"] },
      quality: { minProviderQualityScore: 0.6 },
    },
  });
  assert.equal(r.outcome, "qa_failed");
  const a = r.qa!.assets[0]!;
  // Both forbidden_expression (blocking) and quality (non_blocking) fail —
  // but blocking dominates the asset overall.
  assert.equal(a.overall, "qa_failed");
  const fe = a.checks.find((c) => c.kind === "forbidden_expression")!;
  const qual = a.checks.find((c) => c.kind === "quality")!;
  assert.equal(fe.outcome, "fail");
  assert.equal(qual.outcome, "fail");
});

// ---------------------------------------------------------------------------
// Type re-exports (smoke check)
// ---------------------------------------------------------------------------

test("error classes still re-exported and runtime instances", async () => {
  assert.ok(ImageProviderError.prototype instanceof Error);
  assert.ok(ImageProviderInvalidRequestError.prototype instanceof Error);
  assert.ok(ImageProviderNotConfiguredError.prototype instanceof Error);
});

// ---------------------------------------------------------------------------
// regression fix — non-empty default policy + skipped-blocking aggregation
// ---------------------------------------------------------------------------

test("DEFAULT_CREATIVE_QA_POLICY configures every check kind (dimensions/format/quality/forbiddenExpression/brandTone)", () => {
  // Acceptance: "Creative QA checks dimensions, format, quality, forbidden
  // expressions, and brand-tone constraints before PR attachment". 既定値が
  // 5 種すべてに対して非空であることを確認する (空 policy 経路を物理的に
  // 排除するための最低限のガード)。
  assert.ok(DEFAULT_CREATIVE_QA_POLICY.dimensions);
  const dim = DEFAULT_CREATIVE_QA_POLICY.dimensions!;
  assert.ok(
    (dim.aspectRatios && dim.aspectRatios.length > 0) ||
      (dim.allowed && dim.allowed.length > 0) ||
      dim.minShortSidePx !== undefined ||
      dim.maxSidePx !== undefined,
    "default dimensions policy must impose at least one constraint"
  );

  assert.ok(DEFAULT_CREATIVE_QA_POLICY.format);
  assert.ok(
    DEFAULT_CREATIVE_QA_POLICY.format!.allowedMimeTypes!.length > 0,
    "default format policy must restrict mime types"
  );

  assert.ok(DEFAULT_CREATIVE_QA_POLICY.quality);
  const qp = DEFAULT_CREATIVE_QA_POLICY.quality!;
  assert.ok(
    qp.minByteSize !== undefined ||
      qp.recommendedMaxByteSize !== undefined ||
      qp.maxByteSize !== undefined ||
      qp.minProviderQualityScore !== undefined,
    "default quality policy must impose at least one bound"
  );

  assert.ok(DEFAULT_CREATIVE_QA_POLICY.forbiddenExpression);
  assert.ok(
    DEFAULT_CREATIVE_QA_POLICY.forbiddenExpression!.terms.length > 0,
    "default forbidden_expression policy must list at least one term"
  );

  assert.ok(DEFAULT_CREATIVE_QA_POLICY.brandTone);
  const bt = DEFAULT_CREATIVE_QA_POLICY.brandTone!;
  assert.ok(
    (bt.recommendedKeywords && bt.recommendedKeywords.length > 0) ||
      (bt.forbiddenTones && bt.forbiddenTones.length > 0),
    "default brand_tone policy must list at least one keyword/tone"
  );
});

test("DEFAULT_CREATIVE_QA_POLICY: a clean 1080x1080 mock-style asset with safe variant text passes every check", () => {
  // Mock provider が出す典型的な 1080x1080 PNG (1:1 aspect) と、ブランド整合の
  // ある variant text を組み合わせた場合、5 check すべて pass し overall は
  // qa_passed になる。production 経路の happy path をユニットでも担保する。
  const safeVariant: ImagePromptVariant = {
    prompt: "operator-grade ad creative, calm indigo accent",
    styleNotes: "minimalist, monochrome",
    negativePrompt: "logos, mascots",
    variantKey: "v0",
  };
  // 64 byte は default minByteSize と同値。実 mock 出力 (数百〜数 KB) より
  // 十分小さいが、warn / fail のしきい値には掛からない。
  const bytes = Uint8Array.from([
    ...PNG_SIG,
    ...new Array(120).fill(0),
  ]);
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({
        variantKey: "v0",
        width: 1080,
        height: 1080,
        bytes,
        byteSize: bytes.byteLength,
      }),
      variant: safeVariant,
    },
    DEFAULT_CREATIVE_QA_POLICY
  );
  for (const c of result.checks) {
    assert.equal(c.outcome, "pass", `${c.kind} should pass under DEFAULT_CREATIVE_QA_POLICY (got ${c.outcome}: ${c.detail})`);
  }
  assert.equal(result.overall, "qa_passed");
});

test("DEFAULT_CREATIVE_QA_POLICY: Codex-sized PNG below Meta max does not warn only for byte size", () => {
  const safeVariant: ImagePromptVariant = {
    prompt: "warm lounge ad creative with glass detail",
    styleNotes: "clean, calm, premium",
    negativePrompt: "",
    variantKey: "v0",
  };
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({
        variantKey: "v0",
        width: 1080,
        height: 1080,
        bytes: Uint8Array.from([...PNG_SIG, ...new Array(2_450_000).fill(0)]),
      }),
      variant: safeVariant,
    },
    DEFAULT_CREATIVE_QA_POLICY
  );

  assert.equal(result.overall, "qa_passed");
  assert.equal(result.checks.find((c) => c.kind === "quality")?.outcome, "pass");
});

test("DEFAULT_CREATIVE_QA_POLICY: a wrong-dimension asset is blocked from attachment", () => {
  // gate review finding: "wrong-size provider output is not blocked under the
  // production empty policy". DEFAULT_CREATIVE_QA_POLICY 適用時は dimensions
  // が aspect ratio + 短辺最低でガードされ、odd サイズは fail に倒れる。
  const safeVariant: ImagePromptVariant = {
    prompt: "operator-grade ad creative, calm indigo accent",
    styleNotes: "",
    negativePrompt: "",
    variantKey: "v0",
  };
  const result = evaluateCreativeQa(
    {
      asset: makePngAsset({ width: 137, height: 533 }),
      variant: safeVariant,
    },
    DEFAULT_CREATIVE_QA_POLICY
  );
  const dim = findCheck(result, "dimensions");
  assert.equal(dim.outcome, "fail");
  assert.equal(result.overall, "qa_failed");
});

test("aggregateOverall: a skipped blocking check forces qa_failed even if all other checks pass", () => {
  // 直接 evaluator の per-check 出力を組み立てた合成テスト: format=pass,
  // quality=skipped (non_blocking, OK), forbidden_expression=skipped
  // (blocking, NG), dimensions=pass, brand_tone=skipped (non_blocking, OK)。
  // 期待: overall=qa_failed (skipped blocking が PR 添付を物理的にブロック)。
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1080, height: 1080 }) },
    {
      dimensions: { aspectRatios: ["1:1"] },
      // forbiddenExpression / brandTone を意図的に未設定 → skipped
    }
  );
  // dimensions: pass
  assert.equal(findCheck(result, "dimensions").outcome, "pass");
  // forbidden_expression: skipped (no policy), default severity=blocking
  const fe = findCheck(result, "forbidden_expression");
  assert.equal(fe.outcome, "skipped");
  assert.equal(fe.severity, "blocking");
  // overall: skipped blocking ⇒ qa_failed
  assert.equal(result.overall, "qa_failed");
});

test("aggregateOverall: a skipped non_blocking check does NOT push overall to qa_failed", () => {
  // 対称: quality / brand_tone は default severity=non_blocking なので、
  // skipped でも overall は qa_passed (= 添付可能) のままにする。
  // dimensions は明示的に aspect ratio で pass、forbidden_expression は variant
  // 配下に明示的な terms (non-match) を渡して pass させる。
  const safeVariant: ImagePromptVariant = {
    prompt: "operator-grade ad creative",
    styleNotes: "",
    negativePrompt: "",
    variantKey: "v0",
  };
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1080, height: 1080 }), variant: safeVariant },
    {
      dimensions: { aspectRatios: ["1:1"] },
      forbiddenExpression: { terms: ["__never_match__"] },
      // quality / brandTone を未設定 → skipped (non_blocking)
    }
  );
  assert.equal(findCheck(result, "quality").outcome, "skipped");
  assert.equal(findCheck(result, "quality").severity, "non_blocking");
  assert.equal(findCheck(result, "brand_tone").outcome, "skipped");
  assert.equal(findCheck(result, "brand_tone").severity, "non_blocking");
  assert.equal(result.overall, "qa_passed");
});

test("aggregateOverall: a skipped check downgraded to info_only does not block attachment", () => {
  // info_only severity の check は outcome に関わらず overall を変化させない、
  // という既存契約は skipped に対しても保たれる。これは defense-in-depth
  // 規則 (skipped+blocking → fail) のもう一方の境界 (info_only → no impact)
  // を明示するテスト。
  const result = evaluateCreativeQa(
    { asset: makePngAsset({ width: 1080, height: 1080 }) },
    {
      dimensions: { aspectRatios: ["1:1"] },
      forbiddenExpression: { terms: ["__never_match__"] },
      severityOverrides: { forbidden_expression: "info_only" },
      // forbidden_expression は haystack がないので skipped に倒れるが、
      // info_only severity のため overall に影響しない。
    }
  );
  const fe = findCheck(result, "forbidden_expression");
  assert.equal(fe.outcome, "skipped");
  assert.equal(fe.severity, "info_only");
  assert.equal(result.overall, "qa_passed");
});

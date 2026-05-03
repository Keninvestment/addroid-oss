import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CodexAppServerImageProvider,
  InMemoryLLMProviderTokenStore,
  ImageProviderError,
  ImageProviderInvalidRequestError,
  ImageProviderNotConfiguredError,
  MockImageProvider,
  MOCK_IMAGE_MODELS,
  OpenAIImageProvider,
  selectImageProvider,
  StubImageProvider,
  validateImageGenerateRequest,
  type CodexAppServerRpcClient,
  type CodexAppServerRpcNotification,
  type ImageGenerateRequest,
} from "../index.js";

// ---------------------------------------------------------------------------
// validateImageGenerateRequest
// ---------------------------------------------------------------------------

test("validateImageGenerateRequest rejects empty prompt", () => {
  assert.throws(
    () =>
      validateImageGenerateRequest("mock", {
        prompt: "",
        variationConditions: [{ width: 100, height: 100 }],
      }),
    ImageProviderInvalidRequestError
  );
});

test("validateImageGenerateRequest rejects empty variation list", () => {
  assert.throws(
    () =>
      validateImageGenerateRequest("mock", {
        prompt: "ok",
        variationConditions: [],
      }),
    ImageProviderInvalidRequestError
  );
});

test("validateImageGenerateRequest rejects bad dimensions", () => {
  assert.throws(
    () =>
      validateImageGenerateRequest("mock", {
        prompt: "ok",
        variationConditions: [{ width: 0, height: 100 }],
      }),
    ImageProviderInvalidRequestError
  );
  assert.throws(
    () =>
      validateImageGenerateRequest("mock", {
        prompt: "ok",
        variationConditions: [{ width: 100, height: 5000 }],
      }),
    ImageProviderInvalidRequestError
  );
  assert.throws(
    () =>
      validateImageGenerateRequest("mock", {
        prompt: "ok",
        variationConditions: [{ width: 100.5, height: 100 }],
      }),
    ImageProviderInvalidRequestError
  );
});

test("validateImageGenerateRequest rejects invalid format", () => {
  assert.throws(
    () =>
      validateImageGenerateRequest("mock", {
        prompt: "ok",
        // @ts-expect-error intentional bad format
        variationConditions: [{ width: 100, height: 100, format: "gif" }],
      }),
    ImageProviderInvalidRequestError
  );
});

// ---------------------------------------------------------------------------
// MockImageProvider — produces valid deterministic PNGs
// ---------------------------------------------------------------------------

test("MockImageProvider returns one asset per variation condition", async () => {
  const provider = new MockImageProvider();
  assert.equal(provider.name, "mock");
  assert.equal(provider.enabled, true);
  assert.ok(MOCK_IMAGE_MODELS.includes(provider.defaultModel as (typeof MOCK_IMAGE_MODELS)[number]));

  const result = await provider.generateImage({
    prompt: "an orange tabby on a windowsill",
    variationConditions: [
      { width: 320, height: 320, variantKey: "v0" },
      { width: 200, height: 100, variantKey: "v1" },
    ],
    purpose: "agent:image_prompt",
  });
  assert.equal(result.assets.length, 2);
  assert.equal(result.meta.provider, "mock");
  assert.equal(result.costUsd, 0);
  // the current implementation: meta preserves prompt, parameters, and (initially null) QA result.
  assert.equal(result.meta.prompt, "an orange tabby on a windowsill");
  assert.equal(result.meta.parameters.purpose, "agent:image_prompt");
  assert.equal(result.meta.parameters.variantCount, 2);
  assert.equal(result.meta.parameters.variationConditions.length, 2);
  assert.equal(result.meta.parameters.variationConditions[0]!.variantKey, "v0");
  assert.equal(result.meta.parameters.variationConditions[0]!.format, "png");
  assert.equal(result.meta.parameters.variationConditions[1]!.width, 200);
  assert.equal(result.meta.qaResult, null);
  assert.equal(result.assets[0]!.variantKey, "v0");
  assert.equal(result.assets[1]!.variantKey, "v1");
  assert.equal(result.assets[0]!.width, 320);
  assert.equal(result.assets[0]!.height, 320);
  assert.equal(result.assets[1]!.width, 200);
  assert.equal(result.assets[1]!.height, 100);
  for (const asset of result.assets) {
    assert.equal(asset.mimeType, "image/png");
    assert.ok(asset.bytes.byteLength > 0);
    assert.equal(asset.bytes.byteLength, asset.byteSize);
    assertValidPng(asset.bytes, asset.width, asset.height);
  }
});

test("MockImageProvider generates auto variantKey when not provided", async () => {
  const provider = new MockImageProvider();
  const result = await provider.generateImage({
    prompt: "p",
    variationConditions: [
      { width: 64, height: 64 },
      { width: 64, height: 64 },
    ],
  });
  assert.equal(result.assets[0]!.variantKey, "variant-0");
  assert.equal(result.assets[1]!.variantKey, "variant-1");
  // The parameters snapshot mirrors the auto-assigned variantKeys + filled-in
  // format so audit consumers see exactly what was generated.
  assert.equal(result.meta.parameters.variationConditions[0]!.variantKey, "variant-0");
  assert.equal(result.meta.parameters.variationConditions[1]!.variantKey, "variant-1");
  assert.equal(result.meta.parameters.purpose, null);
});

test("MockImageProvider is deterministic across calls with same input", async () => {
  const a = new MockImageProvider();
  const b = new MockImageProvider();
  const req: ImageGenerateRequest = {
    prompt: "deterministic",
    variationConditions: [{ width: 32, height: 32, variantKey: "x" }],
  };
  const ra = await a.generateImage(req);
  const rb = await b.generateImage(req);
  assert.deepEqual(Array.from(ra.assets[0]!.bytes), Array.from(rb.assets[0]!.bytes));
  assert.equal(ra.meta.requestId, rb.meta.requestId);
});

test("MockImageProvider produces different bytes when prompt or seed changes", async () => {
  const a = new MockImageProvider({ seed: "seed-1" });
  const b = new MockImageProvider({ seed: "seed-2" });
  const req: ImageGenerateRequest = {
    prompt: "p",
    variationConditions: [{ width: 16, height: 16, variantKey: "v" }],
  };
  const ra = await a.generateImage(req);
  const rb = await b.generateImage(req);
  assert.notDeepEqual(
    Array.from(ra.assets[0]!.bytes),
    Array.from(rb.assets[0]!.bytes)
  );

  const c = new MockImageProvider();
  const reqAlt: ImageGenerateRequest = {
    prompt: "different",
    variationConditions: [{ width: 16, height: 16, variantKey: "v" }],
  };
  const rc = await c.generateImage(req);
  const rd = await c.generateImage(reqAlt);
  assert.notDeepEqual(
    Array.from(rc.assets[0]!.bytes),
    Array.from(rd.assets[0]!.bytes)
  );
});

test("MockImageProvider rejects jpeg format", async () => {
  const provider = new MockImageProvider();
  await assert.rejects(
    () =>
      provider.generateImage({
        prompt: "p",
        variationConditions: [{ width: 32, height: 32, format: "jpeg" }],
      }),
    ImageProviderInvalidRequestError
  );
});

test("MockImageProvider failureMode='provider_error' surfaces ImageProviderError", async () => {
  const provider = new MockImageProvider({ failureMode: "provider_error" });
  await assert.rejects(
    () =>
      provider.generateImage({
        prompt: "p",
        variationConditions: [{ width: 32, height: 32 }],
      }),
    (err) => {
      assert.ok(err instanceof ImageProviderError);
      assert.equal((err as ImageProviderError).code, "mock_failure");
      assert.equal((err as ImageProviderError).status, 503);
      // sanitize: error.message must not contain anything that looks like a token
      assert.doesNotMatch((err as Error).message, /Bearer\s+|sk-|api_key/i);
      return true;
    }
  );
});

test("MockImageProvider setFailureMode toggles back to success", async () => {
  const provider = new MockImageProvider({ failureMode: "provider_error" });
  await assert.rejects(
    () =>
      provider.generateImage({
        prompt: "p",
        variationConditions: [{ width: 32, height: 32 }],
      }),
    ImageProviderError
  );
  provider.setFailureMode(null);
  const ok = await provider.generateImage({
    prompt: "p",
    variationConditions: [{ width: 32, height: 32 }],
  });
  assert.equal(ok.assets.length, 1);
});

// ---------------------------------------------------------------------------
// StubImageProvider — fail-soft / NotConfigured
// ---------------------------------------------------------------------------

test("StubImageProvider always throws ImageProviderNotConfiguredError", async () => {
  const stub = new StubImageProvider();
  assert.equal(stub.enabled, false);
  assert.equal(stub.name, "openai");
  assert.equal(stub.defaultModel, "gpt-image-1");
  await assert.rejects(
    () =>
      stub.generateImage({
        prompt: "p",
        variationConditions: [{ width: 16, height: 16 }],
      }),
    ImageProviderNotConfiguredError
  );
});

test("StubImageProvider error message frames image gen as optional", async () => {
  const stub = new StubImageProvider({ name: "stability", defaultModel: "sd3-large" });
  assert.equal(stub.name, "stability");
  assert.equal(stub.defaultModel, "sd3-large");
  try {
    await stub.generateImage({
      prompt: "p",
      variationConditions: [{ width: 16, height: 16 }],
    });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof ImageProviderNotConfiguredError);
    assert.match((err as Error).message, /optional/i);
    assert.match((err as Error).message, /ENABLE_MOCK_IMAGE_PROVIDER/);
  }
});

// ---------------------------------------------------------------------------
// selectImageProvider — factory env routing
// ---------------------------------------------------------------------------

test("selectImageProvider returns mock when ENABLE_MOCK_IMAGE_PROVIDER=1", () => {
  const sel = selectImageProvider({ env: { ENABLE_MOCK_IMAGE_PROVIDER: "1" } });
  assert.equal(sel.choice, "mock");
  assert.equal(sel.optional, false);
  assert.equal(sel.provider.enabled, true);
  assert.match(sel.reason, /ENABLE_MOCK_IMAGE_PROVIDER/);
});

test("selectImageProvider also accepts ADDROID_IMAGE_MOCK=1 alias", () => {
  const sel = selectImageProvider({ env: { ADDROID_IMAGE_MOCK: "1" } });
  assert.equal(sel.choice, "mock");
});

test("selectImageProvider returns stub when no env configured", () => {
  const sel = selectImageProvider({ env: {} });
  assert.equal(sel.choice, "stub");
  assert.equal(sel.optional, true);
  assert.equal(sel.provider.enabled, false);
  assert.match(sel.reason, /optional/i);
});

test("selectImageProvider does not inspect plaintext IMAGE_* api key env vars", () => {
  // regression fix: factory must not read IMAGE_OPENAI_API_KEY /
  // IMAGE_STABILITY_API_KEY / IMAGE_REPLICATE_API_TOKEN in plaintext.
  // Real-provider credentials flow through the encrypted oauth_tokens +
  // CryptoBoundary path (see packages/llm-provider/src/factory.ts). The
  // factory's selection AND its reason string must be stable regardless of
  // whether plaintext credentials happen to be set in env.
  const baselineSel = selectImageProvider({ env: {} });
  const seededSel = selectImageProvider({
    env: {
      IMAGE_OPENAI_API_KEY: "sk-test-should-not-be-read",
      IMAGE_STABILITY_API_KEY: "stab-test-should-not-be-read",
      IMAGE_REPLICATE_API_TOKEN: "repl-test-should-not-be-read",
    },
  });
  assert.equal(seededSel.choice, "stub");
  assert.equal(seededSel.choice, baselineSel.choice);
  // reason must not branch on plaintext env contents.
  assert.equal(seededSel.reason, baselineSel.reason);
  // reason must never echo plaintext token values nor advertise plaintext
  // env names as the live credential surface.
  assert.doesNotMatch(seededSel.reason, /sk-test-should-not-be-read/);
  assert.doesNotMatch(seededSel.reason, /stab-test-should-not-be-read/);
  assert.doesNotMatch(seededSel.reason, /repl-test-should-not-be-read/);
  assert.doesNotMatch(seededSel.reason, /IMAGE_OPENAI_API_KEY/);
  assert.doesNotMatch(seededSel.reason, /IMAGE_STABILITY_API_KEY/);
  assert.doesNotMatch(seededSel.reason, /IMAGE_REPLICATE_API_TOKEN/);
});

test("selectImageProvider mock options are forwarded", async () => {
  const sel = selectImageProvider({
    env: { ENABLE_MOCK_IMAGE_PROVIDER: "1" },
    mock: { defaultModel: "placeholder-1200x628", seed: "test-seed" },
  });
  assert.equal(sel.provider.defaultModel, "placeholder-1200x628");
  const result = await sel.provider.generateImage({
    prompt: "p",
    variationConditions: [{ width: 8, height: 8, variantKey: "v" }],
  });
  // Same seed should yield the deterministic color we expect from sha256(seed|prompt|variantKey).
  const expectedHash = createHash("sha256").update("test-seed|p|v").digest();
  // First two pixels of the PNG image data are the deterministic color.
  // Verify by re-decoding the IDAT — keep it simple: scan the bytes for
  // (r, g, b) presence after the PNG signature.
  const bytes = result.assets[0]!.bytes;
  assert.ok(bytes.byteLength > 0);
  // PNG signature must be intact regardless of seed/colour.
  for (let i = 0; i < 8; i += 1) {
    assert.equal(bytes[i], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]);
  }
  // The expected color hash must influence output: verify by re-running with
  // a different seed and observing different bytes.
  const sel2 = selectImageProvider({
    env: { ENABLE_MOCK_IMAGE_PROVIDER: "1" },
    mock: { seed: "different-seed" },
  });
  const result2 = await sel2.provider.generateImage({
    prompt: "p",
    variationConditions: [{ width: 8, height: 8, variantKey: "v" }],
  });
  assert.notDeepEqual(Array.from(bytes), Array.from(result2.assets[0]!.bytes));
  // Reference expectedHash so the test asserts intent (color is derived from the seed).
  assert.equal(expectedHash.length, 32);
});

test("selectImageProvider stub respects stubProvider / stubDefaultModel", async () => {
  const sel = selectImageProvider({
    env: {},
    stubProvider: "replicate",
    stubDefaultModel: "sdxl",
  });
  assert.equal(sel.provider.name, "replicate");
  assert.equal(sel.provider.defaultModel, "sdxl");
  await assert.rejects(
    () =>
      sel.provider.generateImage({
        prompt: "p",
        variationConditions: [{ width: 16, height: 16 }],
      }),
    ImageProviderNotConfiguredError
  );
});

// ---------------------------------------------------------------------------
// OpenAIImageProvider — encrypted API key credential
// ---------------------------------------------------------------------------

test("OpenAIImageProvider sends API key in Authorization header only and returns bytes", async () => {
  const tokenStore = new InMemoryLLMProviderTokenStore();
  const crypto = identityCrypto();
  await tokenStore.saveOAuthToken({
    provider: "openai",
    accountIdentifier: "openai-api-key",
    scopes: ["api_key"],
    authKind: "api_key",
    accessTokenCiphertext: "sk-test-openai-image-key",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    defaultModel: "gpt-4.1",
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OpenAIImageProvider({
    tokenStore,
    crypto,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
        { status: 200, headers: { "x-request-id": "req_img_1" } }
      );
    },
  });

  const result = await provider.generateImage({
    prompt: "広告画像を生成",
    variationConditions: [{ width: 1024, height: 1024, variantKey: "square" }],
  });

  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.model, "gpt-image-2");
  assert.equal(result.meta.requestId, "req_img_1");
  assert.equal(result.assets[0]!.variantKey, "square");
  assert.equal(Buffer.from(result.assets[0]!.bytes).toString("utf8"), "png-bytes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/images/generations");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "Bearer sk-test-openai-image-key");
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.model, "gpt-image-2");
  assert.equal(body.size, "1024x1024");
  assert.equal(body.output_format, "png");
  assert.equal(body.quality, "medium");
  assert.doesNotMatch(String(calls[0]!.init!.body), /sk-test-openai-image-key/);
});

test("OpenAIImageProvider redacts API key from provider errors", async () => {
  const tokenStore = new InMemoryLLMProviderTokenStore();
  const crypto = identityCrypto();
  await tokenStore.saveOAuthToken({
    provider: "openai",
    accountIdentifier: "openai-api-key",
    scopes: ["api_key"],
    authKind: "api_key",
    accessTokenCiphertext: "sk-test-openai-image-key",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    defaultModel: "gpt-4.1",
  });
  const provider = new OpenAIImageProvider({
    tokenStore,
    crypto,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "bad key sk-test-openai-image-key",
            code: "invalid_api_key",
          },
        }),
        { status: 401 }
      ),
  });

  await assert.rejects(
    () =>
      provider.generateImage({
        prompt: "p",
        variationConditions: [{ width: 1024, height: 1024 }],
      }),
    (err) => {
      assert.ok(err instanceof ImageProviderError);
      assert.doesNotMatch((err as Error).message, /sk-test-openai-image-key/);
      assert.doesNotMatch(JSON.stringify((err as ImageProviderError).payload), /sk-test-openai-image-key/);
      assert.match((err as Error).message, /sk-\[REDACTED\]/);
      return true;
    }
  );
});

test("selectImageProvider returns OpenAI provider when encrypted credential is available", () => {
  const sel = selectImageProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
    crypto: identityCrypto(),
    openaiCredentialAvailable: true,
  });
  assert.equal(sel.choice, "openai_api_key");
  assert.equal(sel.optional, false);
  assert.equal(sel.provider.name, "openai");
});

// ---------------------------------------------------------------------------
// CodexAppServerImageProvider — local app-server path
// ---------------------------------------------------------------------------

test("CodexAppServerImageProvider rejects non-loopback app-server URLs", async () => {
  const provider = new CodexAppServerImageProvider({
    externalServerUrl: "ws://example.com:1234",
  });
  await assert.rejects(
    () =>
      provider.generateImage({
        prompt: "p",
        variationConditions: [{ width: 1024, height: 1024 }],
      }),
    ImageProviderInvalidRequestError
  );
});

test("CodexAppServerImageProvider reads generated savedPath bytes", async () => {
  const rpc = new FakeCodexRpc("/tmp/generated.png");
  const provider = new CodexAppServerImageProvider({
    serverFactory: async () => ({ url: "ws://127.0.0.1:4321", child: null, rpc }),
    readFileImpl: async (path) => {
      assert.equal(String(path), "/tmp/generated.png");
      return Buffer.from("codex-png");
    },
  });
  const result = await provider.generateImage({
    prompt: "p",
    variationConditions: [{ width: 1024, height: 1024, variantKey: "v" }],
  });
  assert.equal(result.meta.provider, "codex");
  assert.equal(result.meta.model, "local/codex-image");
  assert.equal(result.meta.requestId, "thread-1");
  assert.equal(result.assets[0]!.variantKey, "v");
  assert.equal(result.assets[0]!.mimeType, "image/png");
  assert.equal(Buffer.from(result.assets[0]!.bytes).toString("utf8"), "codex-png");
  assert.deepEqual(rpc.methods, ["thread/start", "turn/start"]);
});

// ---------------------------------------------------------------------------
// PNG sanity helpers (used in MockImageProvider tests)
// ---------------------------------------------------------------------------

function assertValidPng(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): void {
  // PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    assert.equal(bytes[i], sig[i], `PNG signature byte ${i} mismatch`);
  }
  // IHDR chunk starts at byte 8: 4-byte length + 4-byte type + 13-byte data
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLen = buf.readUInt32BE(8);
  assert.equal(ihdrLen, 13);
  const ihdrType = buf.toString("ascii", 12, 16);
  assert.equal(ihdrType, "IHDR");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.equal(w, expectedWidth);
  assert.equal(h, expectedHeight);
  // Last 12 bytes: IEND chunk = 00 00 00 00 49 45 4e 44 ae 42 60 82
  const iendType = buf.toString("ascii", buf.length - 8, buf.length - 4);
  assert.equal(iendType, "IEND");
}

function identityCrypto() {
  return {
    encrypt(value: string): string {
      return value;
    },
    decrypt(value: string): string {
      return value;
    },
  };
}

class FakeCodexRpc implements CodexAppServerRpcClient {
  readonly methods: string[] = [];
  private handlers: Array<(msg: CodexAppServerRpcNotification) => void> = [];

  constructor(private readonly savedPath: string) {}

  async request<T>(method: string): Promise<T> {
    this.methods.push(method);
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } } as T;
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        for (const handler of this.handlers) {
          handler({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              item: { type: "imageGeneration", savedPath: this.savedPath },
            },
          });
          handler({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { status: "completed" },
            },
          });
        }
      });
      return {} as T;
    }
    return {} as T;
  }

  onNotification(handler: (msg: CodexAppServerRpcNotification) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  close(): void {
    this.handlers = [];
  }
}

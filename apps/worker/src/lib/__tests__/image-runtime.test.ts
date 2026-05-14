import test from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@addroid/db";
import { selectImageProviderForWorker } from "../image-runtime.js";

test("selectImageProviderForWorker uses encrypted OpenAI API key for image generation", async () => {
  const prisma = fakePrisma({
    provider: "openai",
    accountIdentifier: "openai-api-key",
    scopes: ["api_key"],
    accessTokenCiphertext: "v1.ciphertext",
    refreshTokenCiphertext: null,
    expiresAt: null,
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: { defaultModel: "gpt-4.1", authKind: "api_key" },
  });
  const sel = await selectImageProviderForWorker(
    { ENCRYPTION_KEY: "12345678901234567890123456789012" } as NodeJS.ProcessEnv,
    { prisma }
  );
  assert.equal(sel.choice, "openai_api_key");
  assert.equal(sel.provider.name, "openai");
  assert.equal(sel.optional, false);
});

test("selectImageProviderForWorker fails soft when OpenAI image provider is requested without a stored key", async () => {
  const sel = await selectImageProviderForWorker(
    {
      ENCRYPTION_KEY: "12345678901234567890123456789012",
      ADDROID_IMAGE_PROVIDER: "openai",
    } as NodeJS.ProcessEnv,
    { prisma: fakePrisma(null) }
  );
  assert.equal(sel.choice, "stub");
  assert.equal(sel.provider.name, "openai");
  assert.equal(sel.optional, true);
});

test("selectImageProviderForWorker can prefer Codex app-server from the selected LLM path", async () => {
  const sel = await selectImageProviderForWorker({} as NodeJS.ProcessEnv, {
    prisma: fakePrisma(null),
    preferCodex: true,
  });
  assert.equal(sel.choice, "codex");
  assert.equal(sel.provider.name, "codex");
  assert.equal(sel.optional, false);
});

test("selectImageProviderForWorker keeps Codex preference ahead of stored OpenAI credentials", async () => {
  const prisma = fakePrisma({
    provider: "openai",
    accountIdentifier: "openai-api-key",
    scopes: ["api_key"],
    accessTokenCiphertext: "v1.ciphertext",
    refreshTokenCiphertext: null,
    expiresAt: null,
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: { defaultModel: "gpt-4.1", authKind: "api_key" },
  });
  const sel = await selectImageProviderForWorker(
    { ENCRYPTION_KEY: "12345678901234567890123456789012" } as NodeJS.ProcessEnv,
    { prisma, preferCodex: true }
  );
  assert.equal(sel.choice, "codex");
  assert.equal(sel.provider.name, "codex");
  assert.equal(sel.optional, false);
});

function fakePrisma(row: unknown): PrismaClient {
  return {
    oAuthToken: {
      findFirst: async () => row,
    },
  } as unknown as PrismaClient;
}

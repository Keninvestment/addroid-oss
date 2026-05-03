// AdDroid OSS — worker ImageProvider wiring.
//
// Keeps credential lookup at the worker boundary. The llm-provider package
// owns provider adapters, while this file decides whether encrypted OpenAI API
// key credentials or Codex app-server mode are available for the current
// process.

import { getCryptoBoundary } from "@addroid/config";
import {
  InMemoryLLMProviderTokenStore,
  selectImageProvider,
  type ImageProviderChoice,
  type ImageProviderSelection,
  type LLMProviderTokenStore,
} from "@addroid/llm-provider";
import type { CryptoBoundary } from "@addroid/config";
import type { PrismaClient } from "@addroid/db";
import { createPrismaLLMProviderTokenStore } from "./llm-runtime.js";

export interface WorkerImageProviderSelection extends ImageProviderSelection {
  choice: ImageProviderChoice;
}

export interface SelectImageProviderForWorkerOptions {
  prisma?: PrismaClient;
  /** true when the selected LLM route is Codex OAuth/app-server compatible. */
  preferCodex?: boolean;
}

function tryGetCryptoBoundary(env: NodeJS.ProcessEnv): CryptoBoundary | null {
  try {
    return getCryptoBoundary(env);
  } catch {
    return null;
  }
}

function normalizeImageProvider(value: string | undefined | null): "openai" | "codex" | "mock" | null {
  const v = value?.trim().toLowerCase();
  if (v === "openai" || v === "codex" || v === "mock") return v;
  return null;
}

export async function selectImageProviderForWorker(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectImageProviderForWorkerOptions = {}
): Promise<WorkerImageProviderSelection> {
  const explicit = normalizeImageProvider(env.ADDROID_IMAGE_PROVIDER);
  if (
    env.ADDROID_IMAGE_MOCK === "1" ||
    env.ENABLE_MOCK_IMAGE_PROVIDER === "1" ||
    explicit === "mock"
  ) {
    return selectImageProvider({ env });
  }

  const tokenStore: LLMProviderTokenStore = opts.prisma
    ? createPrismaLLMProviderTokenStore(opts.prisma)
    : new InMemoryLLMProviderTokenStore();
  const crypto = tryGetCryptoBoundary(env);

  const openaiCredentialAvailable =
    Boolean(crypto) && Boolean(await tokenStore.loadOAuthToken("openai"));

  return selectImageProvider({
    env,
    tokenStore,
    ...(crypto ? { crypto } : {}),
    openaiCredentialAvailable,
    preferCodex: explicit === "codex" || (!explicit && opts.preferCodex),
    openai: {
      defaultModel: env.ADDROID_OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
      imagesGenerationsUrl: env.ADDROID_OPENAI_IMAGES_GENERATIONS_URL?.trim() || null,
      quality: normalizeQuality(env.ADDROID_OPENAI_IMAGE_QUALITY),
    },
    codex: {
      defaultModel: env.ADDROID_CODEX_IMAGE_MODEL?.trim() || "local/codex-image",
      externalServerUrl:
        env.ADDROID_CODEX_APP_SERVER_URL?.trim() ||
        env.CODEX_APP_SERVER_URL?.trim() ||
        null,
      codexBin: env.CODEX_BIN?.trim() || "codex",
      cwd: env.ADDROID_CODEX_IMAGE_CWD?.trim() || "/private/tmp",
      parallel: normalizePositiveInteger(env.ADDROID_CODEX_IMAGE_PARALLEL),
    },
  });
}

function normalizeQuality(value: string | undefined): "low" | "medium" | "high" | "auto" {
  const v = value?.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "auto") return v;
  return "medium";
}

function normalizePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

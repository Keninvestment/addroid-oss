import { NextResponse } from "next/server";
import { Prisma } from "@addroid/db";
import {
  defaultApiKeyChatUrl,
  type ApiKeyLLMProviderName,
} from "@addroid/llm-provider";
import { getCryptoBoundary } from "@addroid/config";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../lib/github-runtime";
import { requireTrustedJsonWebAction } from "../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  provider?: unknown;
  apiKey?: unknown;
  model?: unknown;
  baseUrl?: unknown;
}

const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";

export async function POST(request: Request) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }

  const provider = normalizeProvider(payload.provider);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: "provider は openai / anthropic のどちらかを指定してください。" },
      { status: 400 }
    );
  }
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "API key を入力してください。" },
      { status: 400 }
    );
  }
  if (!looksLikeApiKey(provider, apiKey)) {
    return NextResponse.json(
      { ok: false, error: `${provider} API key の形式が想定と異なります。` },
      { status: 400 }
    );
  }
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : defaultModel(provider);
  const baseUrl =
    typeof payload.baseUrl === "string" && payload.baseUrl.trim()
      ? payload.baseUrl.trim()
      : defaultApiKeyChatUrl(provider);
  if (!/^https:\/\//i.test(baseUrl)) {
    return NextResponse.json(
      { ok: false, error: "baseUrl は https URL で指定してください。" },
      { status: 400 }
    );
  }

  try {
    const crypto = getCryptoBoundary(process.env);
    const workspace = await ensureWebWorkspace();
    const connectedAt = new Date();
    const accountIdentifier = `${provider}-api-key`;
    const metadata = {
      authKind: "api_key",
      defaultModel: model,
      apiBaseUrl: baseUrl,
    } satisfies Prisma.InputJsonValue;
    await prisma.oAuthToken.upsert({
      where: {
        provider_accountIdentifier: {
          provider,
          accountIdentifier,
        },
      },
      update: {
        scopes: [],
        accessTokenCiphertext: crypto.encrypt(apiKey),
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt,
        metadata,
      },
      create: {
        provider,
        accountIdentifier,
        scopes: [],
        accessTokenCiphertext: crypto.encrypt(apiKey),
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt,
        metadata,
      },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:ai-ui",
        action: "oauth.llm.connected_via_web",
        target: `oauth_tokens:${provider}:${accountIdentifier}`,
        ref: provider,
        metadata: {
          provider,
          authKind: "api_key",
          defaultModel: model,
          apiBaseUrl: baseUrl,
          connectedAt: connectedAt.toISOString(),
        },
      },
    });
    return NextResponse.json({
      ok: true,
      provider,
      accountIdentifier,
      defaultModel: model,
      apiBaseUrl: baseUrl,
      connectedAt: connectedAt.toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  const provider = normalizeProvider(payload.provider);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: "provider は openai / anthropic のどちらかを指定してください。" },
      { status: 400 }
    );
  }
  try {
    const workspace = await ensureWebWorkspace();
    const result = await prisma.oAuthToken.deleteMany({ where: { provider } });
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:ai-ui",
        action: "oauth.llm.disconnected_via_web",
        target: `oauth_tokens:${provider}`,
        ref: provider,
        metadata: { provider, removed: result.count },
      },
    });
    return NextResponse.json({ ok: true, provider, removed: result.count });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

function normalizeProvider(value: unknown): ApiKeyLLMProviderName | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "openai" || v === "anthropic" ? v : null;
}

function defaultModel(provider: ApiKeyLLMProviderName): string {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
}

function looksLikeApiKey(provider: ApiKeyLLMProviderName, value: string): boolean {
  if (provider === "openai") return /^sk-[A-Za-z0-9_-]{20,}$/.test(value);
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value);
}

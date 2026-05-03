// AdDroid OSS — Codex OAuth callback endpoint.
//
// 1) provider.completeOAuth({code, state}) で authorization code → access/refresh
//    token を交換し、暗号化境界越しに `oauth_tokens` (provider="codex") に upsert
//    する。state 不一致は CSRF として弾く (LLMOAuthStateMismatchError)。
//    provider/model などの非機微メタは `oauth_tokens.metadata` JSON 列に保存され、
//    worker の `selectLLMProviderForWorker` が同じ行を読み出して
//    CodexLLMProvider.complete() で使う。
// 2) audit_logs に `oauth.codex.connected` イベントを 1 行残す
//    (target=`oauth_tokens:codex:<accountIdentifier>`)。トークン平文は metadata
//    に絶対に詰めない。
// 3) `/ai` へ ?oauth=connected[&account=...&provider=codex&model=...]
//    付きで 302 リダイレクトし、UI 側で Toast / banner 表示する。

import { NextResponse } from "next/server";
import { LLMOAuthStateMismatchError } from "@addroid/llm-provider";
import { prisma } from "../../../../../lib/prisma";
import { getActiveCodexProviderSelection } from "../../../../../lib/codex-runtime";
import { ensureWebWorkspace } from "../../../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return errorRedirect(url, "Missing code or state in callback URL.");
  }

  let connection;
  try {
    const { provider } = getActiveCodexProviderSelection();
    connection = await provider.completeOAuth({ code, state });
  } catch (err) {
    const reason =
      err instanceof LLMOAuthStateMismatchError
        ? "OAuth state mismatch (possible CSRF)."
        : (err as Error).message;
    return errorRedirect(url, reason);
  }

  // Audit log. Token / refresh_token はここに詰めない (metadata は機微外のみ)。
  try {
    const ws = await ensureWebWorkspace();
    await prisma.auditLog.create({
      data: {
        workspaceId: ws.id,
        actor: "user:codex-oauth",
        action: "oauth.codex.connected",
        target: `oauth_tokens:codex:${connection.accountIdentifier}`,
        ref: connection.accountIdentifier,
        metadata: {
          provider: connection.provider,
          defaultModel: connection.defaultModel,
          scopes: connection.scopes,
          connectedAt: connection.connectedAt,
          expiresAt: connection.expiresAt,
        },
      },
    });
  } catch (err) {
    return errorRedirect(
      url,
      `Codex OAuth は完了しましたが audit log の書き込みに失敗しました: ${(err as Error).message}`
    );
  }

  const next = new URL("/ai", url);
  next.searchParams.set("oauth", "connected");
  next.searchParams.set("provider", connection.provider);
  next.searchParams.set("account", connection.accountIdentifier);
  next.searchParams.set("model", connection.defaultModel);
  return NextResponse.redirect(next, { status: 302 });
}

function errorRedirect(base: URL, reason: string): NextResponse {
  const next = new URL("/ai", base);
  next.searchParams.set("oauth", "error");
  next.searchParams.set("reason", reason);
  return NextResponse.redirect(next, { status: 302 });
}

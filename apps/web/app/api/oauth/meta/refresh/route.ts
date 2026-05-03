// AdDroid OSS — Meta OAuth long-lived token refresh endpoint.
//
// `/accounts` の "再認証" 導線から POST される。既存の long-lived token を
// `fb_exchange_token` で再交換し、新しい expiresAt を保存する。
// 失敗時 (token revoked / scope 変更等) は 401 を返し、UI が `Connect Meta` への
// 誘導に切替える。
// audit_logs に oauth.meta.refreshed (成功) または oauth.meta.reauth_required (失敗)
// を 1 行残す。

import { NextResponse } from "next/server";
import {
  MetaAdapterUnauthenticatedError,
  MetaOAuthExchangeError,
  MetaTokenExpiredError,
} from "@addroid/meta-adapter";
import { prisma } from "../../../../../lib/prisma";
import {
  ensureWebWorkspace,
  getActiveMetaAdapter,
} from "../../../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  let ws: { id: string };
  try {
    ws = await ensureWebWorkspace();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `workspace bootstrap failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  try {
    const { adapter, choice } = await getActiveMetaAdapter();
    if (choice === "stub") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Meta OAuth is not configured. Set ADDROID_META_OAUTH_MOCK=1 or fill secrets.local.yaml.",
        },
        { status: 400 }
      );
    }
    const result = await adapter.refreshLongLivedToken();
    await prisma.auditLog.create({
      data: {
        workspaceId: ws.id,
        actor: "user:meta-oauth",
        action: "oauth.meta.refreshed",
        target: `oauth_tokens:meta:${result.accountIdentifier}`,
        ref: result.accountIdentifier,
        metadata: {
          refreshedAt: result.refreshedAt,
          expiresAt: result.expiresAt,
          scopes: result.scopes,
        },
      },
    });
    return NextResponse.json({
      ok: true,
      accountIdentifier: result.accountIdentifier,
      refreshedAt: result.refreshedAt,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    // Reauth-required (401) covers all failure modes that require the user to
    // restart OAuth from /accounts:
    //   - MetaAdapterUnauthenticatedError: no stored token at all
    //   - MetaTokenExpiredError: stored token is past expiresAt
    //   - MetaOAuthExchangeError: Meta rejected fb_exchange_token (revoked,
    //     scope removed, app secret rotated, etc.)
    // Any other error is an internal failure (500) and must NOT trigger the
    // reauth CTA.
    const reauthRequired =
      err instanceof MetaAdapterUnauthenticatedError ||
      err instanceof MetaTokenExpiredError ||
      err instanceof MetaOAuthExchangeError;
    const status = reauthRequired ? 401 : 500;
    await prisma.auditLog
      .create({
        data: {
          workspaceId: ws.id,
          actor: "user:meta-oauth",
          action: "oauth.meta.reauth_required",
          target: "oauth_tokens:meta",
          metadata: {
            error: (err as Error).message,
            errorName: (err as Error).name,
            reauthRequired,
          },
        },
      })
      .catch(() => undefined);
    return NextResponse.json(
      { ok: false, error: (err as Error).message, reauthRequired },
      { status }
    );
  }
}

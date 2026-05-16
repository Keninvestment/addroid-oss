// AdDroid OSS — Meta OAuth callback endpoint.
//
// 1) adapter.completeOAuth(code, state) で short-lived → long-lived トークンを交換し、
//    暗号化境界越しに oauth_tokens に upsert する。state 不一致は CSRF として弾く。
// 2) 同時に Meta Graph API から /me/businesses と /me/adaccounts を取得し、runtime cache
//    と (新規分のみ) ad_accounts テーブルに登録する。
// 3) audit_logs に oauth.meta.connected イベントを 1 行残す。
// 4) `/accounts` へ ?oauth=connected[&accounts=N] 付きで 302 リダイレクトし、UI 側で
//    Toast / banner 表示する。

import { NextResponse } from "next/server";
import {
  fetchMetaAssetReadiness,
  MetaOAuthStateMismatchError,
} from "@addroid/meta-adapter";
import { Prisma } from "@addroid/db";
import { prisma } from "../../../../../lib/prisma";
import {
  ensureWebWorkspace,
  getActiveMetaAdapter,
  setMetaBusinessCache,
} from "../../../../../lib/meta-runtime";

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
    const { adapter } = await getActiveMetaAdapter();
    connection = await adapter.completeOAuth({ code, state });
  } catch (err) {
    const reason =
      err instanceof MetaOAuthStateMismatchError
        ? "OAuth state mismatch (possible CSRF)."
        : (err as Error).message;
    return errorRedirect(url, reason);
  }

  // Persist business cache + register ad accounts.
  let registered = 0;
  let assetReadiness: unknown[] = [];
  try {
    const ws = await ensureWebWorkspace();
    setMetaBusinessCache({
      businesses: connection.businesses,
      adAccounts: connection.adAccounts,
      fetchedAt: new Date(),
      accountIdentifier: connection.accountIdentifier,
    });
    let updated = 0;
    for (const acc of connection.adAccounts) {
      const key = acc.metaAccountId; // 例: "act_1234567890"
      const existing = await prisma.adAccount.findFirst({
        where: { workspaceId: ws.id, OR: [{ metaAccountId: acc.metaAccountId }, { key }] },
        select: { id: true, key: true, displayName: true, metaAccountId: true },
      });
      const data = {
        displayName:
          existing && !shouldRefreshDisplayName(existing)
            ? existing.displayName
            : acc.name || existing?.displayName || key,
        metaAccountId: acc.metaAccountId,
        businessId: acc.businessId ?? null,
        businessName: acc.businessName ?? null,
        currency: acc.currency ?? null,
        timezoneName: acc.timezoneName ?? null,
        accountStatus: acc.accountStatus ?? null,
        active: true,
      };
      if (existing) {
        await prisma.adAccount.update({
          where: { id: existing.id },
          data,
        });
        updated += 1;
      } else {
        await prisma.adAccount.create({
          data: {
            workspaceId: ws.id,
            key,
            ...data,
          },
        });
        registered += 1;
      }
    }
    const { adapter } = await getActiveMetaAdapter();
    const lease = await adapter.loadAccessTokenPlaintext().catch(() => null);
    if (lease) {
      assetReadiness = await Promise.all(
        connection.adAccounts.slice(0, 10).map((account) =>
          fetchMetaAssetReadiness({
            accessToken: lease.accessToken,
            adAccountId: account.metaAccountId,
            limit: 50,
          })
        )
      );
    }
    // 1 件しかない場合のみ自動で既定にする。複数ある場合は UI で明示選択する。
    const wsRow = await prisma.workspace.findUnique({
      where: { id: ws.id },
      select: { defaultAdAccountId: true },
    });
    if (!wsRow?.defaultAdAccountId && connection.adAccounts.length === 1) {
      const first = await prisma.adAccount.findFirst({
        where: { workspaceId: ws.id },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (first) {
        await prisma.workspace.update({
          where: { id: ws.id },
          data: { defaultAdAccountId: first.id },
        });
      }
    }
    await prisma.auditLog.create({
      data: {
        workspaceId: ws.id,
        actor: "user:meta-oauth",
        action: "oauth.meta.connected",
        target: `oauth_tokens:meta:${connection.accountIdentifier}`,
        ref: connection.accountIdentifier,
        metadata: {
          scopes: connection.scopes,
          connectedAt: connection.connectedAt,
          expiresAt: connection.expiresAt,
          businessesFetched: connection.businesses.length,
          adAccountsFetched: connection.adAccounts.length,
          adAccountsRegistered: registered,
          adAccountsUpdated: updated,
          assetReadiness: assetReadiness as Prisma.InputJsonValue,
        },
      },
    });
  } catch (err) {
    return errorRedirect(
      url,
      `Meta OAuth は完了しましたが Ad Account 登録に失敗しました: ${(err as Error).message}`
    );
  }

  const next = new URL(connection.adAccounts.length > 1 ? "/accounts/select" : "/accounts", url);
  next.searchParams.set("oauth", "connected");
  next.searchParams.set("accounts", String(registered));
  next.searchParams.set(
    "assetCheck",
    assetReadiness.some((report) => isReadinessBlocked(report)) ? "attention" : "ok"
  );
  return NextResponse.redirect(next, { status: 302 });
}

function errorRedirect(base: URL, reason: string): NextResponse {
  const next = new URL("/accounts", base);
  next.searchParams.set("oauth", "error");
  next.searchParams.set("reason", reason);
  return NextResponse.redirect(next, { status: 302 });
}

function shouldRefreshDisplayName(account: {
  key: string;
  displayName: string;
  metaAccountId: string | null;
}): boolean {
  return (
    account.displayName.trim().length === 0 ||
    account.displayName === account.key ||
    account.displayName === account.metaAccountId
  );
}

function isReadinessBlocked(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false
  );
}

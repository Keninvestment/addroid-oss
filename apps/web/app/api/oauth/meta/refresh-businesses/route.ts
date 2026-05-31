// AdDroid OSS — Meta Business / Ad Account の最新一覧を再取得し runtime cache に保存。
//
// `/accounts` の Refresh Businesses ボタンから POST される。
// /me/businesses と /me/adaccounts を Meta Graph API で再取得し、Ad Account を
// ad_accounts テーブルに同期する。

import { NextResponse } from "next/server";
import {
  fetchMetaAssetReadiness,
  MetaAdapterUnauthenticatedError,
} from "@addroid/meta-adapter";
import { prisma } from "../../../../../lib/prisma";
import {
  ensureWebWorkspace,
  getActiveMetaAdapter,
  setMetaBusinessCache,
} from "../../../../../lib/meta-runtime";
import { requireTrustedWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireTrustedWebAction(request);
  if (denied) return denied;

  try {
    const { adapter, choice } = await getActiveMetaAdapter();
    if (choice === "stub") {
      return NextResponse.json(
        { ok: false, error: "Meta Access Token is not configured." },
        { status: 400 }
      );
    }
    const ws = await ensureWebWorkspace();
    const lease = await adapter.loadAccessTokenPlaintext();
    const accountIdentifier = lease?.accountIdentifier ?? "meta";
    const [businessesResult, adAccountsResult] = await Promise.allSettled([
      adapter.fetchBusinesses(),
      adapter.fetchAdAccounts(),
    ]);
    if (adAccountsResult.status === "rejected") {
      throw adAccountsResult.reason instanceof Error
        ? adAccountsResult.reason
        : new Error(String(adAccountsResult.reason));
    }
    const businesses =
      businessesResult.status === "fulfilled" ? businessesResult.value : [];
    const businessError =
      businessesResult.status === "rejected"
        ? businessesResult.reason instanceof Error
          ? businessesResult.reason.message
          : String(businessesResult.reason)
        : null;
    const adAccounts = adAccountsResult.value;
    setMetaBusinessCache({
      businesses,
      adAccounts,
      fetchedAt: new Date(),
      accountIdentifier,
    });
    let registered = 0;
    let updated = 0;
    const accountRows: {
      id: string;
      key: string;
      displayName: string;
      metaAccountId: string | null;
      businessName: string | null;
      currency: string | null;
      timezoneName: string | null;
    }[] = [];
    for (const acc of adAccounts) {
      const key = acc.metaAccountId;
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
        const row = await prisma.adAccount.update({
          where: { id: existing.id },
          data,
          select: accountRowSelect(),
        });
        accountRows.push(row);
        updated += 1;
      } else {
        const row = await prisma.adAccount.create({
          data: {
            workspaceId: ws.id,
            key,
            ...data,
          },
          select: accountRowSelect(),
        });
        accountRows.push(row);
        registered += 1;
      }
    }
    const assetReadiness = lease
      ? await Promise.all(
          adAccounts.slice(0, 10).map((account) =>
            fetchMetaAssetReadiness({
              accessToken: lease.accessToken,
              adAccountId: account.metaAccountId,
              limit: 50,
            })
          )
        )
      : [];
    return NextResponse.json({
      ok: true,
      businesses: businesses.length,
      adAccounts: adAccounts.length,
      registered,
      updated,
      businessError,
      accountRows,
      assetReadiness,
    });
  } catch (err) {
    const status = err instanceof MetaAdapterUnauthenticatedError ? 401 : 500;
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status }
    );
  }
}

function accountRowSelect() {
  return {
    id: true,
    key: true,
    displayName: true,
    metaAccountId: true,
    businessName: true,
    currency: true,
    timezoneName: true,
  } as const;
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

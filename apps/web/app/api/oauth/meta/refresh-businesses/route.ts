// AdDroid OSS — Meta Business / Ad Account の最新一覧を再取得し runtime cache に保存。
//
// `/accounts` の Refresh Businesses ボタンから POST される。
// /me/businesses と /me/adaccounts を Meta GraphQL で再取得し、Ad Account を
// ad_accounts テーブルに同期する。

import { NextResponse } from "next/server";
import {
  MetaAdapterUnauthenticatedError,
} from "@addroid/meta-adapter";
import { prisma } from "../../../../../lib/prisma";
import {
  ensureWebWorkspace,
  getActiveMetaAdapter,
  setMetaBusinessCache,
} from "../../../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { adapter, choice } = await getActiveMetaAdapter();
    if (choice === "stub") {
      return NextResponse.json(
        { ok: false, error: "Meta OAuth is not configured." },
        { status: 400 }
      );
    }
    const ws = await ensureWebWorkspace();
    const lease = await adapter.loadAccessTokenPlaintext();
    const accountIdentifier = lease?.accountIdentifier ?? "meta";
    const [businesses, adAccounts] = await Promise.all([
      adapter.fetchBusinesses(),
      adapter.fetchAdAccounts(),
    ]);
    setMetaBusinessCache({
      businesses,
      adAccounts,
      fetchedAt: new Date(),
      accountIdentifier,
    });
    let registered = 0;
    let updated = 0;
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
    return NextResponse.json({
      ok: true,
      businesses: businesses.length,
      adAccounts: adAccounts.length,
      registered,
      updated,
    });
  } catch (err) {
    const status = err instanceof MetaAdapterUnauthenticatedError ? 401 : 500;
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status }
    );
  }
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

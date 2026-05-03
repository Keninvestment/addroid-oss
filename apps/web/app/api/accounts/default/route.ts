// AdDroid OSS — デフォルト Ad Account 切替エンドポイント。
//
// /accounts ページの radio 操作から呼ばれる。
// Workspace.defaultAdAccountId を更新し、audit_logs に account.default_changed を記録する。

import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

interface Body {
  adAccountId?: unknown;
}

export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  const adAccountId =
    typeof payload.adAccountId === "string" ? payload.adAccountId.trim() : "";
  if (!adAccountId) {
    return NextResponse.json(
      { ok: false, error: "adAccountId is required." },
      { status: 400 }
    );
  }
  try {
    const ws = await ensureWebWorkspace();
    const account = await prisma.adAccount.findFirst({
      where: { id: adAccountId, workspaceId: ws.id },
      select: { id: true, key: true, displayName: true, metaAccountId: true },
    });
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Specified ad_account is not registered in this workspace." },
        { status: 404 }
      );
    }
    const before = await prisma.workspace.findUnique({
      where: { id: ws.id },
      select: { defaultAdAccountId: true },
    });
    if (before?.defaultAdAccountId === account.id) {
      return NextResponse.json({ ok: true, already: true, account });
    }
    await prisma.workspace.update({
      where: { id: ws.id },
      data: { defaultAdAccountId: account.id },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId: ws.id,
        actor: "user:accounts-ui",
        action: "account.default_changed",
        target: `ad_account:${account.id}`,
        ref: account.metaAccountId ?? account.key,
        metadata: {
          previousAdAccountId: before?.defaultAdAccountId ?? null,
          newAdAccountId: account.id,
          displayName: account.displayName,
        },
      },
    });
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

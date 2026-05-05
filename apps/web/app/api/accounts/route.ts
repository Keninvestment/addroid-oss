// AdDroid OSS — Ad Account の手動登録エンドポイント。
//
// /accounts ページの "Add account" モーダルから呼ばれる。
// Meta Access Token でフェッチした `me/adaccounts` に含まれないアカウントを、
// ユーザーが明示的に登録するときに使う (例: 後から付与された権限のもの)。

import { NextResponse } from "next/server";
import { Prisma } from "@addroid/db";
import { prisma } from "../../../lib/prisma";
import { ensureWebWorkspace } from "../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

interface Body {
  key?: unknown;
  displayName?: unknown;
  metaAccountId?: unknown;
}

const KEY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const META_ID_PATTERN = /^act_\d{1,32}$/;

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
  const key = typeof payload.key === "string" ? payload.key.trim() : "";
  const displayName =
    typeof payload.displayName === "string" ? payload.displayName.trim() : "";
  const metaAccountId =
    typeof payload.metaAccountId === "string" ? payload.metaAccountId.trim() : "";

  if (!KEY_PATTERN.test(key)) {
    return NextResponse.json(
      {
        ok: false,
        error: "key は半角英数 / . _ - のみ、64 文字以内で指定してください。",
      },
      { status: 400 }
    );
  }
  if (!displayName) {
    return NextResponse.json(
      { ok: false, error: "displayName は必須です。" },
      { status: 400 }
    );
  }
  if (metaAccountId && !META_ID_PATTERN.test(metaAccountId)) {
    return NextResponse.json(
      { ok: false, error: "metaAccountId は act_<digits> 形式で指定してください。" },
      { status: 400 }
    );
  }

  try {
    const ws = await ensureWebWorkspace();
    const created = await prisma.adAccount.create({
      data: {
        workspaceId: ws.id,
        key,
        displayName,
        metaAccountId: metaAccountId || null,
        active: true,
      },
      select: { id: true, key: true, displayName: true, metaAccountId: true },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId: ws.id,
        actor: "user:accounts-ui",
        action: "ad_account.registered",
        target: `ad_account:${created.id}`,
        ref: created.metaAccountId ?? created.key,
        metadata: { key: created.key, displayName: created.displayName },
      },
    });
    return NextResponse.json({ ok: true, account: created });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { ok: false, error: `key="${key}" は既に登録されています。` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

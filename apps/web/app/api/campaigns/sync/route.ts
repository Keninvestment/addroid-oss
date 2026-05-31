import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace, getActiveMetaAdapter } from "../../../../lib/meta-runtime";
import { requireTrustedWebAction } from "../../../../lib/request-guard";
import { runMetaMirrorSync } from "../../../../../worker/src/lib/meta-mirror-runtime";

export const dynamic = "force-dynamic";

interface Body {
  accountId?: unknown;
}

export async function POST(request: Request) {
  const denied = requireTrustedWebAction(request);
  if (denied) return denied;

  let payload: Body = {};
  try {
    payload = (await request.json()) as Body;
  } catch {
    /* body は任意 */
  }

  const workspace = await ensureWebWorkspace();
  const accountId =
    typeof payload.accountId === "string" && payload.accountId.trim()
      ? payload.accountId.trim()
      : null;
  const { adapter } = await getActiveMetaAdapter();
  const lease = await adapter.loadAccessTokenPlaintext();
  if (!lease?.accessToken) {
    return NextResponse.json(
      { ok: false, error: "Meta token が未接続です。" },
      { status: 401 }
    );
  }

  try {
    const result = await runMetaMirrorSync({
      prisma,
      workspaceId: workspace.id,
      accessToken: lease.accessToken,
      accountId,
      actor: "user:web-ui",
      source: "web-api",
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = (err as Error).message;
    const status = /アカウント|未設定/.test(message) ? 400 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

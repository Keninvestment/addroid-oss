// AdDroid OSS — POST /api/cron/[name]/toggle (this implementation).
//
// /cron 行の "enabled" トグルから呼ばれる。CLI の `addroid schedule enable | disable` と
// 同じ DB + pg-boss 更新を行い、audit_logs に `cron.enabled_via_web` /
// `cron.disabled_via_web` を残す (actor は server 側で固定)。

import { NextResponse } from "next/server";
import { isCronPresetName, toggleCron } from "../../../../../lib/cron-actions";

export const dynamic = "force-dynamic";

interface Body {
  enabled?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!isCronPresetName(name)) {
    return NextResponse.json(
      { ok: false, error: `Unknown cron preset: ${name}` },
      { status: 400 }
    );
  }
  let payload: Body = {};
  try {
    payload = (await request.json()) as Body;
  } catch {
    /* body は任意 */
  }
  if (typeof payload.enabled !== "boolean") {
    return NextResponse.json(
      { ok: false, error: "Body must contain { enabled: boolean }." },
      { status: 400 }
    );
  }

  const result = await toggleCron(name, payload.enabled);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status }
    );
  }
  return NextResponse.json(
    { ok: true, enabled: result.enabled, cron: result.cron },
    { status: 200 }
  );
}

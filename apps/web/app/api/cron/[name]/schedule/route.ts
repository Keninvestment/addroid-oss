// AdDroid OSS — POST /api/cron/[name]/schedule (this implementation).
//
// /cron 行の cron 式エディタから呼ばれる。CLI の `addroid schedule set` と同じく、
// 永続化前に validateCronExpression で 5 フィールド標準 crontab 構文を厳格に
// 検証する (disabled なプリセットでも cron_schedules.cron に malformed な値が
// 残らないことを保証する)。enabled なら pg-boss schedule も再登録する。

import { NextResponse } from "next/server";
import { isCronPresetName, setCronSchedule } from "../../../../../lib/cron-actions";
import { requireTrustedJsonWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  cron?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

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
  if (typeof payload.cron !== "string" || payload.cron.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "Body must contain { cron: string }." },
      { status: 400 }
    );
  }

  const result = await setCronSchedule(name, payload.cron);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status }
    );
  }
  return NextResponse.json(
    {
      ok: true,
      cron: result.cron,
      enabled: result.enabled,
      reschedulePending: result.reschedulePending,
    },
    { status: 200 }
  );
}

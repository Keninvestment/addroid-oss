// AdDroid OSS — POST /api/cron/[name]/schedule (this implementation).
//
// /cron 行の cron 式エディタから呼ばれる。CLI の `addroid cron set` と同じく、
// 永続化前に validateCronExpression で 5 フィールド標準 crontab 構文を厳格に
// 検証する (disabled なプリセットでも cron_schedules.cron に malformed な値が
// 残らないことを保証する)。enabled なら pg-boss schedule も再登録する。

import { NextResponse } from "next/server";
import { isCronPresetName, setCronSchedule } from "../../../../../lib/cron-actions";

export const dynamic = "force-dynamic";

interface Body {
  cron?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: { name: string } }
) {
  if (!isCronPresetName(params.name)) {
    return NextResponse.json(
      { ok: false, error: `Unknown cron preset: ${params.name}` },
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

  const result = await setCronSchedule(params.name, payload.cron);
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

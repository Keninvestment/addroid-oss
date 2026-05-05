// AdDroid OSS — POST /api/cron/[name]/run (this implementation).
//
// /cron 行の "今すぐ実行" ボタンから呼ばれる。CLI の `addroid cron run` と同じく、
// pg-boss に 1 回限りのジョブを enqueue するだけで、実際の実行は worker プロセス側で
// 行われる (worker 未起動時は queue に積まれ、worker 起動後にハンドラへ流れる)。
//
// audit_logs に `cron.manual_run_via_web` を必ず残す (the current implementation approval
// attribution / acceptance #20: 全書き込みは actor prefix `web:` で帰属する)。

import { NextResponse } from "next/server";
import { isCronPresetName, runCronNow } from "../../../../../lib/cron-actions";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!isCronPresetName(name)) {
    return NextResponse.json(
      { ok: false, error: `Unknown cron preset: ${name}` },
      { status: 400 }
    );
  }

  const result = await runCronNow(name);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status }
    );
  }
  return NextResponse.json(
    { ok: true, jobId: result.jobId },
    { status: 200 }
  );
}

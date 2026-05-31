import { NextResponse } from "next/server";
import { runAgentTaskNow } from "../../../../../lib/agent-tasks";
import { requireTrustedWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireTrustedWebAction(request);
  if (denied) return denied;

  const { id } = await params;
  try {
    const result = await runAgentTaskNow(id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 }
    );
  }
}

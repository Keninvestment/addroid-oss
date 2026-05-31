import { NextResponse } from "next/server";
import { setAgentTaskEnabled } from "../../../../../lib/agent-tasks";
import { requireTrustedJsonWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  enabled?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  const { id } = await params;
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  try {
    const task = await setAgentTaskEnabled(id, payload.enabled === true);
    return NextResponse.json({ ok: true, task });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 }
    );
  }
}

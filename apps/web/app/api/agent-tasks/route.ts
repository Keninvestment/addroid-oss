import { NextResponse } from "next/server";
import { createAgentTask } from "../../../lib/agent-tasks";

export const dynamic = "force-dynamic";

interface Body {
  title?: unknown;
  prompt?: unknown;
  cron?: unknown;
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
  try {
    const task = await createAgentTask({
      title: typeof payload.title === "string" ? payload.title : undefined,
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      cron: typeof payload.cron === "string" ? payload.cron : "",
    });
    return NextResponse.json({ ok: true, task });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 }
    );
  }
}

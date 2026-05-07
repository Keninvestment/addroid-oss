import { NextResponse } from "next/server";
import { runWebAgentChat } from "../../../lib/agent-chat";

export const dynamic = "force-dynamic";

interface Body {
  input?: unknown;
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
  const input = typeof payload.input === "string" ? payload.input : "";
  const result = await runWebAgentChat(input).catch((err) => ({
    ok: false,
    message: "",
    executions: [],
    error: (err as Error).message,
  }));
  if ("error" in result) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

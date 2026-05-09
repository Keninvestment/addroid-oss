import { NextResponse } from "next/server";
import { Prisma } from "@addroid/db";
import { ensureWebWorkspace } from "../../../../lib/github-runtime";
import { prisma } from "../../../../lib/prisma";

export const dynamic = "force-dynamic";

type Mode = "report_only" | "proposal" | "auto_apply";

export async function POST(request: Request) {
  let payload: { mode?: unknown };
  try {
    payload = (await request.json()) as { mode?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  const mode = normalizeMode(payload.mode);
  if (!mode) {
    return NextResponse.json(
      { ok: false, error: "mode must be report_only, proposal, or auto_apply." },
      { status: 400 }
    );
  }
  try {
    const workspace = await ensureWebWorkspace();
    const updated = await prisma.workspace.update({
      where: { id: workspace.id },
      data: { executionMode: mode },
      select: { executionMode: true },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:web-ui",
        action: "automation.mode_updated_via_web",
        target: "workspace.executionMode",
        metadata: { mode } as Prisma.InputJsonValue,
      },
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, mode: updated.executionMode });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

function normalizeMode(value: unknown): Mode | null {
  return value === "report_only" || value === "proposal" || value === "auto_apply"
    ? value
    : null;
}

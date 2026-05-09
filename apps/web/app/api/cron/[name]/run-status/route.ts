// AdDroid OSS — GET /api/cron/[name]/run-status.
//
// Manual run UI polls this endpoint after pg-boss accepts a job. The job may be
// queued before the worker creates cron_runs, so "not found yet" is reported as
// queued instead of an error.

import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { isCronPresetName } from "../../../../../lib/cron-actions";
import { ensureWebWorkspace } from "../../../../../lib/github-runtime";

export const dynamic = "force-dynamic";

export async function GET(
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

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) {
    return NextResponse.json(
      { ok: false, error: "jobId is required." },
      { status: 400 }
    );
  }

  const workspace = await ensureWebWorkspace();
  const run = await prisma.cronRun.findFirst({
    where: {
      name,
      jobId,
      OR: [
        { schedule: { is: { workspaceId: workspace.id } } },
        { executionLogs: { some: { workspaceId: workspace.id } } },
      ],
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      state: true,
      errorMessage: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  if (!run) {
    return NextResponse.json({
      ok: true,
      state: "queued",
      runId: null,
      errorMessage: null,
    });
  }

  return NextResponse.json({
    ok: true,
    state: run.state,
    runId: run.id,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  });
}

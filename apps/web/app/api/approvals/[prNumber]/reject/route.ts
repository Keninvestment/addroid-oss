import { NextResponse } from "next/server";
import {
  ApprovalDecisionError,
  decidePullRequestApproval,
} from "../../../../../../worker/src/lib/approval-decision-runtime";
import { prisma } from "../../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../../lib/github-runtime";
import { requireTrustedJsonWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  expectedHeadSha?: unknown;
  comment?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ prNumber: string }> }
) {
  const untrustedResponse = requireTrustedJsonWebAction(request);
  if (untrustedResponse) return untrustedResponse;

  const { prNumber: prNumberRaw } = await params;
  const prNumber = Number.parseInt(prNumberRaw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid PR number." },
      { status: 400 }
    );
  }

  let payload: Body;
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    payload = parsed as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Reject requests must include a valid JSON body." },
      { status: 400 }
    );
  }

  const expectedHeadSha =
    typeof payload.expectedHeadSha === "string" && payload.expectedHeadSha.trim().length > 0
      ? payload.expectedHeadSha.trim()
      : undefined;
  if (expectedHeadSha === undefined) {
    return NextResponse.json(
      { ok: false, error: "Reject requests must include expectedHeadSha." },
      { status: 400 }
    );
  }
  const comment =
    typeof payload.comment === "string" && payload.comment.trim().length > 0
      ? payload.comment.trim()
      : undefined;
  const workspace = await ensureWebWorkspace();

  try {
    const result = await decidePullRequestApproval({
      prisma,
      workspaceId: workspace.id,
      prNumber,
      action: "reject",
      actor: "user:web-ui",
      decisionSource: "web_reject",
      expectedHeadSha,
      ...(comment ? { comment } : {}),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const status = err instanceof ApprovalDecisionError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

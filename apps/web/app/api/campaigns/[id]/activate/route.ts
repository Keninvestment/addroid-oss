// AdDroid OSS — POST /api/campaigns/[id]/activate.
//
// `/campaigns` の per-row "配信開始PR" ボタン (ConfirmDialog 通過後) から呼ばれる。
//
// 受入基準:
//   - Web UI は Meta を直接変更しない。
//   - 配信開始は GitOps PR を作成し、人間の merge 後に apply 経路で反映する。
//   - PAUSED でないノードは拒否する。
//   - Meta から同期しただけのノードも operations/*.json PR として扱う。

import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../../lib/meta-runtime";
import { getActiveGithubAdapter } from "../../../../../lib/github-runtime";
import { createOpsChangeProposal } from "../../../../../../worker/src/lib/ops-proposal-runtime";

export const dynamic = "force-dynamic";

interface Body {
  // regression fix: `source` / `actor` は意図的にここに含めない。
  // Web 経路では常にサーバー側で固定するため、body から受け取らない。
  note?: unknown;
}

const WEB_ACTIVATE_SOURCE = "web" as const;
const WEB_ACTIVATE_ACTOR = "user:web-ui" as const;

const HIERARCHY_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: hierarchyId } = await params;
  if (!hierarchyId || !HIERARCHY_ID_PATTERN.test(hierarchyId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid ads_hierarchy id." },
      { status: 400 }
    );
  }

  let payload: Body = {};
  try {
    payload = (await request.json()) as Body;
  } catch {
    /* body は任意 */
  }
  // regression fix: actor/source はここで固定する。body に `source` や `actor`
  // が含まれていてもサーバー側で評価しないため、CLI を装った監査記録は不可能。
  // 唯一 body から受け取るのは `note` (任意の理由文) のみ。
  const note =
    typeof payload.note === "string" && payload.note.trim().length > 0
      ? payload.note.trim().slice(0, 256)
      : undefined;

  try {
    const workspace = await ensureWebWorkspace();
    const node = await prisma.adsHierarchyNode.findFirst({
      where: { id: hierarchyId, account: { workspaceId: workspace.id } },
      select: {
        id: true,
        nodeType: true,
        nodeKey: true,
        displayName: true,
        status: true,
        externalId: true,
        account: { select: { key: true, metaAccountId: true } },
      },
    });
    if (!node) {
      return NextResponse.json(
        {
          ok: false,
          error: "指定された広告オブジェクトは現在のワークスペースに存在しません。",
        },
        { status: 404 }
      );
    }

    if (node.nodeType !== "campaign" && node.nodeType !== "adset" && node.nodeType !== "ad") {
      return NextResponse.json(
        { ok: false, error: "配信開始PRを作成できない広告オブジェクト種別です。" },
        { status: 422 }
      );
    }
    if (node.status.toUpperCase() !== "PAUSED") {
      return NextResponse.json(
        { ok: false, error: "PAUSED の広告オブジェクトだけ配信開始PRを作成できます。" },
        { status: 409 }
      );
    }
    const { adapter } = await getActiveGithubAdapter();
    const result = await createOpsChangeProposal({
      prisma,
      githubAdapter: adapter,
      workspaceId: workspace.id,
      input: {
        intent: "activate",
        accountKey: node.account.key,
        targets: [{ level: node.nodeType, id: node.nodeKey }],
        desiredChanges: {
          initialState: "active",
          status: "ACTIVE",
          level: node.nodeType,
        },
        rationale:
          note ??
          `Web UI request to activate ${node.nodeType} ${node.displayName}${
            node.externalId ? ` (${node.externalId})` : ""
          }.`,
        urgency: "normal",
      },
      actor: WEB_ACTIVATE_ACTOR,
      source: WEB_ACTIVATE_SOURCE,
    });

    return NextResponse.json({
      ok: true,
      message: "配信開始の GitOps PR を作成しました。merge 後に反映されます。",
      prNumber: result.prNumber,
      htmlUrl: result.htmlUrl,
      pullRequestId: result.pullRequestId,
      headSha: result.headSha,
      planOk: result.planOk,
      planSummary: result.planSummary,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message,
      },
      { status: 500 }
    );
  }
}

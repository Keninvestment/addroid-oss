// AdDroid OSS — POST /api/campaigns/[id]/activate.
//
// `/campaigns` の per-row "ACTIVE にする" ボタン (ConfirmDialog 通過後) から呼ばれる。
//
// 受入基準:
//   - "Activate is separate from Apply and records who triggered it, from CLI or
//      Web UI API, before changing PAUSED to ACTIVE."
//   - PAUSED でないノードは拒否する。
//   - Meta CLI 連携時は MetaCliRunner 経由で `<resource> activate` を実行し、
//     成功時のみ ads_hierarchy.status = active に更新。
//   - audit_logs に activate.requested → activate.committed (or rejected) が
//     最低 2 行記録される。
//   - 失敗 (auth/rate/api/unknown) でも UI が判別できるよう、ack に reason を返す。
//
// regression fix: actor/source は本ハンドラ (Web 経路) で常に
// "user:web-ui" / "web" を強制する。クライアントが body に渡す `source` は
// 無視し、CLI を装った監査記録の偽装 (source=cli / actor=user:cli) を
// 不可能にする。CLI 経路は apps/cli/src/commands/activate.ts が独自に
// runActivate を呼び source="cli" を確定させる。

import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { getActiveMetaAdapter } from "../../../../../lib/meta-runtime";
import { executeActivate } from "../../../../../../worker/src/lib/activate-runtime";
import type { ActivateOutcomeStatus } from "@addroid/queue";

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

/** outcome → HTTP status の射影。UI が ack を読み取って分岐できるよう詳細にする。 */
function statusForOutcome(outcome: ActivateOutcomeStatus): number {
  switch (outcome) {
    case "activated":
      return 200;
    case "already_active":
    case "not_paused":
    case "no_external_id":
      return 409;
    case "node_not_found":
      return 404;
    case "skipped_unsupported":
      return 422;
    case "auth_error":
      return 401;
    case "rate_limit_exhausted":
      return 429;
    case "api_error":
    case "unknown_error":
    default:
      return 502;
  }
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const hierarchyId = params.id;
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
    const { adapter } = await getActiveMetaAdapter();
    const { summary, executorSelection } = await executeActivate({
      prisma,
      metaAdapter: adapter,
      request: {
        hierarchyId,
        actor: WEB_ACTIVATE_ACTOR,
        source: WEB_ACTIVATE_SOURCE,
        ...(note !== undefined ? { note } : {}),
      },
    });

    const ok = summary.status === "activated";
    const httpStatus = statusForOutcome(summary.status);
    return NextResponse.json(
      {
        ok,
        outcome: summary.status,
        message: summary.message,
        attempts: summary.attempts,
        externalId: summary.externalId,
        finalAuditAction: summary.finalAuditAction,
        executorMode: executorSelection.mode,
        ...(ok ? {} : { error: summary.message }),
      },
      { status: httpStatus }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        outcome: "unknown_error" satisfies ActivateOutcomeStatus,
        error: (err as Error).message,
      },
      { status: 500 }
    );
  }
}

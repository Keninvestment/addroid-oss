// AdDroid OSS — `/api/plan` (ad-hoc dry-run / plan endpoint).
//
// Web UI の /plans ページから呼ばれる。CLI/CI と同じ runPlanForRoot を共有する
// ことで、UI からの dry-run と CLI からの dry-run が完全に同等の結果になる
// (acceptance: operation manifests can be converted into a dry-run plan)。
//
// 入力:
//   POST /api/plan
//   { accountId?: string }   ad_accounts.id を指すと、その account.key だけ
//                            plan に絞り込まれる。未指定なら全 brand を回す。
//
// セキュリティ:
//   - リポジトリパスを request body から受け取らない。
//     `ADDROID_OPS_REPO_LOCAL_DIR` (worker と同じ env) のみを参照する。
//   - accountId は Prisma で workspace 配下に存在する row のみ受け入れる。

import fs from "node:fs";
import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { ensureWebWorkspace } from "../../../lib/meta-runtime";
import { requireTrustedJsonWebAction } from "../../../lib/request-guard";
import {
  createPrismaPlanStore,
  persistPlanRun,
  runPlanForRoot,
} from "../../../../worker/src/lib/plan-runtime";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "../../../../worker/src/lib/ops-repo-local";

export const dynamic = "force-dynamic";

interface Body {
  accountId?: unknown;
}

export async function POST(request: Request) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }

  const accountId =
    typeof payload.accountId === "string" ? payload.accountId.trim() : "";

  const env = process.env;
  const baseDir = env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  const ws = await ensureWebWorkspace();
  const checkout = await ensureOpsRepoLocalCheckout({
    prisma: prisma as never,
    workspaceId: ws.id,
  }).catch(() => null);
  const rootDir =
    checkout?.rootDir ??
    (await resolveOpsRepoLocalDirForWorkspace({
      prisma: prisma as never,
      workspaceId: ws.id,
    })).rootDir ??
    "";
  if (!rootDir) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ops repo の local checkout を解決できません。GitHub 接続と ops repo bootstrap を完了してください。",
      },
      { status: 400 }
    );
  }
  if (!fs.existsSync(rootDir)) {
    return NextResponse.json(
      {
        ok: false,
        error: `ADDROID_OPS_REPO_LOCAL_DIR (${rootDir}) は存在しません。`,
      },
      { status: 400 }
    );
  }

  let workspaceId: string | null = null;
  let accountFilter: string | null = null;
  try {
    workspaceId = ws.id;
    if (accountId) {
      const account = await prisma.adAccount.findFirst({
        where: { id: accountId, workspaceId: ws.id },
        select: { key: true },
      });
      if (!account) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Specified ad_account is not registered in this workspace.",
          },
          { status: 404 }
        );
      }
      accountFilter = account.key;
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `workspace を解決できません: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  let result;
  try {
    result = runPlanForRoot({
      rootDir,
      baseDir,
      accountFilter,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `plan の生成に失敗: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  let executionLogId: string | null = null;
  try {
    const store = createPrismaPlanStore(prisma);
    const recorded = await persistPlanRun({
      store,
      workspaceId,
      source: "web",
      triggeredBy: "user:plans-ui",
      rootDir,
      baseDir,
      accountFilter,
      result,
    });
    executionLogId = recorded.id;
  } catch (err) {
    // 履歴に書けなくても plan 結果は返す (UI は inline 表示できる)。
    return NextResponse.json({
      ok: result.ok,
      executionLogId: null,
      result,
      persistError: (err as Error).message,
    });
  }

  return NextResponse.json({
    ok: result.ok,
    executionLogId,
    result,
  });
}

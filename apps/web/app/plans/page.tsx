// AdDroid OSS — /plans ページ.
//
// 仕様 (UI plan §6.2):
//   - Ad-hoc Dry-run: 登録済み Ad Account から選び、`/api/plan` を呼ぶ。
//   - Plan History: execution_logs.kind = "plan" の直近 50 件。
//     行展開で PlanPreview を表示。
//
// 設計原則:
//   - すべての行は Prisma クエリ由来 (No Placeholder Data)。
//   - SSR から /api/* を fetch しない (Prisma を直接参照)。

import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { Pagination } from "../../components/ui/Pagination";
import { InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { AdhocPlanForm } from "./AdhocPlanForm";
import { PlanHistoryRow } from "./PlanHistoryRow";
import type { PlanRunPayloadJson } from "../../../worker/src/lib/plan-runtime";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/meta-runtime";
import { getPaginationState, paginationLabel } from "../../lib/pagination";

export const dynamic = "force-dynamic";

interface AccountRow {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
  timezoneName: string | null;
}

interface RawLogRow {
  id: string;
  createdAt: Date;
  message: string;
  level: string;
  payload: unknown;
}

interface SearchParamsInput {
  historyPage?: string | string[];
}

export default async function PlansPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  let dbReady = true;
  let accounts: AccountRow[] = [];
  let defaultAdAccountId: string | null = null;
  let logs: RawLogRow[] = [];
  let logsTotal = 0;

  try {
    const currentWorkspace = await ensureWebWorkspace();
    const ws = await prisma.workspace.findUnique({
      where: { id: currentWorkspace.id },
      select: { defaultAdAccountId: true },
    });
    if (ws) {
      defaultAdAccountId = ws.defaultAdAccountId ?? null;
      const logsWhere = { workspaceId: currentWorkspace.id, kind: "plan" };
      logsTotal = await prisma.executionLog.count({ where: logsWhere });
      const historyPagination = getPaginationState(
        resolvedSearchParams,
        "historyPage",
        logsTotal
      );
      [accounts, logs] = await Promise.all([
        prisma.adAccount.findMany({
          where: { workspaceId: currentWorkspace.id, active: true },
          orderBy: [{ createdAt: "asc" }],
          select: {
            id: true,
            key: true,
            displayName: true,
            metaAccountId: true,
            timezoneName: true,
          },
        }),
        prisma.executionLog.findMany({
          where: logsWhere,
          orderBy: { createdAt: "desc" },
          skip: historyPagination.skip,
          take: historyPagination.take,
          select: {
            id: true,
            createdAt: true,
            message: true,
            level: true,
            payload: true,
          },
        }),
      ]);
    }
  } catch {
    dbReady = false;
  }

  const opsRepoLocalDir = process.env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || "";
  const opsRepoBaseDir = process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || "";
  const defaultAccount = accounts.find((account) => account.id === defaultAdAccountId) ?? null;
  const pageDisplayTimeZone = resolveDisplayTimeZone(defaultAccount?.timezoneName);
  const historyPagination = getPaginationState(
    resolvedSearchParams,
    "historyPage",
    logsTotal
  );

  const rows = logs
    .map((row) => {
      const payload = parsePayload(row.payload);
      if (!payload) return null;
      return {
          id: row.id,
          createdAt: formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
          message: row.message,
        payload,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <>
      <PageHeader
        title="入稿前チェック"
        subtitle="広告変更を反映する前に、変更件数・注意点・リスクを確認します。この画面だけでは Meta へ反映しません。"
      />

      <div className="page-body page-body--single">
        <Panel
          title="準備状態"
          subtitle="入稿前チェックに必要な変更ファイルの場所"
        >
          <KeyValueList
            items={[
              {
                label: "変更ファイル",
                value: opsRepoLocalDir ? (
                  <InlineCode>{opsRepoLocalDir}</InlineCode>
                ) : (
                  "(未設定)"
                ),
              },
              {
                label: "比較元",
                value: opsRepoBaseDir ? (
                  <InlineCode>{opsRepoBaseDir}</InlineCode>
                ) : (
                  "(未設定 — base 比較なし)"
                ),
              },
            ]}
          />
        </Panel>

        <Panel
          title="今すぐチェック"
          subtitle="対象の広告アカウントを選び、反映前の確認だけを実行します。"
        >
          {!dbReady ? (
            <EmptyState
              title="DB に接続できません。"
              description="接続と健康状態を確認してください。"
            />
          ) : !opsRepoLocalDir ? (
            <EmptyState
              title="変更ファイルの場所が未設定です。"
              description="GitHub 連携または接続と健康状態を確認してください。"
            />
          ) : accounts.length === 0 ? (
            <EmptyState
              title="登録済みの広告アカウントがありません。"
              description="広告アカウント画面から登録すると、ここで対象を選択できます。"
            />
          ) : (
            <AdhocPlanForm
              accounts={accounts}
              defaultAdAccountId={defaultAdAccountId}
            />
          )}
        </Panel>

        <Panel
          title="チェック履歴"
          subtitle={`${paginationLabel(historyPagination)}。行を開くと変更内容を確認できます。`}
        >
          {!dbReady ? (
            <EmptyState
              title="DB に接続できません。"
              description="接続と健康状態を確認してください。"
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title="チェック履歴はまだありません。"
              description="上の「今すぐチェック」を実行すると記録されます。"
            />
          ) : (
            <div>
              <table className="data-table plan-history">
                <thead>
                  <tr>
                    <th scope="col" className="tabular">Time</th>
                    <th scope="col">Account</th>
                    <th scope="col">実行元</th>
                    <th scope="col" className="tabular">変更数</th>
                    <th scope="col">リスク</th>
                    <th scope="col" className="tabular">所要時間</th>
                    <th scope="col">詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <PlanHistoryRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
              <Pagination
                basePath="/plans"
                searchParams={resolvedSearchParams}
                pageParam="historyPage"
                state={historyPagination}
              />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

/** payload JSON を PlanRunPayloadJson として安全にパースする。 */
function parsePayload(raw: unknown): PlanRunPayloadJson | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string") return null;
  if (typeof r.ok !== "boolean") return null;
  if (typeof r.risk !== "string") return null;
  if (typeof r.durationMs !== "number") return null;
  if (!r.totalCounts || typeof r.totalCounts !== "object") return null;
  if (!Array.isArray(r.perAccount)) return null;
  return raw as PlanRunPayloadJson;
}

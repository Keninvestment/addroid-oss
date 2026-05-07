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
import { InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { AdhocPlanForm } from "./AdhocPlanForm";
import { PlanHistoryRow } from "./PlanHistoryRow";
import type { PlanRunPayloadJson } from "../../../worker/src/lib/plan-runtime";

export const dynamic = "force-dynamic";

interface AccountRow {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
}

interface RawLogRow {
  id: string;
  createdAt: Date;
  message: string;
  level: string;
  payload: unknown;
}

export default async function PlansPage() {
  let dbReady = true;
  let accounts: AccountRow[] = [];
  let defaultAdAccountId: string | null = null;
  let logs: RawLogRow[] = [];

  try {
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true, defaultAdAccountId: true },
    });
    if (ws) {
      defaultAdAccountId = ws.defaultAdAccountId ?? null;
      [accounts, logs] = await Promise.all([
        prisma.adAccount.findMany({
          where: { workspaceId: ws.id, active: true },
          orderBy: [{ createdAt: "asc" }],
          select: {
            id: true,
            key: true,
            displayName: true,
            metaAccountId: true,
          },
        }),
        prisma.executionLog.findMany({
          where: { kind: "plan" },
          orderBy: { createdAt: "desc" },
          take: 50,
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

  const rows = logs
    .map((row) => {
      const payload = parsePayload(row.payload);
      if (!payload) return null;
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        message: row.message,
        payload,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle="Ads YAML から Meta apply 内容を dry-run で生成し、変更件数とリスクを確認します。CLI / CI / Web UI の全経路が同じ runner を使います。"
      />

      <div className="page-body page-body--single">
        <Panel
          title="Ops repo binding"
          subtitle="サーバー側 ENV から解決される checkout パス。Web UI からはこれらの値しか読み取りません。"
        >
          <KeyValueList
            items={[
              {
                label: "ADDROID_OPS_REPO_LOCAL_DIR",
                value: opsRepoLocalDir ? (
                  <InlineCode>{opsRepoLocalDir}</InlineCode>
                ) : (
                  "(未設定)"
                ),
              },
              {
                label: "ADDROID_OPS_REPO_BASE_DIR",
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
          title="Ad-hoc Dry-run"
          subtitle="サーバー側で /api/plan が呼ばれます。結果は下の History にも記録されます。"
        >
          {!dbReady ? (
            <EmptyState
              title="DB に接続できません。"
              description="npm run db:push で prisma スキーマを反映してください。"
            />
          ) : !opsRepoLocalDir ? (
            <EmptyState
              title="ops repo の checkout パスが未設定です。"
              description="ADDROID_OPS_REPO_LOCAL_DIR に ops repo の絶対パスを設定して再起動してください。"
            />
          ) : accounts.length === 0 ? (
            <EmptyState
              title="登録済みの Ad Account がありません。"
              description="/accounts から登録すると、ここで対象を選択できます。"
            />
          ) : (
            <AdhocPlanForm
              accounts={accounts}
              defaultAdAccountId={defaultAdAccountId}
            />
          )}
        </Panel>

        <Panel
          title="Plan History"
          subtitle="execution_logs.kind = 'plan' の直近 50 件。行展開で PlanPreview を表示します。"
        >
          {!dbReady ? (
            <EmptyState
              title="DB に接続できません。"
              description="npm run db:push で prisma スキーマを反映してください。"
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Plan 履歴はまだありません。"
              description="CLI (addroid submit --save), CI ワークフロー, または上の Ad-hoc Dry-run で実行すると記録されます。"
            />
          ) : (
            <table className="data-table plan-history">
              <thead>
                <tr>
                  <th scope="col" className="tabular">Time</th>
                  <th scope="col">Account</th>
                  <th scope="col">Source</th>
                  <th scope="col" className="tabular">Changes</th>
                  <th scope="col">Risk</th>
                  <th scope="col" className="tabular">Duration</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <PlanHistoryRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
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

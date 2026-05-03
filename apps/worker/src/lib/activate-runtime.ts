// AdDroid OSS — Activate runtime adapter.
//
// `/api/campaigns/[id]/activate` (Web) と `addroid activate` (CLI) の両方が
// 共通で呼ぶ shim。
//   - Prisma を裏に持つ ActivateStore を組み立てる
//   - resolveActivateExecutor で CLI / Mock を選ぶ
//   - runActivate (queue) を呼んで結果を返す
//
// 本ファイルは apps/worker (type: "module") 側に置く。apps/web は package.json
// に `"type": "module"` を持たないため、CLI (apps/cli, type: "module") からの
// ESM import が CJS interop 経由になり named export が見えなくなる。両 app から
// import する共有モジュールは ESM ハウス側 (worker) に集約する。

import { Prisma, type PrismaClient } from "@addroid/db";
import {
  runActivate,
  type ActivateApprovalInput,
  type ActivateAuditInput,
  type ActivateNodeSnapshot,
  type ActivateRequest,
  type ActivateStore,
  type ActivateSummary,
  type AdAccountLockProvider,
  type ExecutionLogInput,
} from "@addroid/queue";
import {
  resolveActivateExecutor,
  type ActivateExecutorSelection,
} from "./activate-meta-executor.js";
import { createPostgresAdAccountLockProvider } from "./account-lock.js";
import type { MetaAdapter } from "@addroid/meta-adapter";

/**
 * Prisma 経由で `ads_hierarchy` / `execution_logs` / `audit_logs` を更新する
 * `ActivateStore` を生成する。
 *
 * 注: 本 store は Web / CLI / worker のいずれから呼んでも同じ結果になる必要が
 *     あるため、`workspaceId` は ActivateNodeSnapshot から都度取得し、引数で
 *     固定しない (Apply 経路の ApplyJobStore と異なる)。
 */
export function createPrismaActivateStore(prisma: PrismaClient): ActivateStore {
  return {
    async findHierarchyNode(hierarchyId: string): Promise<ActivateNodeSnapshot | null> {
      const row = await prisma.adsHierarchyNode.findUnique({
        where: { id: hierarchyId },
        select: {
          id: true,
          nodeType: true,
          nodeKey: true,
          displayName: true,
          status: true,
          externalId: true,
          accountId: true,
          account: {
            select: {
              key: true,
              metaAccountId: true,
              workspaceId: true,
            },
          },
        },
      });
      if (!row || !row.account) return null;
      const nodeType =
        row.nodeType === "campaign" || row.nodeType === "adset" || row.nodeType === "ad"
          ? row.nodeType
          : null;
      if (!nodeType) return null;
      return {
        hierarchyId: row.id,
        workspaceId: row.account.workspaceId,
        accountId: row.accountId,
        accountKey: row.account.key,
        metaAccountId: row.account.metaAccountId,
        nodeType,
        nodeKey: row.nodeKey,
        displayName: row.displayName,
        status: row.status,
        externalId: row.externalId,
      };
    },

    async markHierarchyActive(hierarchyId: string): Promise<void> {
      await prisma.adsHierarchyNode.update({
        where: { id: hierarchyId },
        data: { status: "active" },
      });
    },

    async recordExecutionLog(input: ExecutionLogInput): Promise<void> {
      await prisma.executionLog.create({
        data: {
          cronRunId: input.cronRunId ?? null,
          workspaceId: input.workspaceId ?? null,
          kind: input.kind,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          level: input.level ?? "info",
          message: input.message,
          payload: (input.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    },

    async recordAudit(input: ActivateAuditInput): Promise<void> {
      const baseMetadata: Record<string, unknown> = {
        actor: input.actor,
        source: input.source,
        accountKey: input.accountKey,
        metaAccountId: input.metaAccountId,
        externalId: input.externalId,
      };
      const merged: Record<string, unknown> = { ...baseMetadata };
      if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
        for (const [k, v] of Object.entries(input.metadata)) merged[k] = v;
      } else if (input.metadata !== undefined) {
        merged.detail = input.metadata as unknown;
      }
      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: input.actor,
          action: input.action,
          target: `ads_hierarchy:${input.hierarchyId}`,
          ref: input.ref ?? `ads_hierarchy:${input.hierarchyId}`,
          metadata: merged as Prisma.InputJsonValue,
        },
      });
    },

    /**
     * implementation item: Activate (Web/Slack/CLI) の承認境界を `approval_records` に
     * 1 行残す。PR を持たないため `pullRequestId` は null とし、polymorphic
     * 列 (`targetType="ads_hierarchy"`, `targetId=<hierarchyId>`) で対象を
     * 識別する。`metadata.decisionSource` には `web_activate | slack_activate
     * | cli_activate` のいずれかを必ず含める (UI design plan §0.20)。
     */
    async recordApprovalRecord(input: ActivateApprovalInput): Promise<void> {
      const meta: Record<string, unknown> = {
        decisionSource: input.decisionSource,
      };
      if (
        input.metadata &&
        typeof input.metadata === "object" &&
        !Array.isArray(input.metadata)
      ) {
        for (const [k, v] of Object.entries(input.metadata)) {
          if (k !== "decisionSource") meta[k] = v;
        }
      } else if (input.metadata !== undefined) {
        meta.detail = input.metadata as unknown;
      }
      await prisma.approvalRecord.create({
        data: {
          workspaceId: input.workspaceId,
          pullRequestId: null,
          targetType: "ads_hierarchy",
          targetId: input.hierarchyId,
          approvedBy: input.approvedBy,
          decision: input.decision,
          comment: input.comment ?? null,
          metadata: meta as Prisma.InputJsonValue,
        },
      });
    },
  };
}

export interface ExecuteActivateOptions {
  prisma: PrismaClient;
  metaAdapter: MetaAdapter;
  request: ActivateRequest;
  env?: NodeJS.ProcessEnv;
  /**
   * regression fix: cross-process ad_account ロック provider。
   *
   * Web (`/api/campaigns/[id]/activate`) / CLI (`addroid activate`) / worker
   * (Apply 側) はすべて Postgres advisory lock を背に持つ同じ provider を
   * 共有することで、別プロセスから同じ ad_account に対する Meta CLI 並行
   * 実行を直列化する。
   *
   * 省略時は本関数内で Prisma backed の Postgres provider を新規生成する
   * (web/cli は短命プロセスのため、リクエスト毎に生成しても registry
   * 共有に支障はない — provider は cross-process の advisory lock で
   * 直列化するため、in-process registry を共有する必要はない)。
   */
  lockProvider?: AdAccountLockProvider;
}

/**
 * Web/CLI/worker の任意経路から共通で呼ばれる Activate エントリ。
 * - executor を env + Meta OAuth 状態から解決
 * - Prisma を裏に持つ store を組み立て
 * - runActivate を実行し、結果と executor mode を返す
 */
export async function executeActivate(
  opts: ExecuteActivateOptions
): Promise<{
  summary: ActivateSummary;
  executorSelection: ActivateExecutorSelection;
}> {
  const executorSelection = await resolveActivateExecutor({
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    metaAdapter: opts.metaAdapter,
  });
  const store = createPrismaActivateStore(opts.prisma);
  const lockProvider =
    opts.lockProvider ??
    createPostgresAdAccountLockProvider({ prisma: opts.prisma });
  const summary = await runActivate({
    request: opts.request,
    store,
    executor: executorSelection.executor,
    lockProvider,
  });
  return { summary, executorSelection };
}

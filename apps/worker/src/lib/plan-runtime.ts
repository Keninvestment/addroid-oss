// AdDroid OSS — dry-run / plan layer の共有境界.
//
// CLI (`addroid plan --dry-run`) / Web UI (`/api/plan`) / 将来の CI workflow が
// 同じ pure 関数を呼び、同じ persistence boundary 経由で `execution_logs` に
// 履歴を残せるようにする。
//
//   - runPlanForRoot(input) — ops repo を読み、buildExecutionPlan を回し、
//     UI/CLI が必要とする per-account サマリと findings を 1 つの構造体で返す。
//     I/O はファイルシステム + YAML パースのみ (Prisma / network 不使用)。
//   - createPrismaPlanStore(prisma) — Prisma を裏に持つ PlanRunStore を返す。
//     テストでは PlanRunStore を fake で差し替えられる。
//   - persistPlanRun(store, input) — runPlanForRoot の結果を 1 行の
//     ExecutionLog に書き込む。kind="plan", level は overall risk 由来。
//
// 注: Activate と異なり、plan は audit_logs に書かない (acceptance には
//     PR merge / Apply / Activate のみ列挙されている)。診断目的の history は
//     execution_logs で十分。

import { Prisma, type PrismaClient } from "@addroid/db";
import {
  buildExecutionPlan,
  loadAndValidateOpsRepo,
  loadPreviousOpsRepoState,
  type BrandYaml,
  type PlanAction,
  type PlanFinding,
  type PreviousOpsRepoState,
  type ValidationFinding,
} from "@addroid/yaml-schemas";

export type PlanRunSource = "web" | "web-chat" | "agent-task" | "ci" | "cli";

export interface PlanCounts {
  creates: number;
  updates: number;
  deletes: number;
  errors: number;
  warnings: number;
}

export type PlanRiskLevel = "ok" | "warn" | "error";

export interface PerAccountPlanSummary {
  account: string;
  actions: PlanAction[];
  findings: PlanFinding[];
  counts: PlanCounts;
  risk: PlanRiskLevel;
}

export interface PlanRunOutput {
  /** ok = validation も plan-level findings も error が無い (= apply 安全) */
  ok: boolean;
  durationMs: number;
  /** ops repo / file 単位の Zod / 整合性 error。account を持たない repo-wide エラー。 */
  validationErrors: ValidationFinding[];
  validationWarnings: ValidationFinding[];
  /** account 単位の plan サマリ。filter 指定があれば 1 件、無指定なら全 brand 件。 */
  perAccount: PerAccountPlanSummary[];
  /** 集計値 (UI 表示用に precomputed)。 */
  totalCounts: PlanCounts;
  /** overall risk: validation error or perAccount.risk=error が 1 つでもあれば "error"。 */
  risk: PlanRiskLevel;
}

export interface PlanRunInput {
  rootDir: string;
  /** base ブランチ checkout (任意)。assertBudgetChangeIsSafe / 既存 id 判定で使う。 */
  baseDir?: string | null;
  /** 指定すると、その accountKey の brand のみ plan 結果に含める。validation は全件回る。 */
  accountFilter?: string | null;
}

/**
 * Ops repo を読み、buildExecutionPlan を per-brand に回し、UI/CLI 用の
 * `PlanRunOutput` を返す。
 *
 * - validation 失敗時も throw しない。`ok=false`, `validationErrors` を埋めて返す。
 * - 1 つでも plan-level error finding があれば、その account の `risk="error"`
 *   かつ overall `ok=false`。
 * - account_filter が指定された場合、validation には全件参加させたうえで
 *   結果の `perAccount` を該当 1 件に絞る (= 他 account のエラーで全体が壊れる
 *   ことを避け、UI の「この account だけ確認したい」要求を満たす)。
 */
export function runPlanForRoot(input: PlanRunInput): PlanRunOutput {
  const startedAt = Date.now();
  const previous: PreviousOpsRepoState | undefined =
    input.baseDir ? loadPreviousOpsRepoState(input.baseDir) : undefined;
  const validation = loadAndValidateOpsRepo(input.rootDir, undefined, {
    ...(previous !== undefined ? { previous } : {}),
  });

  const perAccount: PerAccountPlanSummary[] = [];
  const accumulatedErrors: ValidationFinding[] = [...validation.errors];
  const accumulatedWarnings: ValidationFinding[] = [...validation.warnings];

  // validation error があっても、可能な範囲で per-account plan を埋める方針にする。
  // ただし brand-level エラーで brands が空のままなら、perAccount は空のまま。
  for (const b of validation.loaded.brands) {
    if (input.accountFilter && b.accountKey !== input.accountFilter) continue;
    const previousBrand: BrandYaml | null =
      previous?.brands.get(b.accountKey) ?? null;
    const planned = buildExecutionPlan({
      account: b.accountKey,
      next: b.brand,
      previous: previousBrand,
    });
    const counts = countActions(planned.actions, planned.findings);
    const accountErrors = planned.findings
      .filter((f) => f.level === "error")
      .map((f) => toValidationFinding(b.relPath, f));
    const accountWarnings = planned.findings
      .filter((f) => f.level === "warning")
      .map((f) => toValidationFinding(b.relPath, f));
    accumulatedErrors.push(...accountErrors);
    accumulatedWarnings.push(...accountWarnings);
    const risk: PlanRiskLevel =
      counts.errors > 0 ? "error" : counts.warnings > 0 ? "warn" : "ok";
    perAccount.push({
      account: b.accountKey,
      actions: planned.actions,
      findings: planned.findings,
      counts,
      risk,
    });
  }

  const totalCounts: PlanCounts = perAccount.reduce<PlanCounts>(
    (acc, p) => ({
      creates: acc.creates + p.counts.creates,
      updates: acc.updates + p.counts.updates,
      deletes: acc.deletes + p.counts.deletes,
      errors: acc.errors + p.counts.errors,
      warnings: acc.warnings + p.counts.warnings,
    }),
    { creates: 0, updates: 0, deletes: 0, errors: 0, warnings: 0 }
  );

  const ok =
    validation.errors.length === 0 &&
    perAccount.every((p) => p.counts.errors === 0);
  const risk: PlanRiskLevel = !ok
    ? "error"
    : accumulatedWarnings.length > 0 ||
        perAccount.some((p) => p.counts.warnings > 0)
      ? "warn"
      : "ok";

  return {
    ok,
    durationMs: Date.now() - startedAt,
    validationErrors: accumulatedErrors,
    validationWarnings: accumulatedWarnings,
    perAccount,
    totalCounts,
    risk,
  };
}

function countActions(
  actions: readonly PlanAction[],
  findings: readonly PlanFinding[]
): PlanCounts {
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  for (const a of actions) {
    if (a.kind.startsWith("create_")) creates += 1;
    else if (a.kind.startsWith("update_")) updates += 1;
    else if (a.kind.startsWith("delete_")) deletes += 1;
  }
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.level === "error") errors += 1;
    else if (f.level === "warning") warnings += 1;
  }
  return { creates, updates, deletes, errors, warnings };
}

function toValidationFinding(
  file: string,
  f: PlanFinding
): ValidationFinding {
  const out: ValidationFinding = { file, message: f.message };
  if (f.pointer) out.pointer = f.pointer;
  return out;
}

// ---------------------------------------------------------------------
// Persistence boundary
// ---------------------------------------------------------------------

/**
 * `execution_logs.payload` に書き込まれる plan 履歴 1 行分の JSON 構造。
 * /plans ページの DataTable / PlanPreview はこの形を想定して描画する。
 */
export interface PlanRunPayloadJson {
  source: PlanRunSource;
  triggeredBy: string;
  rootDir: string;
  baseDir: string | null;
  accountFilter: string | null;
  ok: boolean;
  risk: PlanRiskLevel;
  durationMs: number;
  totalCounts: PlanCounts;
  validationErrors: ValidationFinding[];
  validationWarnings: ValidationFinding[];
  perAccount: PerAccountPlanSummary[];
}

export interface RecordPlanExecutionLogInput {
  workspaceId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  payload: PlanRunPayloadJson;
}

export interface PlanRunStore {
  recordPlanExecutionLog(
    input: RecordPlanExecutionLogInput
  ): Promise<{ id: string }>;
}

export function createPrismaPlanStore(prisma: PrismaClient): PlanRunStore {
  return {
    async recordPlanExecutionLog(input) {
      const row = await prisma.executionLog.create({
        data: {
          workspaceId: input.workspaceId ?? null,
          kind: "plan",
          refType: null,
          refId: null,
          level: input.level,
          message: input.message,
          payload: (input.payload as unknown) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { id: row.id };
    },
  };
}

export interface PersistPlanRunInput {
  store: PlanRunStore;
  workspaceId: string | null;
  source: PlanRunSource;
  triggeredBy: string;
  rootDir: string;
  baseDir?: string | null;
  accountFilter?: string | null;
  result: PlanRunOutput;
}

/**
 * runPlanForRoot の結果を 1 行の ExecutionLog として保存する。
 * level は overall risk から決め、message は人間可読な短いサマリ。
 */
export async function persistPlanRun(
  input: PersistPlanRunInput
): Promise<{ id: string }> {
  const { result } = input;
  const level: "info" | "warn" | "error" =
    result.risk === "error" ? "error" : result.risk === "warn" ? "warn" : "info";
  const message = formatSummaryMessage(input.source, result, input.accountFilter ?? null);
  const payload: PlanRunPayloadJson = {
    source: input.source,
    triggeredBy: input.triggeredBy,
    rootDir: input.rootDir,
    baseDir: input.baseDir ?? null,
    accountFilter: input.accountFilter ?? null,
    ok: result.ok,
    risk: result.risk,
    durationMs: result.durationMs,
    totalCounts: result.totalCounts,
    validationErrors: result.validationErrors,
    validationWarnings: result.validationWarnings,
    perAccount: result.perAccount,
  };
  return input.store.recordPlanExecutionLog({
    workspaceId: input.workspaceId,
    level,
    message,
    payload,
  });
}

function formatSummaryMessage(
  source: PlanRunSource,
  result: PlanRunOutput,
  accountFilter: string | null
): string {
  const scope =
    accountFilter !== null
      ? `account=${accountFilter}`
      : `accounts=${result.perAccount.length}`;
  const counts = result.totalCounts;
  const summary = `+${counts.creates} ~${counts.updates} -${counts.deletes}`;
  if (!result.ok) {
    return `plan failed [source=${source}, ${scope}] ${summary} errors=${counts.errors + result.validationErrors.length}`;
  }
  if (result.risk === "warn") {
    return `plan ok with warnings [source=${source}, ${scope}] ${summary} warnings=${counts.warnings + result.validationWarnings.length}`;
  }
  return `plan ok [source=${source}, ${scope}] ${summary}`;
}

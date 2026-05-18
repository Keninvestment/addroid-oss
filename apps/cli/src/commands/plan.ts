// `addroid plan` — ops repo の YAML を読み、apply 時にどんな変更が起きるかを simulate する。
//
// CLI / CI / Web UI が共有する runner (`apps/worker/src/lib/plan-runtime.ts`) を呼ぶ。
//
// the current implementation 受入要件:
//   - dry-run / plan layer は CI・CLI・Web UI の三経路で同じ結果を返す。
//   - --persist 指定 (CI workflow の典型) で execution_logs.kind = "plan" に
//     履歴を残し、Web UI の /plans History に表示できるようにする。
//
// 使い方:
//   addroid plan --dry-run
//   addroid plan --dry-run --root ./ops --json
//   addroid plan --dry-run --persist --source ci    (CI ワークフロー想定)

import path from "node:path";
import {
  runPlanForRoot,
  persistPlanRun,
  createPrismaPlanStore,
  type PlanRunOutput,
  type PlanRunSource,
  type OperationPlanAction,
  type ValidationFinding,
} from "../../../worker/src/lib/plan-runtime.js";

interface PlanOptions {
  root: string;
  base: string | null;
  json: boolean;
  dryRun: boolean;
  persist: boolean;
  source: PlanRunSource;
  account: string | null;
}

export async function runPlan(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (opts === null) return 2;
  if (!opts.dryRun) {
    process.stderr.write(
      "[addroid plan] the current implementation skeleton では --dry-run のみサポート。--dry-run を付けて再実行してください。\n"
    );
    return 2;
  }

  const planResult = runPlanForRoot({
    rootDir: opts.root,
    baseDir: opts.base,
    accountFilter: opts.account,
  });

  const actions = collectActions(planResult);
  const errors = planResult.validationErrors;
  const warnings = planResult.validationWarnings;
  const ok = errors.length === 0;

  // --persist は副作用 (DB 書込) を伴うため exit code 計算とは独立に実行する。
  // 失敗しても plan 結果の表示・exit code には影響させない。
  let persistError: string | null = null;
  let executionLogId: string | null = null;
  if (opts.persist) {
    const result = await persistResult(opts, planResult);
    persistError = result.error;
    executionLogId = result.executionLogId;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root: opts.root,
          dryRun: true,
          ok,
          counts: {
            errors: errors.length,
            warnings: warnings.length,
            actions: actions.length,
          },
          errors,
          warnings,
          actions,
          ...(opts.persist
            ? {
                persisted: executionLogId !== null,
                executionLogId,
                ...(persistError !== null ? { persistError } : {}),
              }
            : {}),
        },
        null,
        2
      )}\n`
    );
  } else {
    printHuman(opts.root, errors, warnings, actions);
    if (opts.persist) {
      if (persistError !== null) {
        process.stdout.write(
          `\n  [persist] failed to record plan history: ${persistError}\n`
        );
      } else if (executionLogId !== null) {
        process.stdout.write(
          `\n  [persist] recorded execution_logs id=${executionLogId} (source=${opts.source})\n`
        );
      }
    }
  }
  return errors.length > 0 ? 1 : 0;
}

function collectActions(result: PlanRunOutput): OperationPlanAction[] {
  const out: OperationPlanAction[] = [];
  for (const acc of result.perAccount) out.push(...acc.actions);
  return out;
}

interface PersistOutcome {
  executionLogId: string | null;
  error: string | null;
}

async function persistResult(
  opts: PlanOptions,
  result: PlanRunOutput
): Promise<PersistOutcome> {
  if (!process.env.DATABASE_URL) {
    return {
      executionLogId: null,
      error:
        "DATABASE_URL が設定されていません。--persist を使うには .env.local を構成してください。",
    };
  }
  try {
    const { prisma } = await import("@addroid/db");
    try {
      const ws = await prisma.workspace.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      const store = createPrismaPlanStore(prisma);
      const recorded = await persistPlanRun({
        store,
        workspaceId: ws?.id ?? null,
        source: opts.source,
        triggeredBy: opts.source === "ci" ? "ci:plan" : "user:cli",
        rootDir: opts.root,
        baseDir: opts.base,
        accountFilter: opts.account,
        result,
      });
      return { executionLogId: recorded.id, error: null };
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  } catch (err) {
    return { executionLogId: null, error: (err as Error).message };
  }
}

function parseArgs(args: string[]): PlanOptions | null {
  let root = process.cwd();
  let base: string | null = null;
  let json = false;
  let dryRun = false;
  let persist = false;
  let source: PlanRunSource = "cli";
  let account: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--root" || a === "-r") {
      const next = args[i + 1];
      if (!next) {
        process.stderr.write("[addroid plan] --root に値がありません\n");
        return null;
      }
      root = path.resolve(next);
      i += 1;
    } else if (a.startsWith("--root=")) {
      root = path.resolve(a.slice("--root=".length));
    } else if (a === "--base") {
      const next = args[i + 1];
      if (!next) {
        process.stderr.write("[addroid plan] --base に値がありません\n");
        return null;
      }
      base = path.resolve(next);
      i += 1;
    } else if (a.startsWith("--base=")) {
      base = path.resolve(a.slice("--base=".length));
    } else if (a === "--json") {
      json = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--persist") {
      persist = true;
    } else if (a === "--source") {
      const next = args[i + 1];
      if (!next || !isPlanRunSource(next)) {
        process.stderr.write(
          "[addroid plan] --source は ci|cli|web のいずれかを指定してください\n"
        );
        return null;
      }
      source = next;
      i += 1;
    } else if (a.startsWith("--source=")) {
      const v = a.slice("--source=".length);
      if (!isPlanRunSource(v)) {
        process.stderr.write(
          "[addroid plan] --source は ci|cli|web のいずれかを指定してください\n"
        );
        return null;
      }
      source = v;
    } else if (a === "--account") {
      const next = args[i + 1];
      if (!next) {
        process.stderr.write("[addroid plan] --account に値がありません\n");
        return null;
      }
      account = next;
      i += 1;
    } else if (a.startsWith("--account=")) {
      account = a.slice("--account=".length);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      return null;
    } else {
      process.stderr.write(`[addroid plan] 未知のオプション: ${a}\n`);
      printHelp();
      return null;
    }
  }
  return { root, base, json, dryRun, persist, source, account };
}

function isPlanRunSource(v: string): v is PlanRunSource {
  return v === "ci" || v === "cli" || v === "web";
}

function printHelp() {
  process.stdout.write(
    [
      "addroid plan — ops repo の operations/*.json から apply 案を simulate (read-only)",
      "",
      "Usage:",
      "  addroid plan --dry-run [--root <dir>] [--base <dir>] [--account <key>]",
      "                          [--persist [--source ci|cli]] [--json]",
      "",
      "Options:",
      "  --dry-run         the current implementation でも plan は dry-run のみ。実 mutation は行わない",
      "  --root, -r <dir>  対象 ops repo ルート (default: cwd)",
      "  --base <dir>      互換オプション。operation manifest 経路では参照しません",
      "  --account <key>   指定 accountKey の operation のみを出力する",
      "  --persist         実行結果を execution_logs.kind=plan に記録する",
      "                    (DATABASE_URL 必須。Web UI の /plans 履歴に表示される)",
      "  --source <name>   --persist 時に source ラベルを指定 (default: cli)",
      "  --json            機械可読 JSON で結果を出力",
      "  --help, -h        このヘルプ",
      "",
    ].join("\n")
  );
}

function describeAction(a: OperationPlanAction): string {
  const prefix = a.verb === "create" ? "+" : a.verb === "delete" ? "-" : "~";
  return `${prefix} ${a.resource}:${a.verb} account=${a.account} args=${a.args.join(" ")}`;
}

function printHuman(
  root: string,
  errors: ValidationFinding[],
  warnings: ValidationFinding[],
  actions: OperationPlanAction[]
): void {
  const lines: string[] = [];
  lines.push("[addroid plan --dry-run]");
  lines.push("");
  lines.push(`  root        : ${root}`);
  lines.push(`  validation  : ${errors.length === 0 ? "[ ok  ]" : "[error]"}`);
  if (errors.length > 0) {
    for (const f of errors) {
      lines.push(
        `    [error] ${
          f.pointer ? `${f.file} :: ${f.pointer} — ${f.message}` : `${f.file} — ${f.message}`
        }`
      );
    }
    lines.push("");
    lines.push(
      "  validate に失敗したため plan を中断しました。`addroid validate` で詳細を確認してください。"
    );
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return;
  }
  if (warnings.length > 0) {
    lines.push(`  warnings    : ${warnings.length}`);
    for (const f of warnings) {
      lines.push(
        `    [warn ] ${
          f.pointer ? `${f.file} :: ${f.pointer} — ${f.message}` : `${f.file} — ${f.message}`
        }`
      );
    }
  }
  lines.push(`  actions     : ${actions.length}`);
  if (actions.length === 0) {
    lines.push("    (no apply actions — operations/*.json がありません)");
  } else {
    for (const a of actions) {
      lines.push(`    ${describeAction(a)}`);
    }
  }
  lines.push("");
  lines.push(
    "  plan は dry-run のみ。実 apply は worker が GitOps merged PR から起動します。"
  );
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

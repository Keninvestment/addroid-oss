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
} from "../../../worker/src/lib/plan-runtime.js";
import type { PlanAction, ValidationFinding } from "@addroid/yaml-schemas";

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

function collectActions(result: PlanRunOutput): PlanAction[] {
  const out: PlanAction[] = [];
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
      "addroid plan — ops repo の YAML から apply 案を simulate (read-only)",
      "",
      "Usage:",
      "  addroid plan --dry-run [--root <dir>] [--base <dir>] [--account <key>]",
      "                          [--persist [--source ci|cli]] [--json]",
      "",
      "Options:",
      "  --dry-run         the current implementation でも plan は dry-run のみ。実 mutation は行わない",
      "  --root, -r <dir>  対象 ops repo ルート (default: cwd)",
      "  --base <dir>      前回 / base 状態の ops repo ルート。既存キャンペーンとの",
      "                    差分から budget 変更や initialState の安全性を比較する",
      "  --account <key>   ads/accounts/<key> の plan のみを出力する (validation は全件)",
      "  --persist         実行結果を execution_logs.kind=plan に記録する",
      "                    (DATABASE_URL 必須。Web UI の /plans 履歴に表示される)",
      "  --source <name>   --persist 時に source ラベルを指定 (default: cli)",
      "  --json            機械可読 JSON で結果を出力",
      "  --help, -h        このヘルプ",
      "",
    ].join("\n")
  );
}

function describeAction(a: PlanAction): string {
  switch (a.kind) {
    case "create_campaign": {
      const parts: string[] = [];
      if (a.budget.dailyUsd !== undefined) parts.push(`dailyUsd=${a.budget.dailyUsd}`);
      if (a.budget.lifetimeUsd !== undefined) parts.push(`lifetimeUsd=${a.budget.lifetimeUsd}`);
      return `+ ${a.kind} account=${a.account} id=${a.campaignId} initialState=${a.initialState} ${parts.join(" ")}`.trimEnd();
    }
    case "update_campaign":
      return `~ ${a.kind} account=${a.account} id=${a.campaignId} fields=${Object.keys(a.changes).join(",") || "(none)"}`;
    case "delete_campaign":
      return `- ${a.kind} account=${a.account} id=${a.campaignId}`;
    case "create_adset":
      return `+ ${a.kind} account=${a.account} campaign=${a.campaignId} id=${a.adsetId} initialState=${a.initialState}`;
    case "update_adset":
      return `~ ${a.kind} account=${a.account} campaign=${a.campaignId} id=${a.adsetId} fields=${Object.keys(a.changes).join(",") || "(none)"}`;
    case "delete_adset":
      return `- ${a.kind} account=${a.account} campaign=${a.campaignId} id=${a.adsetId}`;
    case "create_ad":
      return `+ ${a.kind} account=${a.account} campaign=${a.campaignId} adset=${a.adsetId} id=${a.adId} creativeRef=${a.creativeRef}`;
    case "update_ad":
      return `~ ${a.kind} account=${a.account} campaign=${a.campaignId} adset=${a.adsetId} id=${a.adId} fields=${Object.keys(a.changes).join(",") || "(none)"}`;
    case "delete_ad":
      return `- ${a.kind} account=${a.account} campaign=${a.campaignId} adset=${a.adsetId} id=${a.adId}`;
    case "create_creative":
      return `+ ${a.kind} account=${a.account} id=${a.creativeId} mediaType=${a.mediaType}`;
    case "update_creative":
      return `~ ${a.kind} account=${a.account} id=${a.creativeId} fields=${Object.keys(a.changes).join(",") || "(none)"}`;
    case "delete_creative":
      return `- ${a.kind} account=${a.account} id=${a.creativeId}`;
    case "create_experiment":
      return `+ ${a.kind} account=${a.account} id=${a.experimentId} campaign=${a.campaignId} variants=${a.variants.length}`;
    case "update_experiment":
      return `~ ${a.kind} account=${a.account} id=${a.experimentId} fields=${Object.keys(a.changes).join(",") || "(none)"}`;
    case "delete_experiment":
      return `- ${a.kind} account=${a.account} id=${a.experimentId}`;
  }
}

function printHuman(
  root: string,
  errors: ValidationFinding[],
  warnings: ValidationFinding[],
  actions: PlanAction[]
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
    lines.push("    (no apply actions — campaigns 配列が空、または brand.yaml がありません)");
  } else {
    for (const a of actions) {
      lines.push(`    ${describeAction(a)}`);
    }
  }
  lines.push("");
  lines.push(
    "  the current implementation: PAUSED-by-default で plan は dry-run のみ。実 apply は worker が GitOps merged PR から起動します。"
  );
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

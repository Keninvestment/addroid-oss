// `addroid cron <subcommand>` — this implementation.
//
// pg-boss schedule (= 実行ドライバ) と Prisma `cron_schedules` (= UI ミラー)、
// `cron_runs` / `execution_logs` (= 実行履歴) を一カ所から操作する CLI。
//
// サブコマンド:
//   - list                              : プリセット一覧 + DB 状態 + pg-boss 登録状態
//   - enable   <name>                   : DB enabled=true + pg-boss schedule(name, cron) を登録
//   - disable  <name>                   : DB enabled=false + pg-boss unschedule(name)
//   - set      <name> <cron-expression> : DB cron 列を更新 (enabled なら pg-boss も再登録)
//   - run      <name>                   : pg-boss send(name) で 1 回だけ手動起動
//   - logs     <name> [--limit N]       : `cron_runs` を最新 N 件 + execution_logs サマリ
//
// Acceptance refs:
//   - "Cron CLI can list, enable, disable, set schedule, run, and show logs for the
//      three workflow presets."
//
// 実装ポリシー:
//   - サブコマンドの引数バリデーションは DB / pg-boss を起動する前に終わらせる。
//     これにより "--help / 未知サブ / 未知プリセット" のテストが DATABASE_URL や
//     PostgreSQL の存在に依存せず実行できる。
//   - DATABASE_URL 未設定なら exit 2。
//   - workspace は config.yaml の slug で upsert (worker と同じ ensureWorkspace 経由)。
//   - cron_schedules 行が無いケースを避けるため、最初に
//     `mirrorPresetsToCronSchedules` で全プリセットを idempotent に upsert する。
//     prisma-stores の upsertCronSchedule は "create-or-keep" 化済みのため、
//     既存の user-modified 状態 (CLI で enable された行) は再起動で巻き戻らない。
//   - pg-boss は `bootPgBoss` で start() し、操作後に `boss.stop` で graceful 停止。
//   - 実行ハンドラは worker プロセス側に attach されているため、`run` は単に
//     `boss.send(name)` でジョブを積むだけで完結する (worker 未起動時は queue
//     に積まれ、worker 起動後にハンドラへ流れる)。

import {
  bootPgBoss,
  CRON_PRESETS,
  mirrorPresetsToCronSchedules,
  validateCronExpression,
  type CronPresetName,
} from "@addroid/queue";

// this implementation: validateCronExpression は @addroid/queue に移し、
// Web UI (`POST /api/cron/[name]/schedule`) と CLI が同じ厳格検証を
// 共有する。既存テスト (apps/cli/src/__tests__/cron.test.ts) が CLI モジュール
// から `validateCronExpression` を import しているため、re-export で互換を保つ。
export { validateCronExpression } from "@addroid/queue";
import {
  defaultAddroidConfig,
  ensureAddroidPaths,
  readAddroidConfig,
} from "@addroid/config";
import type PgBoss from "pg-boss";
import type { PrismaClient } from "@addroid/db";

const PRESET_NAMES = CRON_PRESETS.map((p) => p.name) as CronPresetName[];

type ParsedAction =
  | { kind: "help" }
  | { kind: "list"; asJson: boolean }
  | { kind: "enable"; name: CronPresetName }
  | { kind: "disable"; name: CronPresetName }
  | { kind: "set"; name: CronPresetName; cron: string }
  | { kind: "run"; name: CronPresetName }
  | { kind: "logs"; name: CronPresetName; limit: number; asJson: boolean };

interface ParseError {
  kind: "error";
  code: number;
  stderr?: string;
  stdoutHelp?: boolean;
}

export async function runCronCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.kind === "error") {
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    if (parsed.stdoutHelp) printHelp();
    return parsed.code;
  }
  if (parsed.kind === "help") {
    printHelp();
    return 0;
  }

  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid cron] DATABASE_URL が設定されていません。`.env.local` を作成し再実行してください。\n"
    );
    return 2;
  }

  const ctx = await prepareContext().catch((err) => {
    process.stderr.write(
      `[addroid cron] 起動に失敗しました: ${(err as Error).message}\n`
    );
    return null;
  });
  if (!ctx) return 1;
  try {
    switch (parsed.kind) {
      case "list":
        return await execList(ctx, parsed);
      case "enable":
        return await execEnable(ctx, parsed);
      case "disable":
        return await execDisable(ctx, parsed);
      case "set":
        return await execSet(ctx, parsed);
      case "run":
        return await execRun(ctx, parsed);
      case "logs":
        return await execLogs(ctx, parsed);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------
// argument parsing (no DB / pg-boss involvement)
// ---------------------------------------------------------------------
function parseArgs(args: string[]): ParsedAction | ParseError {
  if (args.length === 0) {
    return { kind: "error", code: 2, stdoutHelp: true };
  }
  const head = args[0]!;
  if (head === "--help" || head === "-h" || head === "help") {
    return { kind: "help" };
  }
  const rest = args.slice(1);
  switch (head) {
    case "list":
      return parseList(rest);
    case "enable":
      return parseSimpleNamed(rest, "enable");
    case "disable":
      return parseSimpleNamed(rest, "disable");
    case "set":
      return parseSet(rest);
    case "run":
      return parseSimpleNamed(rest, "run");
    case "logs":
      return parseLogs(rest);
    default:
      return {
        kind: "error",
        code: 2,
        stderr: `[addroid cron] 未知のサブコマンド: ${head}\n`,
        stdoutHelp: true,
      };
  }
}

function parseList(rest: string[]): ParsedAction | ParseError {
  let asJson = false;
  for (const a of rest) {
    if (a === "--json") asJson = true;
    else
      return {
        kind: "error",
        code: 2,
        stderr: `[addroid cron list] 未知のオプション: ${a}\n`,
      };
  }
  return { kind: "list", asJson };
}

function parseSimpleNamed(
  rest: string[],
  kind: "enable" | "disable" | "run"
): ParsedAction | ParseError {
  const named = takeNameArg(rest, kind);
  if ("kind" in named) return named;
  if (named.rest.length > 0) {
    return {
      kind: "error",
      code: 2,
      stderr: `[addroid cron ${kind}] 余分な引数: ${named.rest.join(" ")}\n`,
    };
  }
  return { kind, name: named.name } as ParsedAction;
}

function parseSet(rest: string[]): ParsedAction | ParseError {
  const named = takeNameArg(rest, "set");
  if ("kind" in named) return named;
  if (named.rest.length === 0) {
    return {
      kind: "error",
      code: 2,
      stderr:
        "[addroid cron set] <cron-expression> が必要です (例: \"*/15 * * * *\")\n",
    };
  }
  // cron 式は空白を含むため、複数 token を空白で結合し直す。
  const cron = named.rest.join(" ").trim();
  if (!cron) {
    return {
      kind: "error",
      code: 2,
      stderr: "[addroid cron set] cron 式が空です\n",
    };
  }
  // DB / pg-boss を起動する前に cron 式を full validate する。
  // disabled なプリセットでも cron_schedules.cron に malformed な値が永続化
  // されないことを保証するため、ここで失敗したら parseArgs 段階で 2 を返す。
  const validation = validateCronExpression(cron);
  if (!validation.ok) {
    return {
      kind: "error",
      code: 2,
      stderr: `[addroid cron set] cron 式が不正です: ${validation.reason} (${cron})\n`,
    };
  }
  return { kind: "set", name: named.name, cron };
}

function parseLogs(rest: string[]): ParsedAction | ParseError {
  const named = takeNameArg(rest, "logs");
  if ("kind" in named) return named;
  let limit = 20;
  let asJson = false;
  for (let i = 0; i < named.rest.length; i += 1) {
    const a = named.rest[i]!;
    if (a === "--json") {
      asJson = true;
    } else if (a === "--limit" || a === "-n") {
      const v = named.rest[i + 1];
      i += 1;
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          kind: "error",
          code: 2,
          stderr: `[addroid cron logs] --limit は正の整数: ${v}\n`,
        };
      }
      limit = Math.min(n, 200);
    } else {
      return {
        kind: "error",
        code: 2,
        stderr: `[addroid cron logs] 未知のオプション: ${a}\n`,
      };
    }
  }
  return { kind: "logs", name: named.name, limit, asJson };
}

interface NameArgs {
  name: CronPresetName;
  rest: string[];
}

function takeNameArg(
  rest: string[],
  cmd: string
): NameArgs | ParseError {
  if (rest.length === 0) {
    return {
      kind: "error",
      code: 2,
      stderr: `[addroid cron ${cmd}] <name> が必要です。--help を参照してください。\n`,
    };
  }
  const head = rest[0]!;
  if (!isPresetName(head)) {
    return {
      kind: "error",
      code: 2,
      stderr:
        `[addroid cron ${cmd}] 未知のプリセット名: ${head}\n` +
        `  有効な名前: ${PRESET_NAMES.join(", ")}\n`,
    };
  }
  return { name: head, rest: rest.slice(1) };
}

function isPresetName(s: string): s is CronPresetName {
  return (PRESET_NAMES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------
// subcommand: list
// ---------------------------------------------------------------------
async function execList(
  ctx: CronCliContext,
  opts: Extract<ParsedAction, { kind: "list" }>
): Promise<number> {
  const rows = await ctx.prisma.cronSchedule.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: {
      name: true,
      cron: true,
      enabled: true,
      lastRunState: true,
      nextRunAt: true,
      updatedAt: true,
    },
  });
  const dbByName = new Map(rows.map((r) => [r.name, r]));

  let bossSchedules: Awaited<ReturnType<PgBoss["getSchedules"]>> = [];
  try {
    bossSchedules = await ctx.boss.getSchedules();
  } catch (err) {
    process.stderr.write(
      `[addroid cron list] pg-boss schedule 取得に失敗: ${(err as Error).message}\n`
    );
  }
  const bossByName = new Map(bossSchedules.map((s) => [s.name, s]));

  type Item = {
    name: string;
    description: string;
    cron: string;
    enabledByDefault: boolean;
    dbEnabled: boolean | null;
    pgBossScheduled: boolean;
    pgBossCron: string | null;
    lastRunState: string | null;
    nextRunAt: string | null;
  };
  const items: Item[] = CRON_PRESETS.map((p) => {
    const db = dbByName.get(p.name);
    const boss = bossByName.get(p.name);
    return {
      name: p.name,
      description: p.description,
      cron: db?.cron ?? p.cron,
      enabledByDefault: p.enabledByDefault,
      dbEnabled: db ? db.enabled : null,
      pgBossScheduled: Boolean(boss),
      pgBossCron: boss?.cron ?? null,
      lastRunState: db?.lastRunState ?? null,
      nextRunAt: db?.nextRunAt ? db.nextRunAt.toISOString() : null,
    };
  });

  if (opts.asJson) {
    process.stdout.write(JSON.stringify({ items }, null, 2) + "\n");
    return 0;
  }

  const lines: string[] = [];
  lines.push("[addroid cron list]");
  lines.push("");
  lines.push(
    `  ${pad("name", 18)}${pad("cron", 16)}${pad("db", 9)}${pad("pgBoss", 9)}${pad("last", 8)}description`
  );
  lines.push(`  ${"-".repeat(76)}`);
  for (const it of items) {
    const dbState =
      it.dbEnabled === null ? "(none)" : it.dbEnabled ? "enabled" : "disabled";
    const bossState = it.pgBossScheduled ? "yes" : "no";
    const last = it.lastRunState ?? "-";
    lines.push(
      `  ${pad(it.name, 18)}${pad(it.cron, 16)}${pad(dbState, 9)}${pad(bossState, 9)}${pad(last, 8)}${it.description}`
    );
  }
  lines.push("");
  lines.push("  Notes:");
  lines.push("    - db      : cron_schedules 行の enabled 列 (UI ミラー)");
  lines.push("    - pgBoss  : pg-boss schedule に登録済みかどうか (実行ドライバ)");
  lines.push("    - last    : 直近 cron 実行のサマリ状態 (ok / error / -)");
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------
// subcommand: enable
// ---------------------------------------------------------------------
async function execEnable(
  ctx: CronCliContext,
  opts: Extract<ParsedAction, { kind: "enable" }>
): Promise<number> {
  const row = await ctx.prisma.cronSchedule.findUnique({
    where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: opts.name } },
    select: { cron: true },
  });
  const preset = CRON_PRESETS.find((p) => p.name === opts.name)!;
  const cron = row?.cron ?? preset.cron;

  try {
    await ctx.boss.schedule(opts.name, cron);
  } catch (err) {
    process.stderr.write(
      `[addroid cron enable] pg-boss schedule に失敗: ${(err as Error).message}\n`
    );
    return 1;
  }

  await ctx.prisma.cronSchedule.update({
    where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: opts.name } },
    data: { enabled: true, cron },
  });

  process.stdout.write(
    [
      "[addroid cron enable]",
      `  preset : ${opts.name}`,
      `  cron   : ${cron}`,
      `  status : enabled (pg-boss + cron_schedules)`,
      "",
    ].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------
// subcommand: disable
// ---------------------------------------------------------------------
async function execDisable(
  ctx: CronCliContext,
  opts: Extract<ParsedAction, { kind: "disable" }>
): Promise<number> {
  try {
    await ctx.boss.unschedule(opts.name);
  } catch (err) {
    process.stderr.write(
      `[addroid cron disable] pg-boss unschedule に失敗: ${(err as Error).message}\n`
    );
    return 1;
  }

  await ctx.prisma.cronSchedule.update({
    where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: opts.name } },
    data: { enabled: false },
  });

  process.stdout.write(
    [
      "[addroid cron disable]",
      `  preset : ${opts.name}`,
      `  status : disabled (pg-boss schedule 解除 + cron_schedules.enabled=false)`,
      "",
    ].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------
// subcommand: set
// ---------------------------------------------------------------------
async function execSet(
  ctx: CronCliContext,
  opts: Extract<ParsedAction, { kind: "set" }>
): Promise<number> {
  const existing = await ctx.prisma.cronSchedule.findUnique({
    where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: opts.name } },
    select: { enabled: true },
  });
  const enabled = existing?.enabled ?? false;

  // cron 式は parseSet で validateCronExpression を通過済み (DB / pg-boss を
  // 起動する前にチェック)。enabled なときだけ pg-boss にも実際に反映する。
  if (enabled) {
    try {
      await ctx.boss.schedule(opts.name, opts.cron);
    } catch (err) {
      process.stderr.write(
        `[addroid cron set] pg-boss schedule (validate) に失敗: ${(err as Error).message}\n`
      );
      return 1;
    }
  }

  await ctx.prisma.cronSchedule.update({
    where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: opts.name } },
    data: { cron: opts.cron },
  });

  process.stdout.write(
    [
      "[addroid cron set]",
      `  preset : ${opts.name}`,
      `  cron   : ${opts.cron}`,
      `  status : ${enabled ? "rescheduled (pg-boss + cron_schedules)" : "saved (cron_schedules; pg-boss は disabled のため未登録)"}`,
      "",
    ].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------
// subcommand: run
// ---------------------------------------------------------------------
async function execRun(
  ctx: CronCliContext,
  opts: Extract<ParsedAction, { kind: "run" }>
): Promise<number> {
  let jobId: string | null = null;
  try {
    jobId = await ctx.boss.send(opts.name, {});
  } catch (err) {
    process.stderr.write(
      `[addroid cron run] pg-boss send に失敗: ${(err as Error).message}\n`
    );
    return 1;
  }

  process.stdout.write(
    [
      "[addroid cron run]",
      `  preset : ${opts.name}`,
      `  jobId  : ${jobId ?? "(none — 重複抑止または pg-boss 未起動)"}`,
      "  note   : 実行は worker プロセス (addroid up 配下) で処理されます。",
      "",
    ].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------
// subcommand: logs
// ---------------------------------------------------------------------
async function execLogs(
  ctx: CronCliContext,
  opts: Extract<ParsedAction, { kind: "logs" }>
): Promise<number> {
  const runs = await ctx.prisma.cronRun.findMany({
    where: { name: opts.name },
    orderBy: { startedAt: "desc" },
    take: opts.limit,
    select: {
      id: true,
      jobId: true,
      state: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      errorMessage: true,
      output: true,
    },
  });

  const runIds = runs.map((r) => r.id);
  const stepRows =
    runIds.length > 0
      ? await ctx.prisma.executionLog.findMany({
          where: { cronRunId: { in: runIds } },
          orderBy: { createdAt: "asc" },
          select: {
            cronRunId: true,
            kind: true,
            level: true,
            message: true,
            createdAt: true,
          },
        })
      : [];
  const stepsByRun = new Map<string, typeof stepRows>();
  for (const s of stepRows) {
    if (!s.cronRunId) continue;
    const arr = stepsByRun.get(s.cronRunId) ?? [];
    arr.push(s);
    stepsByRun.set(s.cronRunId, arr);
  }

  if (opts.asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          name: opts.name,
          runs: runs.map((r) => ({
            id: r.id,
            jobId: r.jobId,
            state: r.state,
            startedAt: r.startedAt.toISOString(),
            finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
            durationMs: r.durationMs,
            errorMessage: r.errorMessage,
            output: r.output ?? null,
            steps: (stepsByRun.get(r.id) ?? []).map((s) => ({
              kind: s.kind,
              level: s.level,
              message: s.message,
              createdAt: s.createdAt.toISOString(),
            })),
          })),
        },
        null,
        2
      ) + "\n"
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(`[addroid cron logs] ${opts.name} (latest ${runs.length})`);
  lines.push("");
  if (runs.length === 0) {
    lines.push("  実行履歴はまだありません。");
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return 0;
  }
  for (const r of runs) {
    const dur = r.durationMs !== null ? `${r.durationMs}ms` : "-";
    lines.push(
      `  ${r.startedAt.toISOString()}  ${pad(r.state, 9)}${pad(dur, 9)}job=${r.jobId ?? "-"}`
    );
    if (r.errorMessage) {
      lines.push(`    error: ${r.errorMessage}`);
    }
    const steps = stepsByRun.get(r.id) ?? [];
    for (const s of steps) {
      lines.push(`    [${s.level}] ${s.message}`);
    }
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------
// CLI context boot/teardown
// ---------------------------------------------------------------------
interface CronCliContext {
  prisma: PrismaClient;
  boss: PgBoss;
  workspaceId: string;
  close: () => Promise<void>;
}

async function prepareContext(): Promise<CronCliContext> {
  // 遅延 import: ヘルプ表示パスや DATABASE_URL 未設定パスでは Prisma / pg-boss を
  // 引き込まないようにする。
  const { prisma } = await import("@addroid/db");
  const { ensureWorkspace, createCronOpsStore } = await import(
    "../../../worker/src/lib/prisma-stores.js"
  );

  const paths = await ensureAddroidPaths();
  const config =
    (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  const workspace = await ensureWorkspace(prisma, {
    slug: config.workspace.slug,
    displayName: config.workspace.displayName,
    configPath: paths.configFile,
    storageDir: paths.storageDir,
    databaseUrlRef: config.database.urlRef,
  });

  const boss = await bootPgBoss({ databaseUrl: process.env.DATABASE_URL! });
  // cron_schedules 行が無い状態でも CLI が動作するように、初回だけ idempotent に
  // 全プリセットを upsert する。prisma-stores の upsertCronSchedule は
  // create-or-keep 化されているため、既存の user-modified 状態は壊さない。
  const store = createCronOpsStore(prisma, workspace.id);
  await mirrorPresetsToCronSchedules({ store, workspaceId: workspace.id });

  return {
    prisma,
    boss,
    workspaceId: workspace.id,
    close: async () => {
      try {
        await boss.stop({ graceful: true, wait: false });
      } catch {
        /* ignore */
      }
      try {
        await prisma.$disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------
// help / formatting
// ---------------------------------------------------------------------
function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, w - 1)} `;
  return s + " ".repeat(w - s.length);
}

function printHelp(): void {
  process.stdout.write(
    [
      "addroid cron — pg-boss schedule + cron_schedules ミラー操作",
      "",
      "Usage:",
      "  addroid cron list [--json]",
      "  addroid cron enable  <name>",
      "  addroid cron disable <name>",
      "  addroid cron set     <name> <cron-expression>",
      "  addroid cron run     <name>",
      "  addroid cron logs    <name> [--limit N] [--json]",
      "",
      "Presets:",
      ...CRON_PRESETS.map(
        (p) =>
          `  - ${pad(p.name, 18)}default=${pad(p.cron, 16)}${p.enabledByDefault ? "(enabled by default)" : "(disabled by default)"}`
      ),
      "",
      "Notes:",
      "  - DATABASE_URL が必要 (`.env.local` 推奨)。",
      "  - run は pg-boss にジョブを積むだけで、実行自体は worker プロセス (`addroid up`) で行われる。",
      "  - enable/disable/set は cron_schedules (UI ミラー) と pg-boss schedule の両方を更新する。",
      "",
    ].join("\n")
  );
}

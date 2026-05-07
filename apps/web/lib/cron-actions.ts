// AdDroid OSS — Web 側 Cron 操作ヘルパ (this implementation).
//
// `/api/cron/[name]/toggle | schedule | run` の 3 ハンドラから共有される server-side
// 実装層。CLI (`addroid schedule enable | disable | set | run`) と同じ動作を Web 経路で
// 提供する。
//
// 受入基準 (this implementation / acceptance):
//   - Web UI から Cron ON/OFF、schedule 変更、即時実行ができる。
//   - すべての書き込みは `audit_logs` に記録され (`web:` 接頭辞)、後日
//     `/cron/audit` で追跡できる (Approval attribution / acceptance #20)。
//   - 失敗 (DATABASE_URL 不在 / pg-boss 接続失敗 / cron 式不正 / unschedule 失敗等)
//     は Slack のような任意統合と同様にハンドラ単位で吸収し、core GitOps polling /
//     Apply / Cron 実行をブロックしない (acceptance #15)。
//
// 設計上の注意:
//   - workspace は config.yaml 由来の slug で `ensureWebWorkspace` 経由で upsert する。
//     プロセス再起動と同じ idempotent 経路で、Web 単独でも動作する。
//   - `cron_schedules` 行が無いケースに備えて `mirrorPresetsToCronSchedules` を
//     1 回流す。CLI と同じく "create-or-keep" なので既存値は壊さない。
//   - actor は常にサーバー側で `user:web-ui` に固定する。CLI を装った監査記録の偽装を
//     防ぐ (Regression fix と同方針)。

import type PgBoss from "pg-boss";
import {
  CRON_PRESETS,
  mirrorPresetsToCronSchedules,
  validateCronExpression,
  type CronPresetName,
} from "@addroid/queue";
import { Prisma } from "@addroid/db";
import { prisma } from "./prisma";
import { ensureWebWorkspace } from "./github-runtime";
import { getQueueBoss } from "./queue-runtime";
import { createCronOpsStore } from "../../worker/src/lib/prisma-stores";

export const WEB_CRON_ACTOR = "user:web-ui" as const;

const PRESET_NAMES: readonly string[] = CRON_PRESETS.map((p) => p.name);

export function isCronPresetName(name: string): name is CronPresetName {
  return PRESET_NAMES.includes(name);
}

interface PreparedContext {
  boss: PgBoss;
  workspaceId: string;
}

/**
 * Workspace を upsert して cron_schedules ミラーを揃え、pg-boss を起動して返す。
 * 失敗時はそのまま throw する (呼び出し側で 5xx + Toast エラー)。
 */
async function prepareContext(): Promise<PreparedContext> {
  const workspace = await ensureWebWorkspace();
  const store = createCronOpsStore(prisma, workspace.id);
  await mirrorPresetsToCronSchedules({ store, workspaceId: workspace.id });
  const boss = await getQueueBoss();
  return { boss, workspaceId: workspace.id };
}

async function recordAudit(
  workspaceId: string,
  action: string,
  preset: CronPresetName,
  metadata: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        workspaceId,
        actor: WEB_CRON_ACTOR,
        action,
        target: `cron_schedule:${preset}`,
        ref: preset,
        metadata: metadata as Prisma.InputJsonValue,
      },
    })
    .catch(() => {
      /* audit 失敗は Toast に倒さず本処理は完遂させる */
    });
}

// =====================================================================
// toggle (enable / disable)
// =====================================================================

export type ToggleResult =
  | {
      ok: true;
      enabled: boolean;
      cron: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function toggleCron(
  presetName: CronPresetName,
  desiredEnabled: boolean
): Promise<ToggleResult> {
  let ctx: PreparedContext;
  try {
    ctx = await prepareContext();
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: `pg-boss / DB に接続できません: ${(err as Error).message}`,
    };
  }

  const { boss, workspaceId } = ctx;
  const preset = CRON_PRESETS.find((p) => p.name === presetName)!;
  const row = await prisma.cronSchedule.findUnique({
    where: { workspaceId_name: { workspaceId, name: presetName } },
    select: { cron: true, enabled: true },
  });
  const cron = row?.cron ?? preset.cron;

  if (desiredEnabled) {
    try {
      await boss.schedule(presetName, cron);
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: `pg-boss schedule に失敗しました: ${(err as Error).message}`,
      };
    }
    await prisma.cronSchedule.update({
      where: { workspaceId_name: { workspaceId, name: presetName } },
      data: { enabled: true, cron },
    });
    await recordAudit(workspaceId, "cron.enabled_via_web", presetName, {
      preset: presetName,
      cron,
      previousEnabled: row?.enabled ?? false,
    });
    return { ok: true, enabled: true, cron };
  }

  try {
    await boss.unschedule(presetName);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `pg-boss unschedule に失敗しました: ${(err as Error).message}`,
    };
  }
  await prisma.cronSchedule.update({
    where: { workspaceId_name: { workspaceId, name: presetName } },
    data: { enabled: false },
  });
  await recordAudit(workspaceId, "cron.disabled_via_web", presetName, {
    preset: presetName,
    cron,
    previousEnabled: row?.enabled ?? false,
  });
  return { ok: true, enabled: false, cron };
}

// =====================================================================
// schedule (set cron expression)
// =====================================================================

export type SetScheduleResult =
  | {
      ok: true;
      cron: string;
      enabled: boolean;
      reschedulePending: boolean;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function setCronSchedule(
  presetName: CronPresetName,
  rawCron: string
): Promise<SetScheduleResult> {
  const trimmed = typeof rawCron === "string" ? rawCron.trim() : "";
  const validation = validateCronExpression(trimmed);
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      error: `cron 式が不正です: ${validation.reason}`,
    };
  }

  let ctx: PreparedContext;
  try {
    ctx = await prepareContext();
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: `pg-boss / DB に接続できません: ${(err as Error).message}`,
    };
  }
  const { boss, workspaceId } = ctx;

  const existing = await prisma.cronSchedule.findUnique({
    where: { workspaceId_name: { workspaceId, name: presetName } },
    select: { cron: true, enabled: true },
  });
  const enabled = existing?.enabled ?? false;
  const previousCron = existing?.cron ?? null;

  if (enabled) {
    try {
      await boss.schedule(presetName, trimmed);
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: `pg-boss schedule (validate) に失敗しました: ${(err as Error).message}`,
      };
    }
  }

  await prisma.cronSchedule.update({
    where: { workspaceId_name: { workspaceId, name: presetName } },
    data: { cron: trimmed },
  });
  await recordAudit(workspaceId, "cron.schedule_changed_via_web", presetName, {
    preset: presetName,
    cron: trimmed,
    previousCron,
    enabled,
  });

  return {
    ok: true,
    cron: trimmed,
    enabled,
    // disabled の場合 pg-boss は触らないため、enable 時に新 cron が反映される旨を
    // UI 側の Toast に出せるようにフラグで返す。
    reschedulePending: !enabled,
  };
}

// =====================================================================
// run (manual one-off run)
// =====================================================================

export type RunNowResult =
  | {
      ok: true;
      jobId: string | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function runCronNow(
  presetName: CronPresetName
): Promise<RunNowResult> {
  let ctx: PreparedContext;
  try {
    ctx = await prepareContext();
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: `pg-boss / DB に接続できません: ${(err as Error).message}`,
    };
  }
  const { boss, workspaceId } = ctx;

  let jobId: string | null = null;
  try {
    jobId = await boss.send(presetName, {
      manual: true,
      requestedBy: WEB_CRON_ACTOR,
      requestedAt: new Date().toISOString(),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `pg-boss send に失敗しました: ${(err as Error).message}`,
    };
  }

  await recordAudit(workspaceId, "cron.manual_run_via_web", presetName, {
    preset: presetName,
    jobId,
  });

  return { ok: true, jobId };
}

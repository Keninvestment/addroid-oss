// AdDroid OSS — cron_run lifecycle helpers.
//
// pg-boss handler の中で「開始 → 成功 / 失敗」の cron_runs 行を一貫して書くための
// 薄いラッパ。cron_schedules.lastRunState は finish/fail のタイミングで roll up する。

import type { CronOpsStore, JsonValue } from "./store.js";

export interface CronRunHandle {
  cronRunId: string;
  scheduleName: string;
  startedAtMs: number;
}

export async function startCronRun(
  store: CronOpsStore,
  input: { scheduleId: string | null; name: string; jobId: string }
): Promise<CronRunHandle> {
  const { id } = await store.startCronRun(input);
  return {
    cronRunId: id,
    scheduleName: input.name,
    startedAtMs: Date.now(),
  };
}

export async function finishCronRun(
  store: CronOpsStore,
  handle: CronRunHandle,
  output?: JsonValue
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - handle.startedAtMs);
  await store.finishCronRun({
    cronRunId: handle.cronRunId,
    scheduleName: handle.scheduleName,
    durationMs,
    output,
  });
}

export async function failCronRun(
  store: CronOpsStore,
  handle: CronRunHandle,
  error: unknown
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - handle.startedAtMs);
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  await store.failCronRun({
    cronRunId: handle.cronRunId,
    scheduleName: handle.scheduleName,
    durationMs,
    error: message,
  });
}

// AdDroid OSS — preset → cron_schedules ミラー。
//
// pg-boss は実際の schedule を `pgboss` スキーマに持つが、UI は AdDroid 側の
// `cron_schedules` テーブルを参照する (the current implementation の表示用ミラー)。本関数は
// worker 起動時に CRON_PRESETS をこのテーブルへ upsert する。
//
// `enableNonEssential` を true にすると daily_report 等も enabled=true で記録するが、
// the current implementation の既定では enabled=false のままにしておき UI 側に「未起動」と表示する。

import { CRON_PRESETS } from "./presets.js";
import type { CronOpsStore } from "./store.js";

export interface MirrorPresetsOptions {
  store: CronOpsStore;
  workspaceId: string;
  enableNonEssential?: boolean;
}

export interface MirrorPresetsResult {
  scheduleIdByName: Record<string, string>;
}

export async function mirrorPresetsToCronSchedules(
  opts: MirrorPresetsOptions
): Promise<MirrorPresetsResult> {
  const scheduleIdByName: Record<string, string> = {};
  for (const preset of CRON_PRESETS) {
    const enabled = preset.enabledByDefault || Boolean(opts.enableNonEssential);
    const { id } = await opts.store.upsertCronSchedule({
      workspaceId: opts.workspaceId,
      name: preset.name,
      cron: preset.cron,
      enabled,
    });
    scheduleIdByName[preset.name] = id;
  }
  return { scheduleIdByName };
}

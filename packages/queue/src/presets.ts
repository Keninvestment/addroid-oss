// AdDroid OSS — cron preset definitions.
//
// boot/registration ロジックから分離して保持することで、UI とテストが pg-boss を
// 起動せずにこの定義だけを参照できるようにする。
//
// the current implementation の重要な制約 (再掲):
//   - github_poll は default で enabled。merged PR 検知は本契約で動作する想定。
//   - daily_report / budget_guard / improvement_pr は「定義のみ存在し未起動」を維持する。

export const APPLY_JOB_NAME = "execute_apply" as const;

export const CRON_PRESETS = [
  {
    name: "github_poll",
    cron: "*/2 * * * *",
    description: "ops repository の Pull Request を ETag-aware にポーリングする",
    enabledByDefault: true,
  },
  {
    name: "daily_report",
    cron: "0 9 * * *",
    description: "Meta Ads CLI 経由で日次レポートを取得する (後続コントラクト)",
    enabledByDefault: false,
  },
  {
    name: "budget_guard",
    cron: "*/15 * * * *",
    description: "予算超過監視 (後続コントラクト)",
    enabledByDefault: false,
  },
  {
    name: "improvement_pr",
    cron: "0 10 * * 1",
    description: "AI 改善提案 PR を週次で作成 (後続コントラクト)",
    enabledByDefault: false,
  },
  {
    // Regression fix: performance_snapshots の保持期間
    // (raw=90d / aggregate=1y) を毎日 1 回掃く housekeeping 用 preset。
    // AI ワークフローではないため、運用の安全側として既定で有効化する。
    name: "retention_sweep",
    cron: "15 3 * * *",
    description:
      "performance_snapshots の raw / 粒度 (adset/ad) を 90 日、集計 (account/campaign) を 1 年で掃くリテンション処理",
    enabledByDefault: true,
  },
  {
    name: "agent_tasks",
    cron: "* * * * *",
    description: "自然言語で保存された Agent task の due run を評価する",
    enabledByDefault: true,
  },
] as const;

export type CronPreset = (typeof CRON_PRESETS)[number];
export type CronPresetName = CronPreset["name"];

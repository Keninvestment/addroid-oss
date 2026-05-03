// AdDroid OSS — workspace / ad_account の execution mode 解決 (the current implementation)。
//
// 解決ロジック自体は `@addroid/queue` の `execution-mode.ts` に集約された
// (regression fix で github-poll / apply-executor も同じ規則で fail-closed
// するため)。本ファイルは worker / 既存テストの import 互換のために
// 同名 export を queue から再エクスポートする薄いシムとして残す。

export {
  normalizeExecutionMode,
  resolveExecutionMode,
} from "@addroid/queue";

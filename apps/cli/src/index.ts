// AdDroid OSS — CLI entry.
//
// `addroid <command>` のディスパッチ。各コマンドの実装は ./commands/* に分離している。
// すべての outbound interaction は AdDroid 自身が起点となり、CLI からは public な inbound
// ポートを開かない (Web UI は 127.0.0.1 のみ)。
//
// 起動直後にリポジトリ root の `.env` / `.env.local` を読み込み、DATABASE_URL 等が
// shell に export されていなくても addroid CLI から見えるようにする。Prisma CLI と
// Next.js は独自の dotenv 統合を持っているが、`addroid` 経路は素の Node プロセス
// なので明示ロードが必要 (詳細は packages/config/src/env-files.ts のコメント参照)。

import { loadEnvFilesFromRepoRoot } from "@addroid/config";
import { resolveRepoRoot } from "./lib/paths.js";

try {
  loadEnvFilesFromRepoRoot(resolveRepoRoot());
} catch {
  /* repo root を解決できない実行形態では env auto-load を skip。後段で明示エラー */
}

import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runUp } from "./commands/up.js";
import { runDown } from "./commands/down.js";
import { runLogs } from "./commands/logs.js";
import { runStatus } from "./commands/status.js";
import { runValidate } from "./commands/validate.js";
import { runPlan } from "./commands/plan.js";
import { runActivateCommand } from "./commands/activate.js";
import { runCronCommand } from "./commands/cron.js";
import { runAuthCommand } from "./commands/auth.js";
import { runAccountsCommand } from "./commands/accounts.js";
import { runBackupCommand, runRestoreCommand } from "./commands/backup.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      return 0;
    case "doctor":
      return runDoctor(rest);
    case "init":
      return runInit(rest);
    case "up":
      return runUp(rest);
    case "down":
      return runDown(rest);
    case "logs":
      return runLogs(rest);
    case "status":
      return runStatus(rest);
    case "validate":
      return runValidate(rest);
    case "plan":
      return runPlan(rest);
    case "activate":
      return runActivateCommand(rest);
    case "cron":
      return runCronCommand(rest);
    case "auth":
      return runAuthCommand(rest);
    case "accounts":
      return runAccountsCommand(rest);
    case "backup":
      return runBackupCommand(rest);
    case "restore":
      return runRestoreCommand(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      printHelp();
      return 2;
  }
}

function printHelp() {
  process.stdout.write(
    [
      "addroid — AdDroid OSS local CLI",
      "",
      "Usage:",
      "  addroid <command> [...args]",
      "",
      "Commands:",
      "  init      対話型初期セットアップ (.env / DB / ~/.addroid) と冪等 scaffold",
      "  doctor    uv / Python 3.12+ / Meta Ads CLI / PostgreSQL 16+ / DATABASE_URL / config を診断",
      "  up        web (127.0.0.1:3000) と worker (pg-boss) を 1 プロセスで併走起動 (--separate-worker で worker 別プロセス)",
      "  down      `addroid up` で起動したプロセスを停止 (pid file 経由)",
      "  logs      ~/.addroid/logs/{up,web,worker}.log の末尾を表示",
      "  status    config / プロセス / 直近 doctor 結果のスナップショット",
      "  validate  ops repo の Ads YAML / cron.yaml / project.yaml を Zod で検証 (CI で `npx addroid-cli validate`)",
      "  plan      ops repo から apply 案を simulate (--dry-run 必須)",
      "  activate  PAUSED 状態の Meta オブジェクトを ACTIVE に遷移 (Apply と別経路で監査)",
      "  cron      cron プリセットの list / enable / disable / set / run / logs (pg-boss + cron_schedules)",
      "  auth      provider 別のトークン登録 (Meta Access Token / Slack Socket Mode)",
      "  accounts  Meta Ad Account の取得・登録・デフォルト選択",
      "  backup    DATABASE_URL の DB を pg_dump で ~/.addroid/backups に保存 (Prisma + pg-boss を含む)",
      "  restore   pg_restore --clean --if-exists でダンプを復元 (実行前に `addroid down` を推奨)",
      "  version   CLI バージョン",
      "  help      このヘルプ",
      "",
      "All operations are localhost-bound and outbound-only.",
      "",
    ].join("\n")
  );
}

function printVersion() {
  process.stdout.write(`addroid ${process.env.npm_package_version ?? "0.0.0"}\n`);
}

const argv = process.argv.slice(2);
main(argv).then(
  (code) => {
    if (code !== 0) process.exit(code);
    // 0 のときは明示的に process.exit を呼ばない (up が永続 listen するため)。
    // 各コマンドが終わるべきタイミングは Promise の resolve 時で OK。
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

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
import { runChatCommand } from "./commands/chat.js";
import { runServiceCommand } from "./commands/service.js";
import { runStartCommand, runStopCommand } from "./commands/service-public.js";
import {
  runAccountCommand,
  runConnectCommand,
  runOpenCommand,
  runReportCommand,
  runScheduleCommand,
  runSubmitCommand,
} from "./commands/public.js";

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
    case "init":
      return runInit(rest);
    case "start":
      return runStartCommand(rest);
    case "stop":
      return runStopCommand(rest);
    case "open":
      return runOpenCommand(rest);
    case "status":
      return runStatus(rest);
    case "connect":
      return runConnectCommand(rest);
    case "account":
      return runAccountCommand(rest);
    case "report":
      return runReportCommand(rest);
    case "submit":
      return runSubmitCommand(rest);
    case "schedule":
      return runScheduleCommand(rest);
    case "chat":
      return runChatCommand(rest);
    case "backup":
      return runBackupCommand(rest);

    // Detailed / CI-oriented commands. They intentionally stay out of the top help.
    case "doctor":
      return runDoctor(rest);
    case "logs":
      return runLogs(rest);
    case "service":
      return runServiceCommand(rest);
    case "restore":
      return runRestoreCommand(rest);
    case "validate":
      return runValidate(rest);
    case "up":
      return runUp(rest);
    case "down":
      return runDown(rest);
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
      "  chat      自然文で操作する対話型 agent chat",
      "  init      初期設定・不足設定の案内",
      "  start     常駐サービスを起動・修復",
      "  stop      常駐サービスを停止",
      "  open      Web UI を開く / URL を表示",
      "  status    接続・起動状態を確認",
      "  connect   Meta / GitHub / AI / Slack を接続・再接続",
      "  account   利用する広告アカウントを確認・選択",
      "  report    レポート・改善チェックを今すぐ実行",
      "  submit    入稿前チェックと変更予定の確認",
      "  schedule  自動実行の確認・変更",
      "  backup    データベースをバックアップ",
      "  version   CLI バージョン",
      "  help      このヘルプ",
      "",
      "Detailed commands for CI / troubleshooting: doctor, logs, validate, plan, restore, service, up.",
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

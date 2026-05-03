// `addroid activate` — PAUSED 状態の `ads_hierarchy` ノード (campaign / adset / ad)
// を Meta 上で ACTIVE にする.
//
// 仕様:
//   - 引数で `<hierarchy_id>` を指定。--note は audit metadata に追記される (任意)。
//   - actor は "user:cli"。`addroid up` を介さず直接ローカル DB と Meta CLI を扱う。
//   - 既に ACTIVE / PAUSED でない / external_id 未確定の場合は exit 1 で reject 理由を表示。
//   - regression fix: ADDROID_META_CLI_BIN 未設定時は fail-closed で
//     unknown_error + meta.cli_unknown_error notify を返す (mock success による
//     ローカル状態遷移は許可しない — Activate は実 Meta API への課金開始を伴う最終操作)。
//     CLI 設定済みでも Meta token 未連携 / 期限切れの場合は auth_error +
//     oauth.meta.reauth_required notify を返し、再認証案内を audit に残す。
//   - regression fix: production の InMemoryMetaTokenStore 経路を廃止し、
//     web 側 OAuth フローが書き込んだ Prisma `oauth_tokens` を直接読み出す。
//     これにより CLI と Web UI が同じ token を共有し、register/refresh/reauth が
//     CLI Activate にもそのまま反映される。token row が存在しないか復号失敗時は
//     既存の CliActivateExecutor 経路で auth_error + oauth.meta.reauth_required
//     を返してフェイルクローズドする。
//   - DATABASE_URL 未設定の場合は exit 2。

import {
  runActivate,
  type ActivateOutcomeStatus,
  type ActivateRequest,
} from "@addroid/queue";
import { resolveActivateExecutor } from "../../../worker/src/lib/activate-meta-executor.js";
import { createPrismaActivateStore } from "../../../worker/src/lib/activate-runtime.js";
import { buildPrismaMetaAdapterSelection } from "../../../worker/src/lib/meta-runtime.js";
import { createPostgresAdAccountLockProvider } from "../../../worker/src/lib/account-lock.js";

interface ActivateOptions {
  hierarchyId: string;
  note: string | null;
  json: boolean;
}

export async function runActivateCommand(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (opts === null) return 2;

  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid activate] DATABASE_URL が設定されていません。`.env.local` を作成し再実行してください。\n"
    );
    return 2;
  }

  // Prisma / Meta adapter / executor を遅延 import (DB 不要のヘルプ表示で読み込まないため)。
  const { prisma } = await import("@addroid/db");
  // regression fix: 永続 OAuth token (web の `/api/oauth/meta/...` が `oauth_tokens`
  //   に暗号化保存した row) を直接読む Prisma-backed token store を使う。
  //   `InMemoryMetaTokenStore` を production で使うと、登録済み token があっても
  //   CLI からは見えず毎回 auth_error になっていたため、本経路を撤廃した。
  //   - OAuth client + crypto が揃わなければ Stub にフォールバックし、
  //     `loadAccessTokenPlaintext` が null を返す → CliActivateExecutor が
  //     auth_error + oauth.meta.reauth_required notify を返す (fail-closed)。
  //   - ADDROID_META_CLI_BIN 未設定時は MockActivateExecutor が
  //     unknown_error + meta.cli_unknown_error notify を返す (regression fix)。
  const adapterSelection = await buildPrismaMetaAdapterSelection({ prisma });
  const executorSelection = await resolveActivateExecutor({
    metaAdapter: adapterSelection.adapter,
  });
  const store = createPrismaActivateStore(prisma);
  // regression fix: CLI も worker / web と同じ Postgres advisory lock provider
  // を使い、別プロセスから同じ ad_account を触る並行 Meta CLI 実行を直列化する。
  const lockProvider = createPostgresAdAccountLockProvider({ prisma });

  const req: ActivateRequest = {
    hierarchyId: opts.hierarchyId,
    actor: "user:cli",
    source: "cli",
    ...(opts.note ? { note: opts.note } : {}),
  };

  try {
    const summary = await runActivate({
      request: req,
      store,
      executor: executorSelection.executor,
      lockProvider,
    });

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: summary.status === "activated",
            outcome: summary.status,
            hierarchyId: summary.hierarchyId,
            externalId: summary.externalId,
            attempts: summary.attempts,
            message: summary.message,
            finalAuditAction: summary.finalAuditAction,
            executorMode: executorSelection.mode,
          },
          null,
          2
        )}\n`
      );
    } else {
      printHuman(summary, executorSelection.mode, executorSelection.reason);
    }
    return exitCodeForOutcome(summary.status);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

function exitCodeForOutcome(outcome: ActivateOutcomeStatus): number {
  switch (outcome) {
    case "activated":
      return 0;
    case "already_active":
    case "not_paused":
    case "no_external_id":
    case "node_not_found":
    case "skipped_unsupported":
      return 1;
    case "auth_error":
    case "rate_limit_exhausted":
    case "api_error":
    case "unknown_error":
    default:
      return 1;
  }
}

function parseArgs(args: string[]): ActivateOptions | null {
  let hierarchyId: string | null = null;
  let note: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      printHelp();
      return null;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--note") {
      const next = args[i + 1];
      if (!next) {
        process.stderr.write("[addroid activate] --note に値がありません\n");
        return null;
      }
      note = next.slice(0, 256);
      i += 1;
    } else if (a.startsWith("--note=")) {
      note = a.slice("--note=".length).slice(0, 256);
    } else if (a.startsWith("--")) {
      process.stderr.write(`[addroid activate] 未知のオプション: ${a}\n`);
      printHelp();
      return null;
    } else if (hierarchyId === null) {
      hierarchyId = a;
    } else {
      process.stderr.write(
        `[addroid activate] 余分な引数: ${a}\n  hierarchyId は 1 つだけ指定してください\n`
      );
      return null;
    }
  }
  if (!hierarchyId) {
    process.stderr.write(
      "[addroid activate] <hierarchy_id> が必要です。--help を参照してください。\n"
    );
    return null;
  }
  return { hierarchyId, note, json };
}

function printHelp() {
  process.stdout.write(
    [
      "addroid activate — PAUSED の Meta オブジェクトを ACTIVE にする (Apply と別経路)",
      "",
      "Usage:",
      "  addroid activate <hierarchy_id> [--note <text>] [--json]",
      "",
      "Args:",
      "  <hierarchy_id>    ads_hierarchy.id (UUID)。/campaigns で確認できる",
      "",
      "Options:",
      "  --note <text>     audit_logs.metadata に保存される短い理由文 (256 文字まで)",
      "  --json            機械可読 JSON で結果を出力",
      "  --help, -h        このヘルプ",
      "",
      "Notes:",
      "  - 対象は PAUSED かつ external_id が確定済みのノードのみ。",
      "  - 結果は audit_logs に activate.requested → activate.committed (成功) ",
      "    または activate.rejected (失敗) として 2 行以上で記録される。",
      "  - actor は user:cli 固定 (Web UI 経由は user:web-ui)。",
      "",
    ].join("\n")
  );
}

function printHuman(
  summary: {
    status: ActivateOutcomeStatus;
    hierarchyId: string;
    externalId: string | null;
    attempts: number;
    message: string;
    finalAuditAction: string;
  },
  mode: "cli" | "mock",
  reason: string
): void {
  const lines: string[] = [];
  lines.push("[addroid activate]");
  lines.push("");
  lines.push(`  hierarchy_id  : ${summary.hierarchyId}`);
  lines.push(`  external_id   : ${summary.externalId ?? "(未確定)"}`);
  lines.push(`  outcome       : ${summary.status}`);
  lines.push(`  attempts      : ${summary.attempts}`);
  lines.push(`  audit         : ${summary.finalAuditAction}`);
  lines.push(`  executor      : ${mode} (${reason})`);
  lines.push("");
  lines.push(`  ${summary.message}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

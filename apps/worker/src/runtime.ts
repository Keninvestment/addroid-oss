// AdDroid OSS — pg-boss worker runtime.
//
// 起動シーケンスを `startWorker()` 関数として切り出し、`addroid up` の既定モード
// (web + worker を 1 プロセスで併走) からも、`apps/worker` 単独実行 (= `--separate-worker`
// or デバッグ用) からも同じロジックを共有できるようにしている。

import {
  APPLY_JOB_NAME,
  CRON_PRESETS,
  SLACK_COMMAND_JOB_NAME,
  bootPgBoss,
  buildAdAccountLockKey,
  failCronRun,
  finishCronRun,
  mirrorPresetsToCronSchedules,
  registerCronPresets,
  runBudgetGuardOnce,
  runDailyReportOnce,
  runExecuteApply,
  runGithubPollOnce,
  runImprovementPrOnce,
  runPerformanceSnapshotRetentionOnce,
  runSlackCommandJob,
  startCronRun,
  type BudgetGuardSummary,
  type DailyReportSummary,
  type ImprovementPrSummary,
  type JsonValue,
  type RetentionSweepSummary,
  type SlackCommandJobPayload,
} from "@addroid/queue";
import type PgBoss from "pg-boss";
import { prisma, type PrismaClient } from "@addroid/db";
import {
  LocalDiskStorage,
  defaultAddroidConfig,
  ensureAddroidPaths,
  readAddroidConfig,
} from "@addroid/config";
import {
  DEFAULT_CREATIVE_QA_POLICY,
} from "@addroid/llm-provider";
import { getGithubAdapter, injectGithubAdapter } from "@addroid/github-adapter";
import {
  createApplyJobStore,
  createCronOpsStore,
  createGithubPollStore,
  createNotificationAuditStore,
  createSlackCommandAuditStore,
  ensureWorkspace,
} from "./lib/prisma-stores.js";
import { createSlackCommandHandlers } from "./lib/slack-command-runtime.js";
import {
  createWorkerSlackNotifier,
  type WorkerSlackNotifier,
} from "./lib/slack-notifier-runtime.js";
import type { SlackNotificationPayload } from "@addroid/config";
import { resolveGithubAdapter } from "./lib/github-adapter-wiring.js";
import { resolveExecutionMode } from "./lib/execution-mode-resolution.js";
import { createLocalDirAdsLoaderFromEnv } from "./lib/apply-source.js";
import { resolveApplyExecutor } from "./lib/apply-meta-executor.js";
import { buildPrismaMetaAdapterSelection } from "./lib/meta-runtime.js";
import { createPostgresAdAccountLockProvider } from "./lib/account-lock.js";
import {
  MockDailyReportInsightsProvider,
  createAnalystRunner,
  createPrismaDailyReportSnapshotStore,
} from "./lib/daily-report-runtime.js";
import { resolveMetaCliInsightsProvider } from "./lib/meta-cli-insights-runtime.js";
import {
  buildBudgetGuardSpendContext,
  createBudgetGuardAuditRunner,
  createPrismaBudgetGuardStore,
  loadBudgetGuardPolicy,
} from "./lib/budget-guard-runtime.js";
import {
  createImprovementPrAuditWriter,
  createImprovementPrGithubPublisher,
  createImprovementPrPipelineRunner,
  createImprovementPrPlanValidator,
  createPrismaImprovementPrStore,
} from "./lib/improvement-pr-runtime.js";
import { createPrismaPerformanceSnapshotRetentionStore } from "./lib/retention-runtime.js";
import { selectLLMProviderForWorker } from "./lib/llm-runtime.js";
import { selectImageProviderForWorker } from "./lib/image-runtime.js";
import { startSlackSocketRuntime } from "./lib/slack-socket-runtime.js";
import type { SlackSocketReceiverHandle } from "@addroid/queue";
import { runDueAgentTasks } from "./lib/agent-task-runtime.js";

export interface StartWorkerOptions {
  /**
   * Override the DATABASE_URL precheck. Default: read `process.env.DATABASE_URL`.
   * 共有プロセスモードでは CLI 側が事前検査済みのため、明示注入も可能。
   */
  databaseUrl?: string;
  /**
   * Logger. 共有モードでは CLI 側で `[worker]` プレフィックス付きの logger を渡す想定。
   */
  logger?: WorkerLogger;
  /**
   * `true` のとき、startWorker 自身が SIGINT/SIGTERM を購読して shutdown する。
   * 共有モードでは CLI 側がシグナルを管理するので `false`。
   */
  installSignalHandlers?: boolean;
}

export interface WorkerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface WorkerHandle {
  /**
   * pg-boss の graceful stop + Prisma disconnect を行う。
   * `installSignalHandlers: true` の場合はシグナル経由で内部的に呼ばれる。
   */
  stop: () => Promise<void>;
}

const defaultLogger: WorkerLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const log = opts.logger ?? defaultLogger;
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("[worker] DATABASE_URL is not set. See .env.example.");
  }

  log.info("[worker] starting pg-boss…");
  const boss = await bootPgBoss({ databaseUrl });

  const paths = await ensureAddroidPaths();
  const config = (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  const workspace = await ensureWorkspace(prisma, {
    slug: config.workspace.slug,
    displayName: config.workspace.displayName,
    configPath: paths.configFile,
    storageDir: paths.storageDir,
    databaseUrlRef: config.database.urlRef,
    // regression fix: 初回 create 時のシード値。既存行は worker 再起動で
    // 触らない (UI/CLI からの mode 変更を保持する)。
    executionMode: config.workspace.executionMode,
  });
  log.info(
    `[worker] workspace ready: ${workspace.slug} (${workspace.id}) mode=${workspace.executionMode}`
  );

  const cronStore = createCronOpsStore(prisma, workspace.id);
  const githubStore = createGithubPollStore(prisma);

  const adapterSelection = await resolveGithubAdapter({ prisma });
  injectGithubAdapter(adapterSelection.adapter);
  log.info(
    `[worker] github adapter: ${adapterSelection.choice} (${adapterSelection.reason})`
  );

  await registerCronPresets(boss);
  const mirror = await mirrorPresetsToCronSchedules({
    store: cronStore,
    workspaceId: workspace.id,
  });

  // Regression fix: Slack 通知ディスパッチャを worker 起動時に
  // 1 度だけ構築する。本 notifier は producer (daily_report / budget_guard /
  // improvement_pr / execute_apply) の終端で `dispatch(payload)` を呼び、
  // Slack 連携が未設定なら `skipped_no_slack`、設定済みなら Slack Web API へ
  // chat.postMessage を投げる。`createNotificationAuditStore` を audit writer
  // として注入することで、各 dispatch が `audit_logs` に
  // notification.sent | notification.failed | notification.skipped_no_slack
  // を 1 行残す (UI design plan §4.2 NotificationDispatchRow)。
  // 重要: producer は dispatch の戻り値を握りつぶしてよい — Slack 失敗を
  // GitOps polling / Apply / Cron に伝播させないため (acceptance: "Slack
  // and Web UI failures do not block core GitOps polling, Apply, or Cron
  // execution.")。
  const notificationAudit = createNotificationAuditStore(prisma, workspace.id);
  const slackNotifier = createWorkerSlackNotifier({
    prisma,
    audit: notificationAudit,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
    },
  });
  const sendSlackNotification = makeSafeNotificationSender(slackNotifier, log);
  const webBaseUrl = process.env.ADDROID_WEB_BASE_URL?.trim() || null;

  // this implementation: daily_report cron は LLM Provider と insights provider
  //   を共有する。ADDROID_LLM_MOCK=1 のときは Mock provider が事前接続され、
  //   完全パイプラインを試せる。それ以外は Stub に倒れ、analyst 段階で
  //   `LLMProviderNotConfiguredError` を吸収して `status="ai_failed"` に倒す
  //   (snapshot は保存される — GitOps state は腐らない)。
  // Codex / OpenAI / Anthropic の OAuth は web 側のコールバックで `oauth_tokens`
  // テーブルに ciphertext + metadata (defaultModel 等) を保存する。worker は
  // prisma 経由で同じ encrypted boundary から token を読み出すため、prisma 注入は必須。
  const llmSelection = await selectLLMProviderForWorker(process.env, { prisma });
  log.info(
    `[worker] llm provider: ${llmSelection.choice} (${llmSelection.reason})`
  );

  // regression fix: improvement_pr cron が image_prompt variants を実画像生成
  // hop に流せるよう、image-Provider と LocalDisk Storage Adapter を 1 度だけ
  // 構築して runImprovementPrOnce に注入する。Provider 未設定 / 失敗時は
  // generateAndQaCreative が prompt-only fallback を返し、orchestrator が
  // creatives 行を storage 列 null で書き続ける (UI design plan principle 21/27)。
  const imageProviderSelection = await selectImageProviderForWorker(process.env, {
    prisma,
    preferCodex: llmSelection.choice === "codex",
  });
  log.info(
    `[worker] image provider: ${imageProviderSelection.choice} (${imageProviderSelection.reason})`
  );
  const creativeStorage = new LocalDiskStorage({ env: process.env });

  const metaAdapterSelection = await buildPrismaMetaAdapterSelection({
    prisma,
    env: process.env,
  });
  log.info(
    `[worker] meta adapter: ${metaAdapterSelection.choice} (${metaAdapterSelection.reason})`
  );

  const dailyReportStore = createPrismaDailyReportSnapshotStore(prisma);
  const metaCliInsightsSelection = await resolveMetaCliInsightsProvider({
    env: process.env,
    metaAdapter: metaAdapterSelection.adapter,
    resolveAdAccountId: async (accountKey) => {
      const row = await prisma.adAccount.findUnique({
        where: { workspaceId_key: { workspaceId: workspace.id, key: accountKey } },
        select: { metaAccountId: true },
      });
      return row?.metaAccountId ?? (accountKey.startsWith("act_") ? accountKey : null);
    },
  });
  log.info(
    `[worker] daily_report insights provider: ${metaCliInsightsSelection.mode} (${metaCliInsightsSelection.reason})`
  );
  const dailyReportInsights =
    metaCliInsightsSelection.provider ?? new MockDailyReportInsightsProvider();
  const dailyReportAnalyst = createAnalystRunner({
    provider: llmSelection.provider,
    workspaceId: workspace.id,
  });

  // Regression fix: budget_guard / improvement_pr cron も同じ
  // LLM Provider 経由で AI を呼び出す。runtime 側は store + agent runner を
  // factor out して、各 cron handler から runBudgetGuardOnce /
  // runImprovementPrOnce を 1 ティック単位で呼び出す。
  const budgetGuardStore = createPrismaBudgetGuardStore(prisma);
  const improvementPrStore = createPrismaImprovementPrStore(prisma);

  // Regression fix: 契約上の retention 要件
  //   - "Raw performance data retention is 90 days"
  //   - "aggregated campaign-or-higher retention is 1 year"
  // を強制するため、daily housekeeping preset retention_sweep に同じ store を渡す。
  const retentionStore = createPrismaPerformanceSnapshotRetentionStore(prisma);

  // Regression fix: ad_account 単位の cross-process 直列化境界。
  // Apply/Activate (Regression fix) と同じ Postgres advisory lock
  // を背に持つ provider を共有することで、daily_report / budget_guard /
  // improvement_pr の per-account inner block も Apply/Activate と同じ canonical
  // 識別子 (`buildAdAccountLockKey`) で 1 並行に直列化される。
  // 受入要件 "Cron workflows must use pg-boss and respect ad_account-level
  // execution limits" を満たす。
  const adAccountLockProvider = createPostgresAdAccountLockProvider({
    prisma,
    onReleaseError: (lockKey, error) => {
      log.warn(
        `[worker] ad_account lock release failed for ${lockKey}: ${(error as Error).message}`
      );
    },
    onAcquireError: (lockKey, error) => {
      log.warn(
        `[worker] ad_account lock acquire failed for ${lockKey}: ${(error as Error).message}`
      );
    },
  });

  for (const preset of CRON_PRESETS) {
    await boss.work(preset.name, async (jobs) => {
      for (const job of jobs) {
        const handle = await startCronRun(cronStore, {
          scheduleId: mirror.scheduleIdByName[preset.name] ?? null,
          name: preset.name,
          jobId: job.id,
        });
        try {
          if (preset.name === "github_poll") {
            const summary = await runGithubPollOnce({
              boss,
              store: githubStore,
              adapter: getGithubAdapter(),
              workspaceId: workspace.id,
            });
            await cronStore.recordExecutionLog({
              cronRunId: handle.cronRunId,
              workspaceId: workspace.id,
              kind: "github_poll",
              level:
                summary.status === "polled" || summary.status === "not_modified"
                  ? "info"
                  : "warn",
              message: `github_poll: ${summary.status}${summary.detail ? ` — ${summary.detail}` : ""}`,
              payload: {
                status: summary.status,
                prCount: summary.prCount ?? null,
                newlyMerged: summary.newlyMerged ?? null,
                enqueuedJobIds: summary.enqueuedJobIds ?? [],
              },
            });
            await finishCronRun(cronStore, handle, {
              status: summary.status,
              prCount: summary.prCount ?? null,
              newlyMerged: summary.newlyMerged ?? null,
              detail: summary.detail ?? null,
            });
          } else if (preset.name === "daily_report") {
            const requestedMetricDate = readMetricDateFromCronJobData(job.data);
            // Workspace 配下の active な ad_account 全件に対して順次実行する。
            // regression fix: 各 account の inner block は Apply/Activate と
            // 共通の `buildAdAccountLockKey` を経由して `withLock` で直列化する。
            // これにより同一 (workspaceId, accountKey) に対する Apply / Activate /
            // 他 cron workflow が cross-process で 1 並行に揃う。
            // regression fix: 同時に modeOverride を取得し、workspace mode との
            // 優先解決で実効 mode を決定する。
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: { key: true, displayName: true, modeOverride: true },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const summaries: DailyReportSummary[] = [];
            const errors: string[] = [];
            for (const acc of accounts) {
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                () =>
                  runDailyReportOnce({
                    workspaceId: workspace.id,
                    // regression fix: workspace.executionMode と
                    // ad_account.modeOverride を解決した実効 mode。daily_report
                    // 自体は Meta を変更しないが、AI runs / cron output に記録
                    // される `mode` が正しい運用値を反映する必要がある。
                    mode: effectiveMode,
                    accountKey: acc.key,
                    ...(requestedMetricDate ? { metricDate: requestedMetricDate } : {}),
                    insightsProvider: dailyReportInsights,
                    store: dailyReportStore,
                    analyst: dailyReportAnalyst,
                  })
              );
              summaries.push(summary);
              const ok =
                summary.status === "succeeded" ||
                summary.status === "no_account";
              const level: "info" | "warn" | "error" = ok
                ? "info"
                : summary.status === "no_insights"
                  ? "warn"
                  : "error";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `daily_report ${acc.key}: ${summary.status}` +
                  (summary.aiCommentary
                    ? ` — ${summary.aiCommentary.slice(0, 120)}`
                    : summary.errorMessage
                      ? ` — ${summary.errorMessage}`
                      : ""),
                payload: dailyReportSummaryToPayload(summary),
              });
              if (summary.status === "ai_failed") {
                errors.push(`${acc.key}: ${summary.errorMessage ?? "ai failed"}`);
                // regression fix: AI 失敗を Slack に通知する。failCronRun は
                // この per-account ループ終了後に走るため、失敗の発生個所を
                // 通知側でも明示する (acceptance: "Slack notifications are
                // sent for ..., and failures.")。dispatch 失敗は
                // sendSlackNotification 内で握り潰されるので cron 進行を
                // ブロックしない。
                const reportRunsUrl = buildWebUrl(webBaseUrl, "/cron/runs");
                await sendSlackNotification({
                  kind: "daily_report.failed",
                  data: {
                    adAccountKey: acc.key,
                    metricDate: summary.metricDate,
                    errorMessage: summary.errorMessage ?? "ai failed",
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(reportRunsUrl ? { runsUrl: reportRunsUrl } : {}),
                  },
                });
              }
              // regression fix: daily_report が succeeded を返した時のみ
              // `daily_report.completed` 通知を送る。AI 失敗 / no_insights /
              // no_account は通知価値が低く、Slack ノイズを増やすため送らない
              // (= 必要なら /reports や /cron/runs から確認できる)。
              if (summary.status === "succeeded") {
                const reportUrl = summary.aiRunId
                  ? buildWebUrl(webBaseUrl, `/reports/${summary.aiRunId}`)
                  : undefined;
                const topImprovements = summary.topImprovements
                  .slice(0, 3)
                  .map((c) =>
                    [c.target, c.rationale].filter((s) => !!s).join(" — ")
                  )
                  .filter((s) => s.length > 0);
                await sendSlackNotification({
                  kind: "daily_report.completed",
                  data: {
                    reportId: summary.aiRunId ?? `daily_report:${acc.key}`,
                    adAccountKey: acc.key,
                    metricDate: summary.metricDate,
                    spendUsd: summary.current.spend,
                    impressions: summary.current.impressions,
                    clicks: summary.current.clicks,
                    conversions: summary.current.conversions,
                    topImprovements,
                    mode: summary.mode,
                    ...(reportUrl ? { reportUrl } : {}),
                  },
                });
              }
            }
            const aggregate = {
              kind: "daily_report",
              status: errors.length > 0 ? "failed" : "succeeded",
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              ai_failed: summaries.filter((s) => s.status === "ai_failed").length,
              no_insights: summaries.filter((s) => s.status === "no_insights").length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              llmProvider: llmSelection.choice,
              insightsSource: summaries[0]?.insightsSource ?? "unavailable",
              accounts: summaries.map((s) => dailyReportSummaryToPayload(s)),
            };
            if (errors.length > 0) {
              const message =
                summaries.length === 0
                  ? "daily_report skipped: no active ad_accounts"
                  : `daily_report had AI failures: ${errors.join("; ")}`;
              if (summaries.length === 0) {
                // 何もしなかった場合は finish (ok) — ユーザに「未設定」を伝える
                // ためには /accounts の空状態 UI で十分。
                await finishCronRun(cronStore, handle, {
                  ...aggregate,
                  note: "no active ad_accounts in workspace",
                });
              } else {
                await failCronRun(cronStore, handle, message);
              }
            } else {
              await finishCronRun(cronStore, handle, aggregate);
            }
          } else if (preset.name === "budget_guard") {
            // regression fix: workspace mode + per-account modeOverride を
            // 取得し、orchestrator 呼び出しごとに解決した実効 mode を渡す。
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: {
                id: true,
                key: true,
                displayName: true,
                modeOverride: true,
              },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const summaries: BudgetGuardSummary[] = [];
            const errors: string[] = [];
            // this implementation: ops repo に workflows/budget-guard.yaml が
            // 無ければ fail-closed。policy=null を orchestrator に渡し、
            // status="policy_missing" を per-account で記録する。
            const loaded = loadBudgetGuardPolicy(process.env);
            const auditRunner = createBudgetGuardAuditRunner({
              provider: llmSelection.provider,
              workspaceId: workspace.id,
              cronRunId: handle.cronRunId,
            });
            for (const acc of accounts) {
              const accountBudget = loaded?.accountBudgets[acc.key];
              // regression fix: per-account inner block を canonical
              // ad_account lock で直列化する。policy 読み出しと
              // `buildBudgetGuardSpendContext` (ad_account 紐付き集計) も
              // ロック内に入れることで、Apply / Activate と spend ウィンドウ
              // 観測のレースを防ぐ。
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                async () =>
                  loaded
                    ? runBudgetGuardOnce({
                        workspaceId: workspace.id,
                        // regression fix: workspace + ad_account の解決済み mode。
                        // policy 適用は execution-mode.ts の fail-closed 規則で
                        // report_only/proposal を確実に守る。
                        mode: effectiveMode,
                        accountKey: acc.key,
                        policy: loaded.policy,
                        spendContext: await buildBudgetGuardSpendContext({
                          prisma,
                          accountId: acc.id,
                          dailyBudget: accountBudget?.dailyBudget ?? 0,
                          monthlyBudget: accountBudget?.monthlyBudget ?? 0,
                          ...(accountBudget?.currency
                            ? { currency: accountBudget.currency }
                            : {}),
                        }),
                        store: budgetGuardStore,
                        runner: auditRunner,
                      })
                    : runBudgetGuardOnce({
                        workspaceId: workspace.id,
                        // regression fix: policy 欠落時も解決済み mode を渡す。
                        // 評価自体は policy=null で fail-closed (=
                        // status="policy_missing") に倒れるが、ai_runs /
                        // cron output の mode 記録が運用値を反映する必要がある。
                        mode: effectiveMode,
                        accountKey: acc.key,
                        policy: null,
                        store: budgetGuardStore,
                        runner: auditRunner,
                      })
              );
              summaries.push(summary);
              const level: "info" | "warn" | "error" =
                summary.status === "succeeded"
                  ? "info"
                  : summary.status === "no_account" ||
                      summary.status === "policy_missing"
                    ? "warn"
                    : "error";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `budget_guard ${acc.key}: ${summary.status}` +
                  (summary.classification
                    ? ` — ${summary.classification}/${summary.decision ?? "n/a"}`
                    : summary.errorMessage
                      ? ` — ${summary.errorMessage}`
                      : ""),
                payload: budgetGuardSummaryToPayload(summary),
              });
              if (summary.status === "ai_failed") {
                errors.push(`${acc.key}: ${summary.errorMessage ?? "ai failed"}`);
                // regression fix: budget_guard の AI 失敗を Slack に通知する。
                // policy_missing は fail-closed の正常経路 (= 設定漏れ)
                // なのでここでは通知しない (UI の `/budget-guard` 赤バナーで
                // 案内される)。dispatch 失敗は sendSlackNotification 内で
                // 握り潰されるので cron 進行をブロックしない。
                const guardRunsUrl = buildWebUrl(webBaseUrl, "/cron/runs");
                await sendSlackNotification({
                  kind: "budget_guard.failed",
                  data: {
                    adAccountKey: acc.key,
                    errorMessage: summary.errorMessage ?? "ai failed",
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(guardRunsUrl ? { runsUrl: guardRunsUrl } : {}),
                  },
                });
              }
              // regression fix: budget_guard が succeeded を返した場合のみ
              // 評価結果に応じて Slack に通知する:
              //   - decision="auto_approved" かつ alerts に severity="trigger"
              //     が含まれる → auto_pause が走った想定で
              //     `budget_guard.auto_paused`。
              //   - alerts が 1 件以上ある → `budget_guard.alert`。
              //   - alerts が無い (= 平常) → 通知しない (Slack ノイズ抑制)。
              if (summary.status === "succeeded") {
                const triggeredAlerts = summary.alerts.filter(
                  (a) => a.severity === "trigger"
                );
                const warnAlerts = summary.alerts.filter(
                  (a) => a.severity === "warn"
                );
                const evaluationTime = new Date().toISOString();
                const budgetUrl = buildWebUrl(webBaseUrl, "/budget-guard");
                if (
                  summary.decision === "auto_approved" &&
                  triggeredAlerts.length > 0
                ) {
                  const primary = triggeredAlerts[0]!;
                  await sendSlackNotification({
                    kind: "budget_guard.auto_paused",
                    data: {
                      adAccountKey: acc.key,
                      rule: primary.rule,
                      threshold: String(primary.threshold),
                      observedValue: String(primary.observedValue),
                      evaluationTime,
                      pausedTargets: summary.dangerousCategories,
                      mode: summary.mode,
                      ...(budgetUrl ? { budgetUrl } : {}),
                    },
                  });
                } else if (warnAlerts.length > 0 || triggeredAlerts.length > 0) {
                  const primary = triggeredAlerts[0] ?? warnAlerts[0]!;
                  await sendSlackNotification({
                    kind: "budget_guard.alert",
                    data: {
                      adAccountKey: acc.key,
                      rule: primary.rule,
                      threshold: String(primary.threshold),
                      observedValue: String(primary.observedValue),
                      evaluationTime,
                      mode: summary.mode,
                      ...(budgetUrl ? { budgetUrl } : {}),
                    },
                  });
                }
              }
            }
            const aggregate = {
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              ai_failed: summaries.filter((s) => s.status === "ai_failed").length,
              policy_missing: summaries.filter(
                (s) => s.status === "policy_missing"
              ).length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              llmProvider: llmSelection.choice,
              policySource: loaded ? "ops_repo" : "missing",
            };
            if (errors.length > 0) {
              await failCronRun(
                cronStore,
                handle,
                `budget_guard had AI failures: ${errors.join("; ")}`
              );
            } else {
              await finishCronRun(cronStore, handle, {
                ...aggregate,
                ...(summaries.length === 0
                  ? { note: "no active ad_accounts in workspace" }
                  : {}),
              });
            }
          } else if (preset.name === "improvement_pr") {
            // regression fix: workspace mode + per-account modeOverride を取得し、
            // 解決した実効 mode を ad_account ごとに改めて渡す。dangerous category
            // / safe-category の policy gate (execution-mode.ts) が mode に応じて
            // fail-closed する。
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: {
                id: true,
                key: true,
                displayName: true,
                modeOverride: true,
              },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const summaries: ImprovementPrSummary[] = [];
            const errors: string[] = [];
            const pipelineRunner = createImprovementPrPipelineRunner({
              provider: llmSelection.provider,
              workspaceId: workspace.id,
              cronRunId: handle.cronRunId,
            });
            const publisher = createImprovementPrGithubPublisher({
              prisma,
              adapter: getGithubAdapter(),
              workspaceId: workspace.id,
            });
            // regression fix: 生成された YAML 変更を CLI / `/api/plan` と同じ
            // runPlanForRoot で検証し、PR body と audit metadata に実 plan 結果を残す。
            const planValidator = createImprovementPrPlanValidator({
              rootDir: process.env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || null,
              baseDir: process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null,
            });
            const auditWriter = createImprovementPrAuditWriter({ prisma });
            // ops repo "owner/name" を gitops agent に渡すため事前ロード。
            const wsForRepo = await prisma.workspace.findUnique({
              where: { id: workspace.id },
              select: { opsRepoId: true },
            });
            const repoRow = wsForRepo?.opsRepoId
              ? await prisma.githubRepo.findUnique({
                  where: { id: wsForRepo.opsRepoId },
                  select: { owner: true, name: true, defaultBranch: true },
                })
              : null;
            const repoSpec = repoRow
              ? `${repoRow.owner}/${repoRow.name}`
              : "";
            const baseRef = repoRow?.defaultBranch ?? "main";
            for (const acc of accounts) {
              // regression fix: improvement_pr は最終的に GitHub PR を立てる
              // だけで Meta を直接変更しないが、performance_snapshots / ai_runs
              // を読みつつ analyst → media_buyer → gitops を順に走らせる per
              // -account パイプラインのため、Apply/Activate / 他 cron と同じ
              // canonical lock で直列化する (1 ad_account = 1 並行)。
              // regression fix: 直近 daily_report が残した performance_snapshots
              // を analyst input + PR body の "Snapshots" セクションへ流すため、
              // ロック内で最新 metricDate 分の id を収集して `snapshotIds` に渡す。
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                async () => {
                  const snapshotIds = await loadLatestPerformanceSnapshotIds(
                    prisma,
                    acc.id
                  );
                  return runImprovementPrOnce({
                    workspaceId: workspace.id,
                    // regression fix: workspace + ad_account の解決済み mode。
                    // execution-mode.ts の policy gate がここに依存して
                    // report_only=auto_blocked / dangerous=approval_required
                    // を保証する。
                    mode: effectiveMode,
                    accountKey: acc.key,
                    repo: repoSpec,
                    baseRef,
                    snapshotIds,
                    store: improvementPrStore,
                    pipeline: pipelineRunner,
                    publisher,
                    planValidator,
                    audit: auditWriter,
                    cronRunId: handle.cronRunId,
                    // regression fix: image-Provider hop。未設定でも fallback で
                    // 200 OK 返るため、注入条件は付けず常に渡す。
                    imageProvider: imageProviderSelection.provider,
                    creativeStorage,
                    // regression fix: 非空の Creative QA policy を明示的に
                    // 注入する。the current implementation acceptance "Creative QA checks
                    // dimensions, format, quality, forbidden expressions,
                    // and brand-tone constraints before PR attachment" は
                    // production runtime が空 policy で skip 経路に倒れる
                    // ことを許容しない。
                    creativeQaPolicy: DEFAULT_CREATIVE_QA_POLICY,
                  });
                }
              );
              summaries.push(summary);
              const level: "info" | "warn" | "error" =
                summary.status === "succeeded" ||
                summary.status === "skipped_no_proposal" ||
                summary.status === "auto_blocked" ||
                summary.status === "no_account"
                  ? summary.status === "no_account"
                    ? "warn"
                    : "info"
                  : "error";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `improvement_pr ${acc.key}: ${summary.status}` +
                  (summary.decision
                    ? ` — ${summary.decision} (${summary.proposalCount} proposals)`
                    : summary.errorMessage
                      ? ` — ${summary.errorMessage}`
                      : ""),
                payload: improvementPrSummaryToPayload(summary),
              });
              if (
                summary.status === "ai_failed" ||
                summary.status === "pr_failed"
              ) {
                errors.push(
                  `${acc.key}: ${summary.errorMessage ?? summary.status}`
                );
                // regression fix: AI / PR 作成失敗を Slack に通知する。
                // skipped_no_proposal / auto_blocked は失敗ではない (= AI が
                // 「改善案なし」と判断した正常経路) ので通知しない。
                // dispatch 失敗は sendSlackNotification 内で握り潰されるので
                // cron 進行をブロックしない。
                const improvementRunsUrl = buildWebUrl(
                  webBaseUrl,
                  "/cron/runs"
                );
                await sendSlackNotification({
                  kind: "improvement_pr.failed",
                  data: {
                    adAccountKey: acc.key,
                    failureStage:
                      summary.status === "pr_failed" ? "pr" : "ai",
                    errorMessage: summary.errorMessage ?? summary.status,
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(improvementRunsUrl
                      ? { runsUrl: improvementRunsUrl }
                      : {}),
                  },
                });
              }
              // regression fix: improvement_pr が succeeded で PR を作った時のみ
              // `improvement_pr.opened` 通知を送る。skipped_no_proposal /
              // auto_blocked は通知しない (Slack は PR 承認の主経路ではないため、
              // 「実物 PR が立った」イベントだけが Slack に上がる)。
              // regression fix: 同じ「実物 PR が立った」イベントに対して、
              // generic な `pr.opened` 通知も先に送る。the current implementation acceptance
              // 「Slack notifications are sent for PR creation, ...,
              // improvement PRs, ...」は "PR creation" を独立した notification
              // kind として要求しており、UI design plan §4.2 でも
              // `pr.opened` は NotificationKindBadge と 1:1 対応する別種別。
              // 失敗は `sendSlackNotification` 内で握り潰されるため Apply /
              // Cron に伝播しない。
              if (
                summary.status === "succeeded" &&
                summary.pullRequest &&
                repoRow
              ) {
                const riskLabel: "safe" | "requires_approval" | "dangerous" =
                  summary.classification ?? "requires_approval";
                const webApprovalsUrl = buildWebUrl(
                  webBaseUrl,
                  `/approvals/${summary.pullRequest.prNumber}`
                );
                await sendSlackNotification({
                  kind: "pr.opened",
                  data: {
                    prNumber: summary.pullRequest.prNumber,
                    prTitle: `improvement_pr (${acc.key})`,
                    prUrl: summary.pullRequest.htmlUrl,
                    repoFullName: repoSpec,
                    workflow: "improvement_pr",
                    adAccountKey: acc.key,
                    riskLabel,
                    ...(webApprovalsUrl ? { webApprovalsUrl } : {}),
                  },
                });
                await sendSlackNotification({
                  kind: "improvement_pr.opened",
                  data: {
                    prNumber: summary.pullRequest.prNumber,
                    prTitle: `improvement_pr (${acc.key})`,
                    prUrl: summary.pullRequest.htmlUrl,
                    repoFullName: repoSpec,
                    adAccountKey: acc.key,
                    riskLabel,
                    dangerousCategories: summary.dangerousCategories,
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(webApprovalsUrl ? { webApprovalsUrl } : {}),
                  },
                });
              }
            }
            const aggregate = {
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              skipped_no_proposal: summaries.filter(
                (s) => s.status === "skipped_no_proposal"
              ).length,
              auto_blocked: summaries.filter(
                (s) => s.status === "auto_blocked"
              ).length,
              ai_failed: summaries.filter((s) => s.status === "ai_failed").length,
              pr_failed: summaries.filter((s) => s.status === "pr_failed").length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              llmProvider: llmSelection.choice,
            };
            if (errors.length > 0) {
              await failCronRun(
                cronStore,
                handle,
                `improvement_pr had failures: ${errors.join("; ")}`
              );
            } else {
              await finishCronRun(cronStore, handle, {
                ...aggregate,
                ...(summaries.length === 0
                  ? { note: "no active ad_accounts in workspace" }
                  : {}),
              });
            }
          } else if (preset.name === "agent_tasks") {
            const summary = await runDueAgentTasks({
              prisma,
              workspaceId: workspace.id,
              provider: llmSelection.provider,
              boss,
            });
            const level: "info" | "warn" | "error" =
              summary.status === "succeeded"
                ? "info"
                : summary.status === "partial_failure"
                  ? "warn"
                  : "error";
            await cronStore.recordExecutionLog({
              cronRunId: handle.cronRunId,
              workspaceId: workspace.id,
              kind: "cron",
              refType: "cron_run",
              refId: handle.cronRunId,
              level,
              message:
                `agent_tasks: ${summary.status} ` +
                `(due=${summary.due}, succeeded=${summary.succeeded}, failed=${summary.failed})`,
              payload: summary as unknown as JsonValue,
            });
            if (summary.status === "failed") {
              await failCronRun(
                cronStore,
                handle,
                `agent_tasks failed: ${summary.failed}/${summary.due}`
              );
            } else {
              await finishCronRun(cronStore, handle, summary as unknown as JsonValue);
            }
          } else if (preset.name === "retention_sweep") {
            // Regression fix: performance_snapshots の保持期間
            // (raw=90d / aggregate=1y) を強制する housekeeping。AI を呼ばないため
            // workspace mode に依存しない。1 ティック = 全 workspace 共有の sweep。
            const summary = await runPerformanceSnapshotRetentionOnce({
              store: retentionStore,
            });
            const level: "info" | "warn" | "error" =
              summary.status === "succeeded"
                ? "info"
                : summary.status === "partial_failure"
                  ? "warn"
                  : "error";
            await cronStore.recordExecutionLog({
              cronRunId: handle.cronRunId,
              workspaceId: workspace.id,
              kind: "cron",
              refType: "cron_run",
              refId: handle.cronRunId,
              level,
              message:
                `retention_sweep: ${summary.status} ` +
                `(raw_cleared=${summary.rawCleared.affected}, ` +
                `granular_deleted=${summary.granularDeleted.affected}, ` +
                `aggregated_deleted=${summary.aggregatedDeleted.affected})`,
              payload: retentionSummaryToPayload(summary),
            });
            if (summary.status === "failed") {
              await failCronRun(
                cronStore,
                handle,
                `retention_sweep failed: ${[
                  summary.rawCleared.error,
                  summary.granularDeleted.error,
                  summary.aggregatedDeleted.error,
                ]
                  .filter((e): e is string => e !== null)
                  .join("; ")}`
              );
            } else {
              await finishCronRun(
                cronStore,
                handle,
                retentionSummaryToPayload(summary)
              );
            }
          }
          // 全 preset は上記 if/else if で網羅済み (CRON_PRESETS は型で固定)。
          // 新たな preset を CRON_PRESETS に追加した場合は本ブロックに分岐を足す。
        } catch (err) {
          await failCronRun(cronStore, handle, err).catch(() => undefined);
          log.warn(
            `[worker] cron handler failed (${preset.name}): ${(err as Error).message}`
          );
          // regression fix: 未分類の cron handler crash を Slack に通知する。
          // failCronRun で cron_runs 行は failed に倒れているが、Slack 通知が
          // 無いと運用者は `/cron/runs` を能動的に開くまで気付けない
          // (acceptance: "Slack notifications are sent for ..., and
          // failures.")。dispatch 自体の失敗は sendSlackNotification 内で
          // 握り潰されるので、Slack 連携が切れても cron loop は次の job を
          // 通常通り処理する。
          const cronRunsUrl = buildWebUrl(webBaseUrl, "/cron/runs");
          await sendSlackNotification({
            kind: "cron.failed",
            data: {
              cronName: preset.name,
              errorMessage: (err as Error).message ?? String(err),
              cronRunId: handle.cronRunId,
              ...(cronRunsUrl ? { runsUrl: cronRunsUrl } : {}),
            },
          });
        }
      }
    });
  }

  // execute_apply: merged PR の YAML を読み、buildExecutionPlan で plan を組み、
  // PAUSED-by-default で Meta CLI / mock executor に流す。
  // regression fix: meta adapter は CLI / web と同じ Prisma 永続 token store 経由で
  //   組み立てる (`buildPrismaMetaAdapterSelection`)。OAuth 未連携時は Stub に倒れ、
  //   後段の `resolveApplyExecutor` / `resolveActivateExecutor` で auth_error +
  //   `oauth.meta.reauth_required` notify として fail-closed する。helper 内で
  //   secrets / crypto 読み込みの例外は吸収済みのため、await 1 回で確定する。
  const applyJobStore = createApplyJobStore(prisma, workspace.id);
  // regression fix: AdsLoader は workspace の opsRepoId を識別子として保持し、
  // apply_jobs の context.repoId と一致した PR だけを localDir から load する。
  // ops repo が未登録の workspace では apply_jobs が積まれないため、ここで
  // null だった場合は repoId verification をスキップせず fail-closed する。
  const wsRow = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: { opsRepoId: true },
  });
  const adsLoader = createLocalDirAdsLoaderFromEnv(process.env, {
    expectedRepoId: wsRow?.opsRepoId ?? null,
  });
  const applyExecutorSelection = await resolveApplyExecutor({
    env: process.env,
    metaAdapter: metaAdapterSelection.adapter,
    resolveAdAccountId: async (accountKey) => {
      const row = await prisma.adAccount.findUnique({
        where: { workspaceId_key: { workspaceId: workspace.id, key: accountKey } },
        select: { metaAccountId: true },
      });
      return row?.metaAccountId ?? (accountKey.startsWith("act_") ? accountKey : null);
    },
  });
  log.info(
    `[worker] apply executor: ${applyExecutorSelection.mode} (${applyExecutorSelection.reason})`
  );

  // regression fix / regression fix: cross-process ad_account ロックは
  // Postgres advisory lock を背に持つ provider を共有する。Apply (worker) と
  // Activate (web/cli)、cron workflows (daily_report/budget_guard/
  // improvement_pr) が同じ Postgres インスタンスを介して 1 並行を強制する
  // ため、`adAccountLockProvider` は cron preset 登録より先に作成済み。
  await boss.work(APPLY_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      // pg-boss のジョブ ID は apply_jobs.jobId と一致する。row 取得して applyJobId を解決する。
      let applyJobId: string | null = null;
      try {
        const row = await prisma.applyJob.findFirst({
          where: { jobId: job.id },
          select: { id: true },
        });
        applyJobId = row?.id ?? null;
      } catch (err) {
        log.warn(
          `[worker] failed to resolve apply_job for pg-boss job ${job.id}: ${(err as Error).message}`
        );
      }
      if (!applyJobId) {
        log.warn(
          `[worker] received ${APPLY_JOB_NAME} job ${job.id} but no apply_job row; ignoring`
        );
        continue;
      }
      log.info(
        `[worker] received ${APPLY_JOB_NAME} job: ${job.id} (apply_job=${applyJobId})`
      );
      const startedAt = Date.now();
      try {
        const summary = await runExecuteApply({
          applyJobId,
          workspaceId: workspace.id,
          store: applyJobStore,
          loader: adsLoader,
          executor: applyExecutorSelection.executor,
          lockProvider: adAccountLockProvider,
        });
        log.info(
          `[worker] execute_apply ${applyJobId}: ${summary.state} (succeeded=${summary.succeeded}, failed=${summary.failed}, skipped=${summary.skipped}, paused-rewrites=${summary.pausedRewrites})`
        );
        // regression fix: Apply 終端で `apply.completed` または `apply.failed`
        // を Slack 通知する。`simulated` は実 Meta mutation を伴わないため通知
        // 価値が低く、`/apply` から確認できれば十分なので skip。
        if (summary.state === "succeeded" || summary.state === "failed") {
          const meta = await loadApplyNotificationMeta(prisma, applyJobId);
          const accountKeys = collectAccountKeysFromOutcomes(summary.outcomes);
          const adAccountKey =
            accountKeys.length === 0
              ? "(none)"
              : accountKeys.length === 1
                ? accountKeys[0]!
                : `${accountKeys[0]!} +${accountKeys.length - 1}`;
          const applyUrl = buildWebUrl(webBaseUrl, `/apply/${applyJobId}`);
          if (summary.state === "succeeded") {
            await sendSlackNotification({
              kind: "apply.completed",
              data: {
                applyJobId,
                adAccountKey,
                ...(meta?.prNumber != null
                  ? { prNumber: meta.prNumber }
                  : {}),
                ...(meta?.repoFullName
                  ? { repoFullName: meta.repoFullName }
                  : {}),
                filesTouched: summary.totalActions,
                durationMs: Date.now() - startedAt,
                metaObjectsAffected: summary.succeeded,
                ...(applyUrl ? { applyUrl } : {}),
                resultSummary:
                  `succeeded=${summary.succeeded} failed=${summary.failed}` +
                  ` skipped=${summary.skipped} paused-rewrites=${summary.pausedRewrites}`,
              },
            });
          } else {
            await sendSlackNotification({
              kind: "apply.failed",
              data: {
                applyJobId,
                adAccountKey,
                ...(meta?.prNumber != null
                  ? { prNumber: meta.prNumber }
                  : {}),
                ...(meta?.repoFullName
                  ? { repoFullName: meta.repoFullName }
                  : {}),
                errorMessage:
                  summary.errorMessage ?? `apply terminated in ${summary.state}`,
                ...(summary.abortReason
                  ? { errorCode: summary.abortReason }
                  : {}),
                ...(applyUrl ? { applyUrl } : {}),
              },
            });
          }
        }
      } catch (err) {
        log.error(
          `[worker] execute_apply ${applyJobId} crashed: ${(err as Error).message}`
        );
        try {
          await prisma.applyJob.update({
            where: { id: applyJobId },
            data: {
              state: "failed",
              finishedAt: new Date(),
              errorMessage: `worker handler crashed: ${(err as Error).message}`,
            },
          });
        } catch {
          /* swallow secondary error */
        }
        // regression fix: handler crash も failure path として Slack に通知
        // する。markApplyFinished が走った保証は無いが、apply_jobs 行は
        // 上の update で `failed` に倒れているため UI 側と通知が整合する。
        const meta = await loadApplyNotificationMeta(prisma, applyJobId).catch(
          () => null
        );
        const applyUrl = buildWebUrl(webBaseUrl, `/apply/${applyJobId}`);
        await sendSlackNotification({
          kind: "apply.failed",
          data: {
            applyJobId,
            adAccountKey: "(crashed)",
            ...(meta?.prNumber != null ? { prNumber: meta.prNumber } : {}),
            ...(meta?.repoFullName
              ? { repoFullName: meta.repoFullName }
              : {}),
            errorMessage: `worker handler crashed: ${(err as Error).message}`,
            errorCode: "handler_crash",
            ...(applyUrl ? { applyUrl } : {}),
          },
        });
      }
    }
  });

  // regression fix / the current implementation: `slack_command` pg-boss consumer を起動する。
  // Slack Socket Mode 受信機 (= 後段 startSlackSocketRuntime) が
  // `/adops <subcommand>` を ack 後に enqueue する pg-boss キューを処理する。
  // ハンドラ群は report / budget / improve / status / accounts / activate の
  // 6 種を持ち、Web/CLI と同じワークフロー (runDailyReportOnce /
  // runBudgetGuardOnce / runImprovementPrOnce / executeActivate) に橋渡しする。
  //
  // - 結果は Slack response_url に sanitize 済みで返り、`SlackCommandAuditWriter`
  //   が audit_logs に `slash_command.completed | slash_command.failed |
  //   activate.via_slack` を 1 行残す (UI design plan §0.20)。
  // - Slack 連携が未設定でも本 consumer は起動する (Slack 受信機が動かなければ
  //   キューに job が入らないだけ)。逆に Slack 連携を後から追加した場合に worker
  //   再起動なしで処理できる。
  // - 各ハンドラは throw しない契約。万一 throw しても `runSlackCommandJob` が
  //   catch して `slash_command.failed` audit + Slack 通知に倒すため、cron /
  //   apply には伝播しない。
  const slackCommandHandlers = createSlackCommandHandlers({
    prisma,
    workspaceId: workspace.id,
    adAccountLockProvider,
    dailyReportStore,
    dailyReportInsights,
    dailyReportAnalyst,
    budgetGuardStore,
    budgetGuardAuditRunner: createBudgetGuardAuditRunner({
      provider: llmSelection.provider,
      workspaceId: workspace.id,
    }),
    loadBudgetGuardPolicy: () => loadBudgetGuardPolicy(process.env),
    improvementPrStore,
    improvementPrPipeline: createImprovementPrPipelineRunner({
      provider: llmSelection.provider,
      workspaceId: workspace.id,
    }),
    improvementPrPublisher: createImprovementPrGithubPublisher({
      prisma,
      adapter: getGithubAdapter(),
      workspaceId: workspace.id,
    }),
    improvementPrPlanValidator: createImprovementPrPlanValidator({
      rootDir: process.env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || null,
      baseDir: process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null,
    }),
    improvementPrAudit: createImprovementPrAuditWriter({ prisma }),
    // regression fix: cron 経路と同じ image-Provider + LocalDisk Storage を
    // /adops improve の inline 起動でも共有する。
    improvementPrImageProvider: imageProviderSelection.provider,
    improvementPrCreativeStorage: creativeStorage,
    // regression fix: cron 経路と同じ非空 Creative QA policy を /adops improve
    // からも適用する (空 policy で blocking check が skip に倒れて素通りする
    // 状態を slack 経由でも作らない)。
    improvementPrCreativeQaPolicy: DEFAULT_CREATIVE_QA_POLICY,
    loadImprovementPrRepo: async () => {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspace.id },
        select: { opsRepoId: true },
      });
      const repo = ws?.opsRepoId
        ? await prisma.githubRepo.findUnique({
            where: { id: ws.opsRepoId },
            select: { owner: true, name: true, defaultBranch: true },
          })
        : null;
      return {
        repoSpec: repo ? `${repo.owner}/${repo.name}` : "",
        baseRef: repo?.defaultBranch ?? "main",
      };
    },
    metaAdapter: metaAdapterSelection.adapter,
    env: process.env,
    webBaseUrl,
  });
  const slackCommandAudit = createSlackCommandAuditStore(prisma, workspace.id);

  await boss.work(SLACK_COMMAND_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data as SlackCommandJobPayload;
      try {
        const result = await runSlackCommandJob({
          payload,
          handlers: slackCommandHandlers,
          audit: slackCommandAudit,
        });
        log.info(
          `[worker] slack_command ${payload.subcommand}` +
            (payload.target ? ` ${payload.target}` : "") +
            `: ${result.state}` +
            ` (posted=${result.postedToResponseUrl}, durationMs=${result.durationMs})`
        );
      } catch (err) {
        // runSlackCommandJob は throw しない契約だが、防御的に飲み込む。
        // Slack 失敗は GitOps polling / Apply / Cron に伝播させない。
        log.warn(
          `[worker] slack_command ${payload?.subcommand ?? "<unknown>"} crashed: ${(err as Error).message}`
        );
      }
    }
  });

  // regression fix / the current implementation: Slack Socket Mode `/adops` 受信機を起動する。
  // Slack 連携は完全に任意なので、`startSlackSocketRuntime` は token 未設定 /
  // ENCRYPTION_KEY 未設定 / 復号失敗のいずれの場合も `null` を返し、worker は
  // GitOps polling / Apply / Cron を通常通り稼働させる (acceptance: "Slack
  // integration is optional", "Slack and Web UI failures do not block core
  // GitOps polling, Apply, or Cron execution")。
  let slackSocketHandle: SlackSocketReceiverHandle | null = null;
  try {
    slackSocketHandle = await startSlackSocketRuntime({
      prisma,
      boss,
      logger: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
      },
    });
    if (slackSocketHandle) {
      log.info(
        `[worker] slack socket mode receiver: ${slackSocketHandle.getState()} (/adops)`
      );
    } else {
      log.info(
        "[worker] slack socket mode receiver: skipped (Slack is optional and unconfigured)"
      );
    }
  } catch (err) {
    // startSlackSocketRuntime は throw しない契約だが、防御的に握り潰す。
    log.warn(
      `[worker] slack socket mode receiver failed to start: ${(err as Error).message}`
    );
  }

  log.info(
    `[worker] ready. registered ${CRON_PRESETS.length} cron preset(s), execute_apply receiver, slack_command receiver.`
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (slackSocketHandle) {
      try {
        await slackSocketHandle.stop();
      } catch (err) {
        log.warn(
          `[worker] error during slack socket stop: ${(err as Error).message}`
        );
      }
    }
    try {
      await boss.stop({ graceful: true });
    } catch (err) {
      log.warn(`[worker] error during pg-boss stop: ${(err as Error).message}`);
    }
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  };

  if (opts.installSignalHandlers) {
    const onSignal = (signal: NodeJS.Signals) => {
      log.info(`[worker] received ${signal}, shutting down…`);
      stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return { stop };
}

/**
 * this implementation: daily_report summary を execution_logs.payload に
 * 入る形 (JsonValue 互換) に変換する。BigInt や Date は前段で丸められて
 * いるため、ここでは shape の最小化のみを行う。
 */
function dailyReportSummaryToPayload(summary: DailyReportSummary): JsonValue {
  // KpiSet には `frequency: number | null` があり、JsonValue は undefined を
  // 含まないため、null 化したうえで明示的に JsonValue へ落とし込む。
  const kpis = (k: DailyReportSummary["current"]): JsonValue => ({
    spend: k.spend,
    impressions: k.impressions,
    clicks: k.clicks,
    conversions: k.conversions,
    ctr: k.ctr,
    cpc: k.cpc,
    cpa: k.cpa,
    cv: k.cv,
    cpm: k.cpm,
    frequency: k.frequency ?? null,
  });
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    workspaceId: summary.workspaceId,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    currency: summary.currency,
    metricDate: summary.metricDate,
    priorMetricDate: summary.priorMetricDate,
    insightsSource: summary.insightsSource,
    mode: summary.mode,
    snapshotIds: summary.snapshotIds,
    aiRunId: summary.aiRunId,
    deltas: summary.deltas,
    current: kpis(summary.current),
    prior: kpis(summary.prior),
    aiCommentary: summary.aiCommentary,
    topImprovements: summary.topImprovements.map((c) => ({
      hierarchy: c.hierarchy,
      target: c.target,
      rationale: c.rationale,
      expectedImpact: c.expectedImpact,
    })),
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  return payload;
}

/**
 * Regression fix + implementation item: budget_guard summary →
 * execution_logs.payload。
 */
function budgetGuardSummaryToPayload(summary: BudgetGuardSummary): JsonValue {
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    mode: summary.mode,
    aiRunId: summary.aiRunId,
    classification: summary.classification,
    decision: summary.decision,
    dangerousCategories: summary.dangerousCategories,
    policyReasons: summary.policyReasons,
    candidateCount: summary.candidateCount,
    alerts: summary.alerts.map((a) => ({
      rule: a.rule,
      severity: a.severity,
      message: a.message,
      observedValue: a.observedValue,
      threshold: a.threshold,
    })),
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  return payload;
}

/**
 * Regression fix: improvement_pr summary → execution_logs.payload。
 */
function improvementPrSummaryToPayload(summary: ImprovementPrSummary): JsonValue {
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    currency: summary.currency,
    mode: summary.mode,
    aiRunId: summary.aiRunId,
    aiRunIds: summary.aiRunIds,
    decision: summary.decision,
    proposalCount: summary.proposalCount,
    classification: summary.classification,
    auditDecision: summary.auditDecision,
    dangerousCategories: summary.dangerousCategories,
    pullRequest: summary.pullRequest
      ? {
          pullRequestId: summary.pullRequest.pullRequestId,
          prNumber: summary.pullRequest.prNumber,
          htmlUrl: summary.pullRequest.htmlUrl,
          headSha: summary.pullRequest.headSha,
        }
      : null,
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  return payload;
}

/**
 * Regression fix: retention_sweep summary → execution_logs.payload。
 */
function retentionSummaryToPayload(summary: RetentionSweepSummary): JsonValue {
  return {
    status: summary.status,
    rawCutoff: summary.rawCutoff,
    aggregateCutoff: summary.aggregateCutoff,
    policy: {
      rawDays: summary.policy.rawDays,
      aggregateDays: summary.policy.aggregateDays,
    },
    rawCleared: {
      affected: summary.rawCleared.affected,
      error: summary.rawCleared.error,
    },
    granularDeleted: {
      affected: summary.granularDeleted.affected,
      error: summary.granularDeleted.error,
    },
    aggregatedDeleted: {
      affected: summary.aggregatedDeleted.affected,
      error: summary.aggregatedDeleted.error,
    },
  };
}

/**
 * Regression fix: improvement_pr に紐付ける `performance_snapshots`
 * の id を返す。直近 daily_report が確定させた最新 metricDate に属する全行を
 * 1 セットとして扱う (account/campaign/adset/ad の混在)。
 *
 * - スナップショットがまだ無い account では空配列を返す。`composePrBody` は
 *   その場合 "- (none)" を出力するが、これは「直近 daily_report が未実行」の
 *   正当な状態であり、PR をブロックしない。
 * - 順序は createdAt 昇順 (= daily_report が書いた順) で固定し、PR body の
 *   差分が冪等になるようにする。
 */
/**
 * Regression fix: cron tick 単位で `workspaces.executionMode` を
 * 読み出す。worker 起動時にも `ensureWorkspace` が値を返すが、UI/CLI の mode
 * 切替は worker を再起動せずに反映される必要があるため、各 cron 起動時に再取得
 * する (1 行 1 列の lookup なので無視できるコスト)。
 */
async function loadWorkspaceMode(
  client: PrismaClient,
  workspaceId: string
): Promise<string | null> {
  const row = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { executionMode: true },
  });
  return row?.executionMode ?? null;
}

/**
 * Regression fix: Apply 通知 (apply.completed / apply.failed) で
 * 表示する PR 番号 / repo full name を取得する。`apply_jobs.pullRequestId` →
 * `github_pull_requests.repoId` → `github_repos.{owner,name}` の 1 ホップ
 * チェーン。失敗時は null を返し、通知側は該当フィールドを省略する
 * (= notification 失敗で apply pipeline を degrade させない)。
 */
async function loadApplyNotificationMeta(
  client: PrismaClient,
  applyJobId: string
): Promise<{ prNumber: number; repoFullName: string } | null> {
  try {
    const apply = await client.applyJob.findUnique({
      where: { id: applyJobId },
      select: { pullRequestId: true },
    });
    if (!apply?.pullRequestId) return null;
    const pr = await client.githubPullRequest.findUnique({
      where: { id: apply.pullRequestId },
      select: { number: true, repoId: true },
    });
    if (!pr) return null;
    const repo = await client.githubRepo.findUnique({
      where: { id: pr.repoId },
      select: { owner: true, name: true },
    });
    if (!repo) return { prNumber: pr.number, repoFullName: "" };
    return { prNumber: pr.number, repoFullName: `${repo.owner}/${repo.name}` };
  } catch {
    return null;
  }
}

/**
 * Apply の outcomes から触れた ad_account の unique key を昇順で返す。
 * Slack 通知の `adAccountKey` 表示に使う。outcomes が空 (= no_actions) の
 * ケースも安全に空配列を返す。
 */
function collectAccountKeysFromOutcomes(
  outcomes: ReadonlyArray<{ action: { account: string } }>
): string[] {
  const set = new Set<string>();
  for (const o of outcomes) {
    if (o.action && typeof o.action.account === "string") {
      set.add(o.action.account);
    }
  }
  return [...set].sort();
}

/**
 * Regression fix: Slack 通知ディスパッチを producer から呼ぶための
 * 「失敗を握りつぶす」ラッパ。`WorkerSlackNotifier.dispatch` 自身が throw しない
 * 契約だが、防御的に try/catch で覆って Slack 起因の例外が GitOps polling /
 * Apply / Cron / Improvement PR cron に伝播することを根本から塞ぐ。
 *
 * - `failed` / `skipped_no_slack` は audit_logs に notifier 側で記録済み。
 * - logger には sanitize 済みの 1 行 summary のみ書き、平文 token を残さない。
 */
function makeSafeNotificationSender(
  notifier: WorkerSlackNotifier,
  log: WorkerLogger
): (payload: SlackNotificationPayload) => Promise<void> {
  return async (payload: SlackNotificationPayload): Promise<void> => {
    try {
      const result = await notifier.dispatch(payload);
      if (result.state === "failed") {
        log.warn(
          `[worker] slack notification ${result.kind} failed: ${result.errorCode ?? "unknown"}`
        );
      }
    } catch (err) {
      log.warn(
        `[worker] slack notification ${payload.kind} crashed (swallowed): ${(err as Error).message}`
      );
    }
  };
}

/**
 * `webBaseUrl` が設定されていれば `path` を base URL に対して resolve した
 * 絶対 URL を返す。Slack の Block Kit `<button>` action は `http(s)://` で
 * 始まる URL のみ受け付けるため、未設定時は undefined を返してリンクを省略。
 */
function buildWebUrl(
  base: string | null,
  path: string
): string | undefined {
  if (!base) return undefined;
  const trimmedBase = base.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmedBase)) return undefined;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function readMetricDateFromCronJobData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).metricDate;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

async function loadLatestPerformanceSnapshotIds(
  client: PrismaClient,
  accountId: string
): Promise<string[]> {
  const latest = await client.performanceSnapshot.findFirst({
    where: { accountId },
    orderBy: { metricDate: "desc" },
    select: { metricDate: true },
  });
  if (!latest) return [];
  const rows = await client.performanceSnapshot.findMany({
    where: { accountId, metricDate: latest.metricDate },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}

export type { PgBoss };

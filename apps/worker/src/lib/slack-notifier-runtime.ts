// AdDroid OSS — apps/worker Slack notification dispatcher wiring (Regression fix).
//
// `@addroid/config` の `dispatchSlackNotification` は副作用を持たない関数で、
// 呼び出し側が `botToken` / `channelId` / `audit` writer を渡す契約。本ファイルは
// worker プロセスから producer (daily_report / budget_guard / improvement_pr /
// execute_apply) ごとに呼び出すための薄いアダプタを提供する:
//
//   1. `oauth_tokens(provider="slack")` を都度参照し、`getCryptoBoundary` で
//      復号した平文 `xoxb-*` と metadata.notificationChannelId をディスパッチに
//      使う。Slack 連携が未設定 (行が無い / ENCRYPTION_KEY 不在 / 復号失敗 /
//      channel 未設定) の場合は `botToken=""`/`channelId=""` で渡し、
//      dispatcher 側の `skipped_no_slack` 経路に倒す。
//   2. `createNotificationAuditStore` で構築した audit writer を注入し、各
//      dispatch 終了時に `audit_logs` に 1 行残す (UI design plan §1 の
//      `notification.sent | failed | skipped_no_slack`)。
//   3. **本関数は throw しない**。Slack 失敗を GitOps polling / Apply / Cron
//      に伝播させない契約のため (acceptance: "Slack and Web UI failures do
//      not block core GitOps polling, Apply, or Cron execution.")。
//
// 設計上、prisma の cache を 1 ティック内で共有するためメモ化等は行わない。
// 通知 1 回ごとに 1 SELECT + 1 dispatch + 1 INSERT (audit) で十分軽量である。

import {
  dispatchSlackNotification,
  getCryptoBoundary,
  sanitizeForSlack,
  type CryptoBoundary,
  type NotificationAuditWriter,
  type SlackDispatchResult,
  type SlackFetch,
  type SlackNotificationPayload,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";

export interface WorkerSlackNotifierLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface CreateWorkerSlackNotifierOptions {
  prisma: PrismaClient;
  /** implementation item: dispatch 終了時に呼ばれる audit_logs writer。 */
  audit: NotificationAuditWriter;
  /** test seam: Slack Web API 呼び出し用 fetch を差し替える。 */
  slackFetch?: SlackFetch;
  /** test seam: 暗号境界を差し替える。 */
  cryptoBoundary?: CryptoBoundary;
  /** test seam: 決定的時刻注入。 */
  now?: () => Date;
  logger?: WorkerSlackNotifierLogger;
}

export interface WorkerSlackNotifier {
  /**
   * Slack 通知を 1 件 dispatch する。Slack 未設定なら `skipped_no_slack` を
   * 返し、外部 HTTP は走らない。failed でも throw しない。
   */
  dispatch(payload: SlackNotificationPayload): Promise<SlackDispatchResult>;
}

interface SlackInstallationMetadataShape {
  notificationChannelId?: unknown;
}

/**
 * `oauth_tokens(provider="slack")` から bot token + 通知チャンネル ID を
 * 取り出す。連携が未設定 / 復号失敗の場合は null を返す (= skipped に倒す)。
 */
async function loadSlackBotConfig(opts: {
  prisma: PrismaClient;
  cryptoBoundary?: CryptoBoundary;
  logger?: WorkerSlackNotifierLogger;
}): Promise<{ botToken: string; channelId: string } | null> {
  const log = opts.logger;

  let crypto: CryptoBoundary;
  try {
    crypto = opts.cryptoBoundary ?? getCryptoBoundary();
  } catch (err) {
    log?.info?.(
      `[slack-notifier] ENCRYPTION_KEY 未設定のため Slack 通知を skip: ${(err as Error).message}`
    );
    return null;
  }

  let row: {
    accessTokenCiphertext: string;
    metadata: unknown;
  } | null;
  try {
    row = await opts.prisma.oAuthToken.findFirst({
      where: { provider: "slack" },
      orderBy: { connectedAt: "desc" },
      select: {
        accessTokenCiphertext: true,
        metadata: true,
      },
    });
  } catch (err) {
    log?.warn?.(
      `[slack-notifier] oauth_tokens 読み出し失敗 (Slack 通知 skip): ${sanitizeForSlack((err as Error).message)}`
    );
    return null;
  }
  if (!row) return null;

  let botToken: string;
  try {
    botToken = crypto.decrypt(row.accessTokenCiphertext);
  } catch (err) {
    log?.warn?.(
      `[slack-notifier] Slack bot token の復号に失敗 (Slack 通知 skip): ${sanitizeForSlack((err as Error).message)}`
    );
    return null;
  }

  const metadata = (row.metadata ?? {}) as SlackInstallationMetadataShape;
  const channelId =
    typeof metadata.notificationChannelId === "string"
      ? metadata.notificationChannelId.trim()
      : "";
  if (!channelId) {
    log?.info?.(
      "[slack-notifier] notificationChannelId が未設定のため Slack 通知を skip。`addroid auth slack` で通知チャンネルを設定してください。"
    );
    return null;
  }

  return { botToken, channelId };
}

/**
 * worker producer から呼ぶ Slack 通知ディスパッチャを構築する。
 *
 * - Slack 連携が未設定でも例外を出さず、`skipped_no_slack` を返す契約。
 * - audit writer (`createNotificationAuditStore`) を必ず注入し、`audit_logs`
 *   に sent / failed / skipped_no_slack を 1 行残す。
 * - producer 側は `await notifier.dispatch(...)` の結果を握りつぶしてよい
 *   (失敗を GitOps polling / Apply / Cron に伝播させないため)。
 */
export function createWorkerSlackNotifier(
  opts: CreateWorkerSlackNotifierOptions
): WorkerSlackNotifier {
  return {
    async dispatch(
      payload: SlackNotificationPayload
    ): Promise<SlackDispatchResult> {
      const config = await loadSlackBotConfig({
        prisma: opts.prisma,
        ...(opts.cryptoBoundary ? { cryptoBoundary: opts.cryptoBoundary } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      // Slack 未設定でも dispatcher を呼び、audit に skipped_no_slack を残す。
      // (= acceptance: "skipped_no_slack" は failed ではなく benign idle として
      //  audit / UI に出る)。
      return await dispatchSlackNotification(payload, {
        botToken: config?.botToken ?? "",
        channelId: config?.channelId ?? "",
        audit: opts.audit,
        ...(opts.slackFetch ? { fetchImpl: opts.slackFetch } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    },
  };
}

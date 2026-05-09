// AdDroid OSS — /cron page rate-limit summary (this implementation).
//
// `/cron` は schedule 操作に加え rate-limit の "簡易表示" を求められている
// (acceptance: "Web UI can show ... rate-limit status from real persisted state.")。
// `/logs` の詳細ビューに対し、ここでは現行 severity と直近 throttle イベントの
// サマリを 1 カードで提示し、詳細は `/logs` へ誘導する。

import Link from "next/link";
import { prisma } from "../../lib/prisma";
import {
  DEFAULT_META_RATE_LIMIT_POLICY,
  computeBackoffDelayMs,
  extractThrottleObservation,
  type ThrottleObservation,
  type ThrottleSeverity,
} from "@addroid/queue";
import { Panel } from "../../components/ui/Panel";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { InlineCode } from "../../components/ui/CodeBlock";
import type { StatusState } from "../../components/ui/StatusDot";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";

interface ExecLogRow {
  id: string;
  createdAt: Date;
  kind: string;
  payload: unknown;
}

const SEVERITY_ORDER: ThrottleSeverity[] = [
  "normal",
  "approaching",
  "throttled",
  "backoff",
];

function pickWorstSeverity(severities: ThrottleSeverity[]): ThrottleSeverity {
  let worst: ThrottleSeverity = "normal";
  for (const s of severities) {
    if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) worst = s;
  }
  return worst;
}

function severityToStatusState(severity: ThrottleSeverity): StatusState {
  switch (severity) {
    case "normal":
      return "idle";
    case "approaching":
    case "throttled":
      return "warn";
    case "backoff":
      return "error";
  }
}

function severityLabel(severity: ThrottleSeverity): string {
  switch (severity) {
    case "normal":
      return "normal · throttle なし";
    case "approaching":
      return "approaching · 80%+";
    case "throttled":
      return "throttled · 95%+";
    case "backoff":
      return "backoff · 待機中";
  }
}

function coercePayload(raw: unknown): Parameters<typeof extractThrottleObservation>[0] {
  if (raw === null || raw === undefined) return undefined;
  return raw as Parameters<typeof extractThrottleObservation>[0];
}

interface Observation {
  createdAt: Date;
  observation: ThrottleObservation;
}

export async function CronRateLimitSummary() {
  let dbReady = true;
  let logs: ExecLogRow[] = [];
  try {
    logs = await prisma.executionLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, createdAt: true, kind: true, payload: true },
    });
  } catch {
    dbReady = false;
  }

  const observations: Observation[] = [];
  for (const row of logs) {
    const obs = extractThrottleObservation(coercePayload(row.payload));
    if (!obs) continue;
    observations.push({ createdAt: row.createdAt, observation: obs });
    if (observations.length >= 20) break;
  }
  const worst = pickWorstSeverity(observations.map((o) => o.observation.severity));
  const lastObservedAt = observations[0]?.createdAt ?? null;
  const pageDisplayTimeZone = resolveDisplayTimeZone();

  return (
    <Panel
      title="Rate limit (簡易)"
      subtitle={
        dbReady
          ? "Meta API throttle の現行 severity と backoff 設定。詳細は /logs へ。"
          : "DB に接続できないため throttle 状態を取得できません。"
      }
      status={
        <StatusBadge state={severityToStatusState(worst)}>
          {severityLabel(worst)}
        </StatusBadge>
      }
    >
      <KeyValueList
        items={[
          {
            label: "Concurrency",
            value: (
              <>
                1 / ad_account (<InlineCode>buildAdAccountLockKey</InlineCode>)
              </>
            ),
          },
          {
            label: "Backoff policy",
            value: (
              <>
                最大 {DEFAULT_META_RATE_LIMIT_POLICY.maxAttempts} 回 / 初回{" "}
                {DEFAULT_META_RATE_LIMIT_POLICY.initialBackoffMs} ms / 上限{" "}
                {DEFAULT_META_RATE_LIMIT_POLICY.maxBackoffMs} ms / 係数 ×
                {DEFAULT_META_RATE_LIMIT_POLICY.factor}
              </>
            ),
          },
          {
            label: "Backoff schedule",
            value: (
              <InlineCode>
                {[1, 2, 3]
                  .map((attempt) => `${computeBackoffDelayMs(attempt)} ms`)
                  .join(" → ")}
              </InlineCode>
            ),
          },
          {
            label: "Recent throttle events",
            value: dbReady
              ? observations.length === 0
                ? "直近 100 件の execution_logs に throttle 観測はありません。"
                : `${observations.length} 件 (直近 100 件の execution_logs から派生)`
              : "—",
          },
          {
            label: "Last observed",
            value: lastObservedAt
              ? formatDateTime(lastObservedAt, { timeZone: pageDisplayTimeZone })
              : "—",
          },
          {
            label: "詳細ビュー",
            value: (
              <Link href="/logs" className="mono">
                /logs (rate limit & throttle の完全表示)
              </Link>
            ),
          },
        ]}
      />
    </Panel>
  );
}

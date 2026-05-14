"use client";

// AdDroid OSS — /cron 行内 controls (this implementation).
//
// 1 行ぶんの cron preset に対する 3 操作 (toggle / schedule edit / run-now) を
// 結線するクライアントコンポーネント。各操作は ConfirmDialog を経由して
// `/api/cron/[name]/{toggle | schedule | run}` に POST し、結果を Toast で返す。
//
// 設計上の注意:
//   - No Dead UI: すべてのボタン/入力にハンドラと API 接続を実装する。
//   - Unified feedback: 成功・失敗いずれも Toast で通知し、エラー時は inline でも
//     残す。saving フラグはエラー時にも必ず false に戻す。
//   - schedule 編集は free text。永続化前にサーバー側で validateCronExpression。
//   - run-now は ConfirmDialog (caution) で確認する — daily_report / improvement_pr
//     は AI コストや GitHub PR 作成といった副作用を伴うため。

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cronRunMonitorConfigForPreset } from "../../components/cronRunMonitorConfig";
import { useCronRunMonitor } from "../../components/useCronRunMonitor";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { BusyLabel } from "../../components/ui/AsyncFeedback";
import { useToast } from "../../components/ui/Toast";

export interface CronControlsProps {
  presetName: string;
  description: string;
  initialEnabled: boolean;
  initialCron: string;
  /**
   * cron_schedules 行が DB に存在しないケース。サーバー側 API は cron_schedules を
   * 必要に応じて upsert するため、このフラグは UI ヒント (デフォルト値の出所) のみ。
   */
  persistedFromDb: boolean;
}

export function CronControls({
  presetName,
  description,
  initialEnabled,
  initialCron,
  persistedFromDb,
}: CronControlsProps) {
  const router = useRouter();
  const toast = useToast();

  const [enabled, setEnabled] = useState(initialEnabled);
  const [cron, setCron] = useState(initialCron);
  const [draftCron, setDraftCron] = useState(initialCron);
  const [editing, setEditing] = useState(false);
  const [busyKind, setBusyKind] =
    useState<null | "toggle" | "schedule" | "run">(null);
  const [confirm, setConfirm] = useState<
    | null
    | { kind: "toggle"; nextEnabled: boolean }
    | { kind: "run" }
  >(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const monitorConfig = cronRunMonitorConfigForPreset(presetName);
  const runMonitor = useCronRunMonitor({
    presetName,
    ...monitorConfig,
    onTerminal: (state) => {
      router.refresh();
      if (state.phase === "failed") {
        const msg = state.errorMessage ?? "実行履歴を確認してください。";
        setInlineError(msg);
        toast.push({
          variant: "error",
          title: `${presetName} の手動実行が失敗しました`,
          description: msg,
        });
      } else if (state.phase === "timeout") {
        toast.push({
          variant: "info",
          title: `${presetName} はバックグラウンドで継続中です`,
          description:
            state.errorMessage ??
            "実行履歴で完了状況を確認してください。",
        });
      }
    },
  });

  const dirty = draftCron.trim() !== cron.trim();

  function openToggleConfirm(nextEnabled: boolean) {
    setInlineError(null);
    setConfirm({ kind: "toggle", nextEnabled });
  }

  function openRunConfirm() {
    setInlineError(null);
    setConfirm({ kind: "run" });
  }

  async function performToggle(nextEnabled: boolean) {
    setBusyKind("toggle");
    try {
      const res = await fetch(
        `/api/cron/${encodeURIComponent(presetName)}/toggle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        }
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        enabled?: boolean;
        cron?: string;
      };
      if (!res.ok || !body.ok) {
        const msg = body.error ?? `HTTP ${res.status}`;
        toast.push({
          variant: "error",
          title: nextEnabled
            ? `${presetName} を有効化できませんでした`
            : `${presetName} を無効化できませんでした`,
          description: msg,
        });
        setInlineError(msg);
        setBusyKind(null);
        return;
      }
      setEnabled(body.enabled ?? nextEnabled);
      if (typeof body.cron === "string" && body.cron.trim() !== "") {
        setCron(body.cron);
        setDraftCron(body.cron);
      }
      toast.push({
        variant: "success",
        title: nextEnabled
          ? `${presetName} を有効化しました`
          : `${presetName} を無効化しました`,
        description: nextEnabled
          ? `自動実行を再開しました (${body.cron ?? cron}).`
          : "自動実行を停止しました。実行中の処理は中断されません。",
      });
      setBusyKind(null);
      setConfirm(null);
      router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      toast.push({
        variant: "error",
        title: `${presetName} の状態変更に失敗しました`,
        description: msg,
      });
      setInlineError(msg);
      setBusyKind(null);
    }
  }

  async function performScheduleSave() {
    const next = draftCron.trim();
    if (next === "") {
      setInlineError("cron 式が空です。");
      return;
    }
    setBusyKind("schedule");
    setInlineError(null);
    try {
      const res = await fetch(
        `/api/cron/${encodeURIComponent(presetName)}/schedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cron: next }),
        }
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        cron?: string;
        enabled?: boolean;
        reschedulePending?: boolean;
      };
      if (!res.ok || !body.ok) {
        const msg = body.error ?? `HTTP ${res.status}`;
        toast.push({
          variant: "error",
          title: `${presetName} の schedule 変更に失敗しました`,
          description: msg,
        });
        setInlineError(msg);
        setBusyKind(null);
        return;
      }
      const persistedCron = body.cron ?? next;
      setCron(persistedCron);
      setDraftCron(persistedCron);
      setEditing(false);
      toast.push({
        variant: "success",
        title: `${presetName} の実行タイミングを更新しました`,
        description: body.reschedulePending
          ? `${persistedCron} を保存しました。停止中のため、有効化した時に反映されます。`
          : `${persistedCron} に更新しました。`,
      });
      setBusyKind(null);
      router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      toast.push({
        variant: "error",
        title: `${presetName} の schedule 変更に失敗しました`,
        description: msg,
      });
      setInlineError(msg);
      setBusyKind(null);
    }
  }

  async function performRunNow() {
    setBusyKind("run");
    try {
      const res = await fetch(
        `/api/cron/${encodeURIComponent(presetName)}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        jobId?: string | null;
      };
      if (!res.ok || !body.ok) {
        const msg = body.error ?? `HTTP ${res.status}`;
        toast.push({
          variant: "error",
          title: `${presetName} の手動実行に失敗しました`,
          description: msg,
        });
        setInlineError(msg);
        setBusyKind(null);
        return;
      }
      toast.push({
        variant: "success",
        title: `${presetName} を開始しました`,
        description: body.jobId
          ? `受付ID: ${body.jobId}`
          : "実行要求を受け付けました。",
      });
      runMonitor.start(body.jobId ?? null);
      setBusyKind(null);
      setConfirm(null);
      if (!body.jobId) router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      toast.push({
        variant: "error",
        title: `${presetName} の手動実行に失敗しました`,
        description: msg,
      });
      setInlineError(msg);
      setBusyKind(null);
    }
  }

  return (
    <div className="cron-controls">
      <div className="cron-controls__row">
        {editing ? (
          <>
            <input
              type="text"
              className="form-input mono"
              value={draftCron}
              onChange={(e) => setDraftCron(e.target.value)}
              spellCheck={false}
              aria-label={`${presetName} cron 式`}
              style={{ width: "12rem" }}
              disabled={busyKind === "schedule"}
            />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={performScheduleSave}
              disabled={busyKind !== null || !dirty}
            >
              {busyKind === "schedule" ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setEditing(false);
                setDraftCron(cron);
                setInlineError(null);
              }}
              disabled={busyKind !== null}
            >
              キャンセル
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`btn btn--sm ${enabled ? "btn--caution" : "btn--primary"}`}
              onClick={() => openToggleConfirm(!enabled)}
              disabled={busyKind !== null}
            >
              {enabled ? "OFF にする" : "ON にする"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setEditing(true);
                setDraftCron(cron);
                setInlineError(null);
              }}
              disabled={busyKind !== null}
            >
              時間を編集
            </button>
            <button
              type="button"
              className="btn btn--caution btn--sm"
              onClick={openRunConfirm}
              disabled={busyKind !== null || runMonitor.isActive}
              aria-busy={busyKind === "run" || runMonitor.isActive}
            >
              {busyKind === "run" ? (
                <BusyLabel>開始中</BusyLabel>
              ) : runMonitor.isActive ? (
                <BusyLabel>{runMonitor.label}</BusyLabel>
              ) : (
                "今すぐ実行"
              )}
            </button>
          </>
        )}
      </div>
      {runMonitor.state.phase !== "idle" ? (
        <div className="cron-controls__run-status" data-state={runMonitor.state.phase}>
          {runMonitor.isActive ? (
            <BusyLabel>{runMonitor.label}</BusyLabel>
          ) : runMonitor.state.phase === "success" ? (
            "完了しました。"
          ) : runMonitor.state.phase === "timeout" ? (
            runMonitor.state.errorMessage ??
            "画面上の確認を停止しました。実行履歴を確認してください。"
          ) : (
            `失敗しました${runMonitor.state.errorMessage ? `: ${runMonitor.state.errorMessage}` : "。"}`
          )}
        </div>
      ) : null}
      {!persistedFromDb ? (
        <div className="cron-controls__hint">
          最初の操作で自動的に登録されます。
        </div>
      ) : null}
      {inlineError ? (
        <div className="cron-controls__error" role="alert">
          {inlineError}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm?.kind === "toggle"}
        title={
          confirm?.kind === "toggle"
            ? confirm.nextEnabled
              ? `${presetName} を ON にする`
              : `${presetName} を OFF にする`
            : ""
        }
        description={
          <div className="confirm-body">
            <p className="confirm-body__lead">
              {confirm?.kind === "toggle" && confirm.nextEnabled
                ? "設定された時間に従って自動実行を再開します。"
                : "自動実行を停止します。実行中の処理は中断されません。"}
            </p>
            <dl className="kv">
              <dt>内容</dt>
              <dd>{presetLabel(presetName)}</dd>
              <dt>説明</dt>
              <dd>{description}</dd>
              <dt>実行タイミング</dt>
              <dd className="mono">{cron}</dd>
            </dl>
          </div>
        }
        confirmLabel={
          confirm?.kind === "toggle" && confirm.nextEnabled
            ? "ON にする"
            : "OFF にする"
        }
        confirmVariant="caution"
        busy={busyKind === "toggle"}
        onConfirm={() => {
          if (confirm?.kind === "toggle") {
            void performToggle(confirm.nextEnabled);
          }
        }}
        onClose={() => {
          if (busyKind !== null) return;
          setConfirm(null);
        }}
      />

      <ConfirmDialog
        open={confirm?.kind === "run"}
        title={`${presetName} を今すぐ実行する`}
        description={
          <div className="confirm-body">
            <p className="confirm-body__lead">
              この自動実行を 1 回だけ開始します。結果は実行履歴に残ります。
            </p>
            <dl className="kv">
              <dt>内容</dt>
              <dd>{presetLabel(presetName)}</dd>
              <dt>説明</dt>
              <dd>{description}</dd>
              <dt>注意点</dt>
              <dd>
                {presetName === "improvement_pr" ||
                presetName === "auto_creative_generation"
                  ? "改善案やクリエイティブ案がある場合は GitHub に承認待ちの変更が作成される可能性があります。"
                  : presetName === "daily_report" ||
                      presetName === "today_report"
                    ? "Meta の広告設定は変更されません。"
                    : presetName === "github_poll"
                      ? "承認済みの変更があれば反映待ちに進みます。"
                      : "古い履歴の整理を行います。"}
              </dd>
            </dl>
          </div>
        }
        confirmLabel="今すぐ実行する"
        confirmVariant="caution"
        busy={busyKind === "run"}
        onConfirm={() => void performRunNow()}
        onClose={() => {
          if (busyKind !== null) return;
          setConfirm(null);
        }}
      />
    </div>
  );
}

function presetLabel(name: string): string {
  const labels: Record<string, string> = {
    daily_report: "日次レポート",
    today_report: "当日レポート",
    improvement_pr: "改善提案",
    auto_creative_generation: "自動クリエイティブ生成",
    github_poll: "承認済み変更の確認",
    retention_sweep: "古い履歴の整理",
  };
  return labels[name] ?? name;
}

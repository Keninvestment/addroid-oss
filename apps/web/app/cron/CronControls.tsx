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
//   - run-now は ConfirmDialog (caution) で確認する — daily_report / improvement_pr /
//     budget_guard は AI コストや GitHub PR 作成といった副作用を伴うため。

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
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
          ? `pg-boss schedule に登録しました (${body.cron ?? cron}).`
          : "pg-boss schedule を解除しました。cron_schedules.enabled=false に更新しました。",
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
        title: `${presetName} の schedule を更新しました`,
        description: body.reschedulePending
          ? `${persistedCron} を保存しました。disabled のため pg-boss schedule は未登録です (有効化時に新 cron が反映されます).`
          : `${persistedCron} に再登録しました (pg-boss schedule)。`,
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
        title: `${presetName} を手動実行キューに積みました`,
        description: body.jobId
          ? `pg-boss job: ${body.jobId} — 実行は worker で処理されます。`
          : "pg-boss にジョブを送信しました (jobId 不明 — 重複抑止または worker 未起動)。",
      });
      setBusyKind(null);
      setConfirm(null);
      router.refresh();
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
              cron 編集
            </button>
            <button
              type="button"
              className="btn btn--caution btn--sm"
              onClick={openRunConfirm}
              disabled={busyKind !== null}
            >
              今すぐ実行
            </button>
          </>
        )}
      </div>
      {!persistedFromDb ? (
        <div className="cron-controls__hint">
          cron_schedules 行は未作成です。最初の操作で自動的に登録されます。
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
                ? "pg-boss schedule に登録し、cron 式に従って自動実行を再開します。"
                : "pg-boss schedule を解除し、自動実行を停止します。実行中のジョブは中断されません。"}
            </p>
            <dl className="kv">
              <dt>Preset</dt>
              <dd className="mono">{presetName}</dd>
              <dt>Description</dt>
              <dd>{description}</dd>
              <dt>Cron</dt>
              <dd className="mono">{cron}</dd>
              <dt>Audit</dt>
              <dd>
                <span className="mono">
                  cron.{confirm?.kind === "toggle" && confirm.nextEnabled
                    ? "enabled_via_web"
                    : "disabled_via_web"}
                </span>{" "}
                が <span className="mono">audit_logs</span> に記録されます。
              </dd>
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
              pg-boss にジョブを 1 件キューします。
              実行は worker プロセスで処理され、結果は{" "}
              <span className="mono">/cron/runs</span> と{" "}
              <span className="mono">execution_logs</span> に追記されます。
            </p>
            <dl className="kv">
              <dt>Preset</dt>
              <dd className="mono">{presetName}</dd>
              <dt>Description</dt>
              <dd>{description}</dd>
              <dt>Side effects</dt>
              <dd>
                {presetName === "improvement_pr"
                  ? "AI トークンが消費され、改善案がある場合は GitHub PR が作成される可能性があります。"
                  : presetName === "daily_report" ||
                      presetName === "budget_guard"
                    ? "AI トークンが消費されます。Meta は変更されません。"
                    : presetName === "github_poll"
                      ? "ops repo を polling し、merged PR があれば execute_apply を enqueue します。"
                      : "performance_snapshots の保持期間に基づいた削除が行われます。"}
              </dd>
              <dt>Audit</dt>
              <dd>
                <span className="mono">cron.manual_run_via_web</span> が{" "}
                <span className="mono">audit_logs</span> に記録されます。
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

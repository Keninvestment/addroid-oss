"use client";

import { useState } from "react";
import { useToast } from "../../components/ui/Toast";

export interface AgentTaskRow {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastState: string | null;
}

interface ApiResponse {
  ok?: boolean;
  error?: string;
}

export function AgentTaskForm({ tasks }: { tasks: AgentTaskRow[] }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [busy, setBusy] = useState<string | null>(null);

  async function createTask(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy("create");
    try {
      const res = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, cron }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.push({
        variant: "success",
        title: "自動実行を作成しました",
        description: `${cron} の予定で実行します。`,
      });
      setPrompt("");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      toast.push({
        variant: "error",
        title: "自動実行を作成できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(null);
    }
  }

  async function postAction(id: string, action: "run" | "toggle", enabled?: boolean) {
    if (busy) return;
    setBusy(`${action}:${id}`);
    try {
      const res = await fetch(`/api/agent-tasks/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "toggle" ? { enabled } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.push({
        variant: "success",
        title: action === "run" ? "自動実行を開始しました" : "自動実行を更新しました",
      });
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      toast.push({
        variant: "error",
        title: "自動実行の操作に失敗しました",
        description: (err as Error).message,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="agent-task">
      <form className="agent-task__form" onSubmit={createTask}>
        <div className="toolbar__field toolbar__field--grow">
          <label className="toolbar__label" htmlFor="agent-task-prompt">
            実行内容
          </label>
          <textarea
            id="agent-task-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例: 毎朝、日次レポートを取得して問題があれば改善提案も作って"
            rows={3}
            disabled={busy !== null}
          />
        </div>
        <div className="toolbar__field">
          <label className="toolbar__label" htmlFor="agent-task-cron">
            実行タイミング
          </label>
          <input
            id="agent-task-cron"
            className="form-input mono"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            disabled={busy !== null}
          />
        </div>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy !== null || !prompt.trim() || !cron.trim()}
        >
          {busy === "create" ? "作成中…" : "追加"}
        </button>
      </form>

      <div className="agent-task__list">
        {tasks.length === 0 ? (
          <div className="empty-state">
            <h3 className="empty-state__title">文章で追加した自動実行はまだありません。</h3>
            <p className="empty-state__body">
              やりたいことを文章で保存すると、実行時に必要な安全確認を行いながら処理します。
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="agent-task__row">
              <div className="agent-task__main">
                <div className="agent-task__title">{task.title}</div>
                <div className="agent-task__prompt">{task.prompt}</div>
                <div className="agent-task__meta">
                  <span className="mono">{task.cron}</span>
                  <span>{task.enabled ? "有効" : "停止中"}</span>
                  <span>次回: {task.nextRunAt ?? "—"}</span>
                  <span>前回: {task.lastState ?? "—"}</span>
                </div>
              </div>
              <div className="agent-task__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => postAction(task.id, "run")}
                  disabled={busy !== null}
                >
                  今すぐ実行
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${task.enabled ? "btn--caution" : "btn--primary"}`}
                  onClick={() => postAction(task.id, "toggle", !task.enabled)}
                  disabled={busy !== null}
                >
                  {task.enabled ? "OFF" : "ON"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

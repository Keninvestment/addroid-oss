"use client";

// AdDroid OSS — ops repository を手動で bootstrap し直すボタン。
// 通常は OAuth callback が auto-bootstrap するが、その時点で失敗した場合や
// adapter 設定が後追いで入った場合に再試行できるように the current implementation から導線を残す。

import { useState } from "react";

interface Props {
  label?: string;
  variant?: "primary" | "default";
}

export function BootstrapOpsRepoButton({ label = "変更管理リポジトリを準備", variant = "default" }: Props) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  async function onClick() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/github/bootstrap-ops-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        already?: boolean;
        owner?: string;
        name?: string;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        if (body.already && body.owner && body.name) {
          setFeedback({
            kind: "ok",
            message: `${body.owner}/${body.name} は既に準備済みです。`,
          });
        } else {
          setFeedback({
            kind: "error",
            message: body.error ?? `準備に失敗しました (HTTP ${res.status})。`,
          });
        }
      } else {
        setFeedback({
          kind: "ok",
          message: `${body.owner}/${body.name} を準備しました。ページを更新します…`,
        });
        setTimeout(() => window.location.reload(), 600);
      }
    } catch (err) {
      setFeedback({
        kind: "error",
        message: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={variant === "primary" ? "btn btn--primary" : "btn"}
      >
        {busy ? "準備中…" : label}
      </button>
      {feedback ? (
        <div className="banner" data-state={feedback.kind === "ok" ? "ok" : "error"}>
          <span className="banner__title">{feedback.kind === "ok" ? "成功" : "失敗"}</span>
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </div>
  );
}

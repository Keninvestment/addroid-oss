"use client";

// AdDroid OSS — Meta /me/businesses と /me/adaccounts を再取得するボタン。
// runtime cache をリフレッシュし、未登録の Meta Ad Account を ad_accounts に登録する。

import { useState } from "react";

interface Props {
  disabled?: boolean;
}

interface Feedback {
  variant: "success" | "error";
  message: string;
}

export function RefreshBusinessesButton({ disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function onClick() {
    if (busy || disabled) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/oauth/meta/refresh-businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        businesses?: number;
        adAccounts?: number;
        registered?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setFeedback({
          variant: "error",
          message: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setFeedback({
        variant: "success",
        message: `Business ${body.businesses ?? 0} 件 / 広告アカウント ${
          body.adAccounts ?? 0
        } 件を取得し、新規 ${body.registered ?? 0} 件を登録しました。`,
      });
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      setFeedback({ variant: "error", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        className="btn"
      >
        {busy ? "取得中…" : "Business を更新"}
      </button>
      {feedback ? (
        <div
          className="banner"
          data-state={feedback.variant === "success" ? "ok" : "error"}
          style={{ marginBottom: 0 }}
        >
          <span className="banner__title">
            {feedback.variant === "success" ? "更新しました" : "失敗しました"}
          </span>
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </div>
  );
}

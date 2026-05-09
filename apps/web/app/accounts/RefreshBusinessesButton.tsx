"use client";

// AdDroid OSS — Meta /me/businesses と /me/adaccounts を再取得するボタン。
// Business は補助情報。広告アカウント一覧が取れれば ad_accounts 同期は成功扱いにする。

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
        businessError?: string | null;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setFeedback({
          variant: "error",
          message: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const businessNote = body.businessError
        ? " Business 情報は取得できませんでしたが、広告アカウントは同期しました。"
        : "";
      setFeedback({
        variant: "success",
        message: `Business ${body.businesses ?? 0} 件 / 広告アカウント ${
          body.adAccounts ?? 0
        } 件を取得し、新規 ${body.registered ?? 0} 件を登録しました。${businessNote}`,
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
        {busy ? "取得中…" : "Meta一覧を更新"}
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

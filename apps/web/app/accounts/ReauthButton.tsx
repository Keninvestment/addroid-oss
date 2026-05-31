"use client";

// AdDroid OSS — Meta long-lived token を再認証 (再交換) するボタン。
// 失敗時は再認証フロー (Connect Meta) への誘導を表示する。

import { useState } from "react";

interface Props {
  expired: boolean;
  expiringSoon: boolean;
  oauthRefreshAvailable?: boolean;
}

interface Feedback {
  variant: "success" | "warn" | "error";
  message: string;
  reauthRequired?: boolean;
}

export function ReauthButton({ expired, expiringSoon, oauthRefreshAvailable = true }: Props) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/oauth/meta/refresh", {
        method: "POST",
        headers: { "X-AdDroid-Web-Action": "1" },
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        refreshedAt?: string;
        expiresAt?: string | null;
      };
      if (!res.ok || !body.ok) {
        setFeedback({
          variant: res.status === 401 ? "warn" : "error",
          message:
            body.error ??
            `再認証に失敗しました (HTTP ${res.status})。Meta接続をやり直してください。`,
          reauthRequired: res.status === 401,
        });
      } else {
        setFeedback({
          variant: "success",
          message: `Meta接続を更新しました。期限 = ${
            body.expiresAt ?? "(未取得)"
          }`,
        });
        setTimeout(() => window.location.reload(), 600);
      }
    } catch (err) {
      setFeedback({ variant: "error", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!oauthRefreshAvailable) {
    return (
      <div className="banner" data-state={expired ? "error" : expiringSoon ? "warn" : "ok"}>
        <span className="banner__title">
          {expired ? "Meta 接続の再入力が必要です" : "手動接続"}
        </span>
        <span>
          手動接続方式では画面から更新できません。更新する場合は{" "}
          <code className="inline-code">addroid connect meta</code> を再実行してください。
        </span>
      </div>
    );
  }

  const variant = expired || feedback?.variant === "error" ? "primary" : "default";
  const label = expired
    ? "Meta 接続が期限切れ — 再認証する"
    : expiringSoon
      ? "Meta 接続の有効期限が近い — 再認証する"
      : "Meta 接続を再認証する";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          className={variant === "primary" ? "btn btn--primary" : "btn"}
        >
          {busy ? "再認証中…" : label}
        </button>
        {feedback?.reauthRequired ? (
          <a className="btn btn--primary" href="/api/oauth/meta/begin">
            Meta と再接続
          </a>
        ) : null}
      </div>
      {feedback ? (
        <div
          className="banner"
          data-state={
            feedback.variant === "success"
              ? "ok"
              : feedback.variant === "warn"
                ? "warn"
                : "error"
          }
        >
          <span className="banner__title">
            {feedback.variant === "success" ? "更新しました" : "再認証が必要です"}
          </span>
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </div>
  );
}

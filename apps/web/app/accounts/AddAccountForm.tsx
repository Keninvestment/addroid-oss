"use client";

// AdDroid OSS — Meta から取得できる Ad Account 一覧を同期し、選択して既定にする。

import { useState } from "react";
import { BusyLabel } from "../../components/ui/AsyncFeedback";

interface AccountRow {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
  businessName: string | null;
  currency: string | null;
  timezoneName: string | null;
}

interface SyncResponse {
  ok?: boolean;
  businesses?: number;
  adAccounts?: number;
  registered?: number;
  updated?: number;
  businessError?: string | null;
  accountRows?: AccountRow[];
  error?: string;
}

interface DefaultResponse {
  ok?: boolean;
  error?: string;
  account?: { displayName?: string; metaAccountId?: string | null };
}

type BusyState = "sync" | `select:${string}` | null;

export function AddAccountForm() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [feedback, setFeedback] = useState<{
    variant: "success" | "error";
    message: string;
  } | null>(null);

  async function syncAccounts() {
    if (busy) return;
    setBusy("sync");
    setFeedback(null);
    try {
      const res = await fetch("/api/oauth/meta/refresh-businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as SyncResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const rows = body.accountRows ?? [];
      setAccounts(rows);
      setFeedback({
        variant: "success",
        message: `広告アカウント ${body.adAccounts ?? rows.length} 件を取得しました。新規 ${
          body.registered ?? 0
        } 件 / 更新 ${body.updated ?? 0} 件。`,
      });
    } catch (err) {
      setAccounts([]);
      setFeedback({ variant: "error", message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function selectDefault(id: string) {
    if (busy) return;
    setBusy(`select:${id}`);
    setFeedback(null);
    try {
      const res = await fetch("/api/accounts/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adAccountId: id }),
      });
      const body = (await res.json().catch(() => ({}))) as DefaultResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const label = body.account?.metaAccountId ?? body.account?.displayName ?? id;
      setFeedback({
        variant: "success",
        message: `既定の広告アカウントを ${label} にしました。`,
      });
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      setFeedback({ variant: "error", message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void syncAccounts();
        }}
        className="btn"
        aria-haspopup="dialog"
      >
        Metaから選択
      </button>
    );
  }

  return (
    <div
      className="add-account-form"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-3)",
        border: "1px solid var(--color-border-default)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-bg-subtle)",
        minWidth: "min(42rem, calc(100vw - 3rem))",
      }}
    >
      <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
          閉じる
        </button>
        <button type="button" className="btn" onClick={syncAccounts} disabled={busy !== null}>
          {busy === "sync" ? <BusyLabel>取得中</BusyLabel> : "再取得"}
        </button>
      </div>

      {feedback ? (
        <div className="banner" data-state={feedback.variant === "success" ? "ok" : "error"}>
          <span className="banner__title">
            {feedback.variant === "success" ? "取得しました" : "取得に失敗"}
          </span>
          <span>{feedback.message}</span>
        </div>
      ) : null}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <h3 className="empty-state__title">
            {busy === "sync" ? "Metaから広告アカウントを取得しています。" : "選択できる広告アカウントはありません。"}
          </h3>
          <p className="empty-state__body">
            {busy === "sync"
              ? "取得が完了すると、ここに選択肢が表示されます。"
              : "Meta接続と広告アカウントの割り当てを確認してください。"}
          </p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">アカウント</th>
              <th scope="col">Business</th>
              <th scope="col">通貨 / TZ</th>
              <th scope="col" style={{ width: "8rem" }}>
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const selecting = busy === `select:${account.id}`;
              return (
                <tr key={account.id}>
                  <td>
                    <div style={{ display: "grid", gap: "0.15rem" }}>
                      <span>{account.displayName || account.metaAccountId || account.key}</span>
                      <span className="mono" style={{ color: "var(--color-text-secondary)" }}>
                        {account.metaAccountId ?? account.key}
                      </span>
                    </div>
                  </td>
                  <td>{account.businessName ?? "—"}</td>
                  <td className="mono">
                    {[account.currency, account.timezoneName].filter(Boolean).join(" / ") || "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => selectDefault(account.id)}
                      disabled={busy !== null}
                    >
                      {selecting ? <BusyLabel>設定中</BusyLabel> : "選択"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

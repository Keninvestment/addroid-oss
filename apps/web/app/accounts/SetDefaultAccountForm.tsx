"use client";

// AdDroid OSS — 登録済み Ad Account をテーブル表示し、radio でデフォルトを切替える。
// 単一選択で、選択を変えた瞬間に Server に POST して Workspace.defaultAdAccountId を更新する。

import { useState, useTransition } from "react";

interface AccountRow {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
}

interface Props {
  accounts: AccountRow[];
  defaultAdAccountId: string | null;
}

interface Toast {
  variant: "success" | "error";
  message: string;
}

export function SetDefaultAccountForm({ accounts, defaultAdAccountId }: Props) {
  const [selected, setSelected] = useState<string | null>(defaultAdAccountId);
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<Toast | null>(null);

  async function setDefault(id: string) {
    if (id === selected) return;
    setSelected(id);
    setToast(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/accounts/default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adAccountId: id }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          account?: { displayName?: string; metaAccountId?: string | null };
        };
        if (!res.ok || !body.ok) {
          setToast({
            variant: "error",
            message: body.error ?? `HTTP ${res.status}`,
          });
          // ロールバック表示
          setSelected(defaultAdAccountId);
          return;
        }
        const label = body.account?.metaAccountId ?? body.account?.displayName ?? id;
        setToast({
          variant: "success",
          message: `デフォルトアカウントを ${label} に変更しました。`,
        });
      } catch (err) {
        setToast({ variant: "error", message: (err as Error).message });
        setSelected(defaultAdAccountId);
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col" style={{ width: "3rem" }}>
              既定
            </th>
            <th scope="col">key</th>
            <th scope="col">displayName</th>
            <th scope="col">metaAccountId</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td>
                <input
                  type="radio"
                  name="default-ad-account"
                  value={a.id}
                  checked={selected === a.id}
                  disabled={pending}
                  onChange={() => setDefault(a.id)}
                  aria-label={`デフォルトを ${a.displayName} にする`}
                />
              </td>
              <td className="mono">{a.key}</td>
              <td>{a.displayName}</td>
              <td className="mono">{a.metaAccountId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {toast ? (
        <div className="banner" data-state={toast.variant === "success" ? "ok" : "error"}>
          <span className="banner__title">
            {toast.variant === "success" ? "更新しました" : "更新に失敗"}
          </span>
          <span>{toast.message}</span>
        </div>
      ) : null}
    </div>
  );
}

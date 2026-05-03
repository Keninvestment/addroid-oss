"use client";

// AdDroid OSS — Ad Account を手動登録するためのインライン form。
// PageHeader の actions 領域 / Panel の status 領域に置けるよう button + 折り畳み form 形式。

import { useState } from "react";

interface State {
  key: string;
  displayName: string;
  metaAccountId: string;
  saving: boolean;
  error: string | null;
}

const empty: State = {
  key: "",
  displayName: "",
  metaAccountId: "",
  saving: false,
  error: null,
};

export function AddAccountForm() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>(empty);

  function patch(p: Partial<State>) {
    setState((s) => ({ ...s, ...p }));
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (state.saving) return;
    patch({ saving: true, error: null });
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: state.key,
          displayName: state.displayName,
          metaAccountId: state.metaAccountId || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        patch({ saving: false, error: body.error ?? `HTTP ${res.status}` });
        return;
      }
      setState(empty);
      setOpen(false);
      window.location.reload();
    } catch (err) {
      patch({ saving: false, error: (err as Error).message });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn"
        aria-haspopup="dialog"
      >
        + Add account
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="add-account-form"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-3)",
        border: "1px solid var(--color-border-default)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-bg-subtle)",
        minWidth: "20rem",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <label style={{ fontSize: "var(--size-xs)", fontWeight: 600 }}>
          key (例: <code className="inline-code">brand-a</code>)
        </label>
        <input
          required
          value={state.key}
          onChange={(e) => patch({ key: e.target.value })}
          className="form-input"
          pattern="[a-zA-Z0-9._\-]{1,64}"
          style={inputStyle}
          autoFocus
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <label style={{ fontSize: "var(--size-xs)", fontWeight: 600 }}>displayName</label>
        <input
          required
          value={state.displayName}
          onChange={(e) => patch({ displayName: e.target.value })}
          className="form-input"
          style={inputStyle}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <label style={{ fontSize: "var(--size-xs)", fontWeight: 600 }}>
          metaAccountId (省略可、形式: <code className="inline-code">act_1234567890</code>)
        </label>
        <input
          value={state.metaAccountId}
          onChange={(e) => patch({ metaAccountId: e.target.value })}
          className="form-input"
          pattern="act_\d{1,32}"
          placeholder="act_1234567890"
          style={inputStyle}
        />
      </div>
      {state.error ? (
        <div className="banner" data-state="error">
          <span className="banner__title">登録に失敗しました</span>
          <span>{state.error}</span>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setState(empty);
          }}
          className="btn"
          disabled={state.saving}
        >
          キャンセル
        </button>
        <button type="submit" className="btn btn--primary" disabled={state.saving}>
          {state.saving ? "登録中…" : "登録"}
        </button>
      </div>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--size-sm)",
  padding: "6px 10px",
  border: "1px solid var(--color-border-default)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg-surface)",
  color: "var(--color-text-primary)",
};

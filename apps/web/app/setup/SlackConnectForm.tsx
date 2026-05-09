"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "../../components/ui/Toast";

interface ApiResponse {
  ok?: boolean;
  error?: string;
  teamName?: string;
  removed?: number;
}

export function SlackConnectForm() {
  const router = useRouter();
  const toast = useToast();
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [sendTestMessage, setSendTestMessage] = useState(false);
  const [busy, setBusy] = useState(false);

  async function connect(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/slack/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken, appToken, channelId, sendTestMessage }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      setBotToken("");
      setAppToken("");
      toast.push({
        variant: "success",
        title: "Slack を接続しました",
        description: body.teamName ? `${body.teamName} に保存しました。` : "接続情報を暗号化して保存しました。",
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "Slack を接続できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/slack/connect", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.push({
        variant: "success",
        title: "Slack を切断しました",
        description: `${body.removed ?? 0} 件の credential を削除しました。`,
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "Slack を切断できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="toolbar" onSubmit={connect} aria-label="Slack 接続">
      <div className="toolbar__field" style={{ minWidth: "16rem" }}>
        <label className="toolbar__label" htmlFor="slack-bot-token">
          Bot token (xoxb-)
        </label>
        <input
          id="slack-bot-token"
          className="form-input"
          type="password"
          autoComplete="off"
          value={botToken}
          onChange={(ev) => setBotToken(ev.target.value)}
          disabled={busy}
          placeholder="xoxb-..."
        />
      </div>
      <div className="toolbar__field" style={{ minWidth: "16rem" }}>
        <label className="toolbar__label" htmlFor="slack-app-token">
          App token (xapp-)
        </label>
        <input
          id="slack-app-token"
          className="form-input"
          type="password"
          autoComplete="off"
          value={appToken}
          onChange={(ev) => setAppToken(ev.target.value)}
          disabled={busy}
          placeholder="xapp-..."
        />
      </div>
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="slack-channel">
          通知先チャンネルID
        </label>
        <input
          id="slack-channel"
          className="form-input"
          value={channelId}
          onChange={(ev) => setChannelId(ev.target.value)}
          disabled={busy}
          placeholder="C012ABCDEF"
        />
      </div>
      <label className="toolbar__field" style={{ gap: "0.5rem" }}>
        <span className="toolbar__label">Test</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <input
            type="checkbox"
            checked={sendTestMessage}
            onChange={(ev) => setSendTestMessage(ev.target.checked)}
            disabled={busy}
          />
          送信する
        </span>
      </label>
      <button
        type="submit"
        className="btn btn--primary btn--sm"
        disabled={busy || !botToken.trim() || !appToken.trim() || !channelId.trim()}
      >
        {busy ? "保存中…" : "接続"}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={disconnect} disabled={busy}>
        切断
      </button>
    </form>
  );
}

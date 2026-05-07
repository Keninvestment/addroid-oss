"use client";

import { useMemo, useState } from "react";
import { useToast } from "../components/ui/Toast";

const SLASH_COMMANDS = [
  { command: "/status", text: "接続・起動状態を確認" },
  { command: "/report", text: "日次レポートを取得" },
  { command: "/submit", text: "入稿前チェックを実行" },
  { command: "/connect", text: "接続画面を案内" },
  { command: "/account", text: "広告アカウントを確認" },
  { command: "/schedule", text: "自動実行を確認・変更" },
  { command: "/open", text: "Web UI の URL を表示" },
] as const;

interface ApiExecution {
  display: string;
  status: "ok" | "error" | "denied" | "unsupported";
  message: string;
}

interface ApiResponse {
  ok?: boolean;
  message?: string;
  executions?: ApiExecution[];
  error?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  executions?: ApiExecution[];
}

export function DashboardChatPanel() {
  const toast = useToast();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  const suggestions = useMemo(() => {
    if (!input.startsWith("/") || /\s/.test(input)) return [];
    const needle = input.trim().toLowerCase();
    if (needle === "/") return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter((item) => item.command.startsWith(needle));
  }, [input]);

  async function submit(ev?: React.FormEvent) {
    ev?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", text },
    ]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: slashToNaturalText(text) }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      const executions = body.executions ?? [];
      const error = body.error ?? (!res.ok ? `HTTP ${res.status}` : "");
      const reply =
        body.message ||
        (error
          ? `実行できませんでした: ${error}`
          : executions.length
            ? "実行しました。"
            : "回答はありません。");
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          text: reply,
          executions,
        },
      ]);
      if (!res.ok || error || executions.some((e) => e.status === "error")) {
        toast.push({
          variant: "error",
          title: "Agent chat failed",
          description: error || executions.find((e) => e.status === "error")?.message,
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: "assistant", text: `実行できませんでした: ${message}` },
      ]);
      toast.push({ variant: "error", title: "Agent chat failed", description: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-chat" aria-label="AdDroid agent chat">
      <div className="agent-chat__head">
        <div>
          <h2>AdDroid Chat</h2>
          <p>自然言語でレポート取得、入稿前チェック、schedule 操作を実行します。</p>
        </div>
        <span className="agent-chat__badge">LLM Agent</span>
      </div>
      <div className="agent-chat__messages">
        {messages.length === 0 ? (
          <div className="agent-chat__empty">
            「日次レポートを取得」「入稿前チェック」「budget_guard を ON にして」などを入力できます。
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className="agent-chat__message"
              data-role={message.role}
            >
              <div className="agent-chat__bubble">
                <div>{message.text}</div>
                {message.executions?.length ? (
                  <div className="agent-chat__executions">
                    {message.executions.map((execution, i) => (
                      <div
                        key={`${message.id}-${i}`}
                        className="agent-chat__execution"
                        data-status={execution.status}
                      >
                        <span>{execution.display}</span>
                        <span>{execution.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      <form className="agent-chat__form" onSubmit={submit}>
        <div className="agent-chat__input-wrap">
          {suggestions.length ? (
            <div className="agent-chat__suggestions">
              {suggestions.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  onClick={() => setInput(item.command)}
                >
                  <span>{item.command}</span>
                  <span>{item.text}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="例: 日次レポートを取得して"
            rows={2}
            disabled={busy}
          />
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy || !input.trim()}>
          {busy ? "実行中…" : "送信"}
        </button>
      </form>
    </section>
  );
}

function slashToNaturalText(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/status") return "ステータスを確認して";
  if (trimmed === "/report") return "日次レポートを取得して";
  if (trimmed === "/submit") return "入稿前チェックを実行して";
  if (trimmed === "/connect") return "接続状態を確認して必要な接続画面を案内して";
  if (trimmed === "/account") return "広告アカウント一覧を確認して";
  if (trimmed === "/schedule") return "schedule 一覧を確認して";
  if (trimmed === "/open") return "Web UI の URL を表示して";
  return value;
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

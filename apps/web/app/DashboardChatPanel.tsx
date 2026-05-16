"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusyLabel, LoadingDots } from "../components/ui/AsyncFeedback";
import { useToast } from "../components/ui/Toast";

const EXAMPLES = [
  "日次レポートを取得して",
  "入稿前チェックを実行して",
  "Meta広告アカウントを同期して",
  "バックアップを作成して",
  "広告アカウントの状態を確認して",
  "毎朝9時に日次レポートを送る設定にして",
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
  sessionId?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  executions?: ApiExecution[];
}

interface ChatSessionSummary {
  id: string;
  surface: string;
  title: string;
  lastMessage: string;
  turnCount: number;
  updatedAt: string;
}

interface DashboardChatPanelProps {
  title?: string;
  description?: string;
  emptyText?: string;
  badge?: string;
  examples?: readonly string[];
  placeholder?: string;
  contextPrefix?: string;
  allowAttachments?: boolean;
  initialInput?: string;
  surface?: string;
}

export function DashboardChatPanel({
  title = "やりたいことを入力",
  description = "レポート取得、入稿前チェック、アカウント同期、バックアップ、自動実行の設定を文章で依頼できます。",
  emptyText = "「日次レポートを取得」「入稿前チェック」「Meta広告アカウントを同期」「予算チェックを有効にして」などを入力できます。",
  badge = "安全確認つき",
  examples = EXAMPLES,
  placeholder = "例: 日次レポートを取得して",
  contextPrefix,
  allowAttachments = false,
  initialInput,
  surface = "dashboard",
}: DashboardChatPanelProps) {
  const toast = useToast();
  const [input, setInput] = useState(initialInput ?? "");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [sessionId, setSessionId] = useState(() => readOrCreateSessionId(surface));
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const composingRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  const latestMessageRef = useRef<HTMLDivElement | null>(null);
  const initialSessionLoadedRef = useRef(false);

  const suggestions = useMemo(() => {
    const needle = input.trim();
    if (busy || messages.length > 0) return [];
    if (needle.length > 0) return [];
    return [...examples];
  }, [busy, examples, input, messages.length]);

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/chat?limit=30");
    const body = (await res.json().catch(() => ({}))) as { sessions?: ChatSessionSummary[] };
    setSessions(body.sessions ?? []);
  }, []);

  const loadSession = useCallback(
    async (nextSessionId: string, options?: { force?: boolean }) => {
      if (!nextSessionId || (!options?.force && nextSessionId === sessionId)) return;
      const res = await fetch(`/api/chat?sessionId=${encodeURIComponent(nextSessionId)}`);
      const body = (await res.json().catch(() => ({}))) as {
        messages?: Array<Message & { createdAt?: string }>;
        error?: string;
      };
      if (!res.ok || body.error) {
        toast.push({
          variant: "error",
          title: "会話履歴を開けません",
          description: body.error,
        });
        return;
      }
      setSessionId(nextSessionId);
      window.localStorage.setItem(storageKey(surface), nextSessionId);
      setMessages(
        (body.messages ?? []).map((message) => ({
          id: message.id || makeId(),
          role: message.role,
          text: message.text,
          executions: message.executions,
        }))
      );
    },
    [sessionId, surface, toast]
  );

  useEffect(() => {
    if (initialSessionLoadedRef.current || !sessionId) return;
    initialSessionLoadedRef.current = true;
    void refreshSessions();
    void loadSession(sessionId, { force: true });
  }, [loadSession, refreshSessions, sessionId]);

  useEffect(() => {
    const target = latestMessageRef.current;
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      target.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, messages.length]);

  async function submit(ev?: React.FormEvent) {
    ev?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setFiles([]);
    setBusy(true);
    const fileSummary = files.length > 0 ? `\n添付: ${files.map((f) => f.name).join(", ")}` : "";
    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", text: `${text}${fileSummary}` },
    ]);
    try {
      const res = await sendChatRequest({
        input: text,
        contextPrefix,
        files,
        sessionId,
        surface,
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
      if (body.sessionId && body.sessionId !== sessionId) {
        setSessionId(body.sessionId);
        window.localStorage.setItem(storageKey(surface), body.sessionId);
      }
      void refreshSessions();
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
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="agent-chat__actions">
          <select
            aria-label="会話履歴"
            value={sessionId}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "__new__") {
                const next = makeId();
                setSessionId(next);
                setMessages([]);
                window.localStorage.setItem(storageKey(surface), next);
                return;
              }
              void loadSession(value);
            }}
            disabled={busy || !sessionId}
          >
            <option value={sessionId}>{messages.length ? "現在の会話" : "新しい会話"}</option>
            <option value="__new__">新しい会話を開始</option>
            {sessions
              .filter((session) => session.id !== sessionId)
              .map((session) => (
                <option key={session.id} value={session.id}>
                  {session.surface === surface ? session.title : `[${session.surface}] ${session.title}`}
                </option>
              ))}
          </select>
          <span className="agent-chat__badge">{badge}</span>
        </div>
      </div>
      <div className="agent-chat__messages" aria-busy={busy}>
        {messages.length === 0 ? (
          <div className="agent-chat__empty">
            {emptyText}
          </div>
        ) : (
          <>
            {messages.map((message, index) => (
              <div
                key={message.id}
                ref={index === messages.length - 1 && !busy ? latestMessageRef : undefined}
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
            ))}
            {busy ? (
              <div
                ref={latestMessageRef}
                className="agent-chat__message agent-chat__message--typing"
                data-role="assistant"
                aria-live="polite"
              >
                <div className="agent-chat__bubble agent-chat__typing">
                  <LoadingDots label="応答を作成中" />
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
      <form className="agent-chat__form" onSubmit={submit}>
        <div className="agent-chat__input-wrap">
          {suggestions.length ? (
            <div className="agent-chat__suggestions">
              {suggestions.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setInput(item)}
                  disabled={busy}
                >
                  <span>{item}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              suppressNextEnterRef.current = true;
              window.setTimeout(() => {
                suppressNextEnterRef.current = false;
              }, 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if (
                  composingRef.current ||
                  suppressNextEnterRef.current ||
                  isComposingKeyEvent(e.nativeEvent)
                ) {
                  e.preventDefault();
                  suppressNextEnterRef.current = false;
                  return;
                }
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            rows={2}
            disabled={busy}
          />
          {allowAttachments ? (
            <div className="agent-chat__attachments">
              <label>
                <span>素材・参考画像を添付</span>
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  disabled={busy}
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                />
              </label>
              {files.length > 0 ? (
                <div className="agent-chat__attachment-list">
                  {files.map((file) => (
                    <span key={`${file.name}-${file.size}`}>{file.name}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !input.trim()}
          aria-busy={busy}
        >
          {busy ? <BusyLabel>実行中</BusyLabel> : "送信"}
        </button>
      </form>
    </section>
  );
}

function isComposingKeyEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

async function sendChatRequest(input: {
  input: string;
  contextPrefix?: string;
  files: File[];
  sessionId: string;
  surface: string;
}): Promise<Response> {
  if (input.files.length > 0 || input.contextPrefix) {
    const form = new FormData();
    form.set("input", input.input);
    form.set("sessionId", input.sessionId);
    form.set("surface", input.surface);
    if (input.contextPrefix) form.set("contextPrefix", input.contextPrefix);
    for (const file of input.files) form.append("files", file);
    return fetch("/api/chat", { method: "POST", body: form });
  }
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: input.input,
      sessionId: input.sessionId,
      surface: input.surface,
    }),
  });
}

function storageKey(surface: string): string {
  return `addroid.chat.session.${surface}`;
}

function readOrCreateSessionId(surface: string): string {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem(storageKey(surface));
  if (stored) return stored;
  const next = makeId();
  window.localStorage.setItem(storageKey(surface), next);
  return next;
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BusyLabel, LoadingDots } from "../components/ui/AsyncFeedback";
import { useI18n } from "../components/I18nProvider";
import { useToast } from "../components/ui/Toast";

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
  startNewSession?: boolean;
  sessionResetKey?: string;
  refreshOnSuccess?: boolean;
}

export function DashboardChatPanel({
  title,
  description,
  emptyText,
  badge,
  examples,
  placeholder,
  contextPrefix,
  allowAttachments = false,
  initialInput,
  surface = "dashboard",
  startNewSession = true,
  sessionResetKey = "",
  refreshOnSuccess = false,
}: DashboardChatPanelProps) {
  const { literal, t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const effectiveTitle = title ? literal(title) : t("chat.title");
  const effectiveDescription = description ? literal(description) : t("chat.description");
  const effectiveEmptyText = emptyText ? literal(emptyText) : t("chat.empty");
  const effectiveBadge = badge ? literal(badge) : t("chat.badge");
  const effectivePlaceholder = placeholder ? literal(placeholder) : t("chat.placeholder");
  const effectiveExamples =
    examples?.map((item) => literal(item)) ?? [
      t("chat.example.daily"),
      t("chat.example.submit"),
      t("chat.example.sync"),
      t("chat.example.backup"),
      t("chat.example.status"),
      t("chat.example.schedule"),
    ];
  const [input, setInput] = useState(initialInput ?? "");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const composingRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  const latestMessageRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef("");

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const suggestions = useMemo(() => {
    const needle = input.trim();
    if (busy || messages.length > 0) return [];
    if (needle.length > 0) return [];
    return [...effectiveExamples];
  }, [busy, effectiveExamples, input, messages.length]);

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/chat?limit=30");
    const body = (await res.json().catch(() => ({}))) as { sessions?: ChatSessionSummary[] };
    setSessions(body.sessions ?? []);
  }, []);

  const loadSession = useCallback(
    async (nextSessionId: string, options?: { force?: boolean }) => {
      if (!nextSessionId || (!options?.force && nextSessionId === sessionIdRef.current)) return;
      const res = await fetch(`/api/chat?sessionId=${encodeURIComponent(nextSessionId)}`);
      const body = (await res.json().catch(() => ({}))) as {
        messages?: Array<Message & { createdAt?: string }>;
        error?: string;
      };
      if (!res.ok || body.error) {
        toast.push({ variant: "error", title: t("chat.history.openFailed"), description: body.error });
        return;
      }
      sessionIdRef.current = nextSessionId;
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
    [surface, toast]
  );

  useEffect(() => {
    let cancelled = false;
    const nextSessionId = startNewSession ? makeId() : readOrCreateSessionId(surface);
    sessionIdRef.current = nextSessionId;
    window.localStorage.setItem(storageKey(surface), nextSessionId);
    window.queueMicrotask(() => {
      if (cancelled) return;
      setSessionId(nextSessionId);
      setMessages([]);
      setFiles([]);
      setInput(initialInput ?? "");
    });
    window.queueMicrotask(() => {
      if (cancelled) return;
      void refreshSessions();
      if (!startNewSession) void loadSession(nextSessionId, { force: true });
    });
    return () => {
      cancelled = true;
    };
  }, [
    initialInput,
    loadSession,
    refreshSessions,
    sessionResetKey,
    startNewSession,
    surface,
  ]);

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
    const activeSessionId = sessionIdRef.current || sessionId;
    const fileSummary =
      files.length > 0 ? `\n${t("chat.attachmentPrefix")} ${files.map((f) => f.name).join(", ")}` : "";
    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", text: `${text}${fileSummary}` },
    ]);
    try {
      const res = await sendChatRequest({
        input: text,
        contextPrefix,
        files,
        sessionId: activeSessionId,
        surface,
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      const executions = body.executions ?? [];
      const error = body.error ?? (!res.ok ? `HTTP ${res.status}` : "");
      const reply =
        body.message ||
        (error
          ? t("chat.failed", { error })
          : executions.length
            ? t("chat.done")
            : t("chat.noAnswer"));
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
        sessionIdRef.current = body.sessionId;
        setSessionId(body.sessionId);
        window.localStorage.setItem(storageKey(surface), body.sessionId);
      }
      if (refreshOnSuccess && body.ok && executions.some((e) => e.status === "ok")) {
        router.refresh();
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
        { id: makeId(), role: "assistant", text: t("chat.failed", { error: message }) },
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
          <h2>{effectiveTitle}</h2>
          <p>{effectiveDescription}</p>
        </div>
        <div className="agent-chat__actions">
          <select
            aria-label={t("chat.history")}
            value={sessionId}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "__new__") {
                const next = makeId();
                sessionIdRef.current = next;
                setSessionId(next);
                setMessages([]);
                window.localStorage.setItem(storageKey(surface), next);
                return;
              }
              void loadSession(value);
            }}
            disabled={busy || !sessionId}
          >
            <option value={sessionId}>
              {messages.length ? t("chat.current") : t("chat.new")}
            </option>
            <option value="__new__">{t("chat.startNew")}</option>
            {sessions
              .filter((session) => session.id !== sessionId)
              .map((session) => (
                <option key={session.id} value={session.id}>
                  {session.surface === surface ? session.title : `[${session.surface}] ${session.title}`}
                </option>
              ))}
          </select>
          <span className="agent-chat__badge">{effectiveBadge}</span>
        </div>
      </div>
      <div className="agent-chat__messages" aria-busy={busy}>
        {messages.length === 0 ? (
          <div className="agent-chat__empty">
            {effectiveEmptyText}
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
                  <LoadingDots label={t("chat.thinking")} />
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
            placeholder={effectivePlaceholder}
            rows={2}
            disabled={busy}
          />
          {allowAttachments ? (
            <div className="agent-chat__attachments">
              <label>
                <span>{t("chat.attach")}</span>
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
          {busy ? <BusyLabel>{t("chat.running")}</BusyLabel> : t("chat.send")}
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
    return fetch("/api/chat", {
      method: "POST",
      headers: { "X-AdDroid-Web-Action": "1" },
      body: form,
    });
  }
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AdDroid-Web-Action": "1" },
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

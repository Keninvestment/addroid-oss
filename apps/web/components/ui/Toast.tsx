"use client";

// AdDroid OSS — Toast primitive (★A, the current implementation で初出).
//
// 書き込み操作 (Activate / Apply / OAuth / 再認証 等) の成功・失敗フィードバックを
// 画面右上に短時間表示する。Unified feedback pattern (CLAUDE.md guardrail #3) に従い、
// 親ページ側で Toast を使う。
//
// 使い方:
//   const { push } = useToast();
//   push({ variant: "success", title: "ACTIVE にしました", description: "act_xxx の <name>" });
//
// Provider はルートレイアウトで一度だけ宣言する。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

export type ToastVariant = "success" | "error" | "info";

export interface ToastInput {
  variant: ToastVariant;
  title: string;
  description?: string;
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: string;
}

interface ToastContextValue {
  push: (toast: ToastInput) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const toast: Toast = { id, ...input };
      setToasts((prev) => [...prev, toast]);
      const duration = input.durationMs ?? (input.variant === "error" ? 8000 : 4000);
      const handle = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, handle);
    },
    [dismiss]
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((handle) => clearTimeout(handle));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toast-region"
        role="region"
        aria-label="通知"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast"
            data-variant={toast.variant}
            role={toast.variant === "error" ? "alert" : "status"}
          >
            <div className="toast__title">{toast.title}</div>
            {toast.description ? (
              <div className="toast__body">{toast.description}</div>
            ) : null}
            <button
              type="button"
              className="toast__dismiss"
              aria-label="通知を閉じる"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

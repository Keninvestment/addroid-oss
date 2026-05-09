"use client";

// AdDroid OSS — ConfirmDialog primitive (★B, UI plan §4.3).
//
// 不可逆 / 副作用のある操作の前に出す確認モーダル。
// 仕様 (UI plan §9):
//   - role="dialog" + aria-modal="true" + aria-labelledby + aria-describedby
//   - focus trap + ESC でキャンセル + overlay クリックでキャンセル
//   - 初期 focus は cancel ボタン (誤操作防止)
//   - 閉じたら trigger 要素に focus を戻す
//   - confirmVariant: primary | caution | danger
//
// 利用側は open/onClose を制御。confirm 中は busy=true を渡してダブルクリックを防ぐ。

import { useCallback, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { BusyLabel } from "./AsyncFeedback";

export type ConfirmVariant = "primary" | "caution" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ConfirmVariant;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "キャンセル",
  confirmVariant = "primary",
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const handleClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  // open 時に trigger を覚えて、cancel に初期 focus、focus trap、ESC、戻り focus を設定。
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // 次フレームで cancel に focus (描画後に確実に当てる)。
    const id = window.requestAnimationFrame(() => {
      cancelRef.current?.focus();
    });

    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        handleClose();
        return;
      }
      if (ev.key === "Tab" && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("data-focus-skip"));
        if (focusables.length === 0) {
          ev.preventDefault();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (ev.shiftKey) {
          if (active === first || !dialogRef.current.contains(active)) {
            ev.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            ev.preventDefault();
            first.focus();
          }
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // モーダルを閉じたら trigger に focus を戻す。
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(ev) => {
        // overlay 自身のクリックでのみキャンセル (ダイアログ内クリックは無視)。
        if (ev.target === ev.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="modal"
      >
        <header className="modal__head">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
        </header>
        <div id={descriptionId} className="modal__body">
          {description}
        </div>
        <div className="modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={handleClose}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn btn--${confirmVariant}`}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? <BusyLabel>実行中</BusyLabel> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

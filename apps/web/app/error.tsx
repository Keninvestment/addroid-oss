"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // ローカル開発時の調査用にコンソール出力。Cloud のような外部 sink には送らない。
    console.error("[addroid/web] route error:", error);
  }, [error]);

  return (
    <div className="empty-state">
      <h3 className="empty-state__title">表示中にエラーが発生しました。</h3>
      <p className="empty-state__body">{error.message}</p>
      <button type="button" onClick={() => reset()} className="status-badge" data-state="info">
        再試行
      </button>
    </div>
  );
}

"use client";

// AdDroid OSS — Web UI Merge button (this implementation).
//
// ConfirmDialog (caution) を経由して /api/approvals/[prNumber]/merge を叩く。
// 成功・失敗どちらも Toast でフィードバック (Unified Feedback)。
// 失敗してもダイアログを自動で閉じない (operator がエラーをコピーできるように)。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { useToast } from "../../../components/ui/Toast";
import { InlineCode } from "../../../components/ui/CodeBlock";

export interface MergePrButtonProps {
  prNumber: number;
  prTitle: string;
  repoFullName: string;
  expectedHeadSha: string;
  branchProtectionApplied: boolean;
  htmlUrl: string | null;
}

interface MergeResponse {
  ok?: boolean;
  merged?: boolean;
  sha?: string;
  message?: string;
  error?: string;
  status?: number;
}

export function MergePrButton({
  prNumber,
  prTitle,
  repoFullName,
  expectedHeadSha,
  branchProtectionApplied,
  htmlUrl,
}: MergePrButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const router = useRouter();
  const { push } = useToast();

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setInlineError(null);
    try {
      const res = await fetch(`/api/approvals/${prNumber}/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdDroid-Web-Action": "1",
        },
        body: JSON.stringify({ expectedHeadSha }),
      });
      const body = (await res.json().catch(() => ({}))) as MergeResponse;
      if (!res.ok || !body.ok) {
        const errMessage =
          body.error ?? body.message ?? `HTTP ${res.status}: マージに失敗しました`;
        setInlineError(errMessage);
        push({
          variant: "error",
          title: `PR #${prNumber} の承認に失敗しました`,
          description: errMessage,
        });
        return;
      }
      push({
        variant: "success",
        title: `PR #${prNumber} を承認しました`,
        description: body.sha
          ? `変更ID=${body.sha.slice(0, 12)} · 次の確認で反映処理に進みます`
          : "承認を記録しました",
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      setInlineError(msg);
      push({
        variant: "error",
        title: `PR #${prNumber} の承認に失敗しました`,
        description: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn--caution"
          onClick={() => {
            setInlineError(null);
            setOpen(true);
          }}
          disabled={busy}
        >
          承認して反映待ちにする
        </button>
        <span style={{ fontSize: "0.8125rem", color: "var(--color-text-secondary)" }}>
          承認後、次の確認で安全な反映処理に進みます。即時配信開始はしません。
        </span>
      </div>
      {!branchProtectionApplied ? (
        <div className="banner" data-state="warn" style={{ marginBottom: 0 }}>
          <span className="banner__title">保護設定が未適用です</span>
          <span>
            GitHub の保護設定が未完了のため、承認後の反映処理は拒否されます。
            接続と健康状態を確認してください。
          </span>
        </div>
      ) : null}

      <ConfirmDialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        onConfirm={handleConfirm}
        busy={busy}
        confirmLabel="承認して反映待ちにする"
        confirmVariant="caution"
        title="この変更を承認しますか？"
        description={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div>
              承認後、この変更は次の確認で反映処理に進みます。反映は停止状態で行われ、
              配信開始には別途確認が必要です。
            </div>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.7 }}>
              <li>
                リポジトリ: <InlineCode>{repoFullName}</InlineCode>
              </li>
              <li>
                PR: <InlineCode>#{prNumber}</InlineCode> {prTitle}
              </li>
              <li>
                変更ID: <InlineCode>{expectedHeadSha.slice(0, 12)}</InlineCode>
              </li>
              <li>
                保護設定:{" "}
                <InlineCode>
                  {branchProtectionApplied ? "適用済み" : "未適用"}
                </InlineCode>
              </li>
              <li>
                反映処理:{" "}
                <InlineCode>
                  {branchProtectionApplied ? "次の確認で開始" : "拒否されます"}
                </InlineCode>
              </li>
              {htmlUrl ? (
                <li>
                  GitHub:{" "}
                  <a
                    href={htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {htmlUrl}
                  </a>
                </li>
              ) : null}
            </ul>
            {inlineError ? (
              <div
                role="alert"
                style={{
                  padding: "var(--space-3)",
                  border: "1px solid var(--color-status-error)",
                  background: "var(--color-status-error-subtle)",
                  color: "var(--color-status-error)",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8125rem",
                }}
              >
                {inlineError}
              </div>
            ) : null}
          </div>
        }
      />
    </div>
  );
}

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedHeadSha }),
      });
      const body = (await res.json().catch(() => ({}))) as MergeResponse;
      if (!res.ok || !body.ok) {
        const errMessage =
          body.error ?? body.message ?? `HTTP ${res.status}: マージに失敗しました`;
        setInlineError(errMessage);
        push({
          variant: "error",
          title: `PR #${prNumber} のマージに失敗しました`,
          description: errMessage,
        });
        return;
      }
      push({
        variant: "success",
        title: `PR #${prNumber} を Web UI からマージしました`,
        description: body.sha
          ? `merge sha=${body.sha.slice(0, 12)} · 次回 github_poll で Apply pipeline が起動します`
          : "approval_records.decisionSource=web_merge を記録しました",
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      setInlineError(msg);
      push({
        variant: "error",
        title: `PR #${prNumber} のマージに失敗しました`,
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
          PR をマージする (Web UI)
        </button>
        <span style={{ fontSize: "0.8125rem", color: "var(--color-text-secondary)" }}>
          merge は GitHub merge と等価です。merge 成功時に{" "}
          <InlineCode>approval_records.decisionSource=web_merge</InlineCode>{" "}
          を記録し、次回 <InlineCode>github_poll</InlineCode> で Apply pipeline が起動します。
        </span>
      </div>
      {!branchProtectionApplied ? (
        <div className="banner" data-state="warn" style={{ marginBottom: 0 }}>
          <span className="banner__title">branch protection 未適用</span>
          <span>
            ops repo に branch protection が設定されていないため、Apply pipeline は
            次回 <InlineCode>github_poll</InlineCode> で
            {" "}<InlineCode>unprotected_branch</InlineCode>{" "}
            として拒否されます。/setup から branch protection を確認してください。
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
        confirmLabel="PR をマージする (Web UI)"
        confirmVariant="caution"
        title="PR をマージする (Web UI)"
        description={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div>
              GitHub merge API を呼びます。merge は不可逆で、成功時に Apply pipeline
              が次回 <InlineCode>github_poll</InlineCode> で起動します (branch protection
              が適用されている場合)。
            </div>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.7 }}>
              <li>
                Repo: <InlineCode>{repoFullName}</InlineCode>
              </li>
              <li>
                PR: <InlineCode>#{prNumber}</InlineCode> {prTitle}
              </li>
              <li>
                Expected HEAD: <InlineCode>{expectedHeadSha.slice(0, 12)}</InlineCode>
              </li>
              <li>
                Branch protection:{" "}
                <InlineCode>
                  {branchProtectionApplied ? "applied" : "not applied"}
                </InlineCode>
              </li>
              <li>
                Apply pipeline 起動:{" "}
                <InlineCode>
                  {branchProtectionApplied ? "yes (次回 github_poll)" : "no (拒否される)"}
                </InlineCode>
              </li>
              <li>
                記録される actor: <InlineCode>user:web-ui</InlineCode> ·{" "}
                decisionSource: <InlineCode>web_merge</InlineCode>
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

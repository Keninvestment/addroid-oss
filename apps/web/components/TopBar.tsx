// AdDroid OSS — TopBar.
// resolveWebBinding は process.env を読むので Server Component で実行される。
// the current implementation 拡張: 右側にデフォルト Meta アカウントと承認通知を表示する。

import Link from "next/link";
import { prisma } from "../lib/prisma";
import { ensureWebWorkspace } from "../lib/meta-runtime";
import { countApprovalRequiredPrs } from "../lib/approvals";

export async function TopBar() {
  const version = process.env.npm_package_version ?? "0.0.0";

  let defaultLabel: string | null = null;
  let approvalRequiredCount = 0;
  try {
    const currentWorkspace = await ensureWebWorkspace();
    const ws = await prisma.workspace.findUnique({
      where: { id: currentWorkspace.id },
      select: { defaultAdAccountId: true },
    });
    if (ws?.defaultAdAccountId) {
      const acc = await prisma.adAccount.findUnique({
        where: { id: ws.defaultAdAccountId },
        select: { metaAccountId: true, key: true },
      });
      defaultLabel = acc?.metaAccountId ?? acc?.key ?? null;
    }
    approvalRequiredCount = await countApprovalRequiredPrs(currentWorkspace.id);
  } catch {
    /* DB 未反映時は黙って未設定扱い */
  }

  return (
    <header className="top-bar">
      <Link href="/" className="top-bar__brand" style={{ color: "inherit", textDecoration: "none" }}>
        AdDroid OSS
      </Link>
      <div className="top-bar__meta">
        <Link
          href="/accounts"
          className="top-bar__chip"
          style={{ textDecoration: "none" }}
          aria-label={
            defaultLabel
              ? `デフォルト Meta アカウント: ${defaultLabel} (クリックで切替)`
              : "デフォルト Meta アカウント未設定 (クリックで設定)"
          }
        >
          広告アカウント:{" "}
          {defaultLabel ? (
            <span className="mono">{defaultLabel}</span>
          ) : (
            <span>未設定</span>
          )}
        </Link>
        {approvalRequiredCount > 0 ? (
          <Link
            href="/approvals"
            className="top-bar__approval-alert"
            aria-label={`承認が必要な変更が ${approvalRequiredCount} 件あります`}
          >
            <span className="top-bar__approval-dot" aria-hidden="true" />
            <span>承認</span>
            <span className="top-bar__approval-count">
              {approvalRequiredCount}
            </span>
          </Link>
        ) : null}
        <span className="top-bar__version">v{version}</span>
      </div>
    </header>
  );
}

// AdDroid OSS — TopBar.
// resolveWebBinding は process.env を読むので Server Component で実行される。
// the current implementation 拡張: 右側にデフォルト Meta アカウントと承認通知を表示する。

import Link from "next/link";
import { prisma } from "../lib/prisma";
import { ensureWebWorkspace } from "../lib/meta-runtime";
import { countApprovalRequiredPrs } from "../lib/approvals";
import { webT, type WebLanguage } from "../lib/i18n";

export async function TopBar({ language }: { language: WebLanguage }) {
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
              ? webT(language, "top.account.aria.set", { account: defaultLabel })
              : webT(language, "top.account.aria.empty")
          }
        >
          {webT(language, "top.account")}{" "}
          {defaultLabel ? (
            <span className="mono">{defaultLabel}</span>
          ) : (
            <span>{webT(language, "top.unset")}</span>
          )}
        </Link>
        {approvalRequiredCount > 0 ? (
          <Link
            href="/approvals"
            className="top-bar__approval-alert"
            aria-label={webT(language, "top.approval.aria", { count: approvalRequiredCount })}
          >
            <span className="top-bar__approval-dot" aria-hidden="true" />
            <span>{webT(language, "top.approval")}</span>
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

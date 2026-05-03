// AdDroid OSS — TopBar.
// resolveWebBinding は process.env を読むので Server Component で実行される。
// the current implementation 拡張: 右側に「現在のデフォルト Meta アカウント」を表示するチップを追加。

import Link from "next/link";
import { resolveWebBinding } from "@addroid/config";
import { prisma } from "../lib/prisma";

export async function TopBar() {
  let binding: { hostname: string; port: number };
  try {
    binding = resolveWebBinding();
  } catch {
    binding = { hostname: "127.0.0.1", port: 3000 };
  }
  const version = process.env.npm_package_version ?? "0.0.0";

  let defaultLabel: string | null = null;
  try {
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { defaultAdAccountId: true },
    });
    if (ws?.defaultAdAccountId) {
      const acc = await prisma.adAccount.findUnique({
        where: { id: ws.defaultAdAccountId },
        select: { metaAccountId: true, key: true },
      });
      defaultLabel = acc?.metaAccountId ?? acc?.key ?? null;
    }
  } catch {
    /* DB 未反映時は黙って未設定扱い */
  }

  return (
    <header className="top-bar">
      <div className="top-bar__brand">AdDroid OSS</div>
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
          Meta:{" "}
          {defaultLabel ? (
            <span className="mono">{defaultLabel}</span>
          ) : (
            <span>未設定 · 選択する</span>
          )}
        </Link>
        <span className="top-bar__chip">
          {binding.hostname}:{binding.port} · outbound-only
        </span>
        <span>v{version}</span>
      </div>
    </header>
  );
}

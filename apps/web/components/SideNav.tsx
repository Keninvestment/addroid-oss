"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    label: "全体",
    items: [{ href: "/", label: "ホーム", exact: true }],
  },
  {
    label: "広告運用",
    items: [
      { href: "/accounts", label: "広告アカウント" },
      { href: "/reports/daily", label: "日次レポート" },
      { href: "/budget", label: "予算チェック" },
      { href: "/plans", label: "入稿前チェック" },
      { href: "/campaigns", label: "配信中の広告" },
    ],
  },
  {
    label: "改善",
    items: [
      { href: "/improvements", label: "改善提案" },
      { href: "/creatives", label: "クリエイティブ生成" },
      { href: "/creatives/submit", label: "クリエイティブ入稿" },
    ],
  },
  {
    label: "確認と自動化",
    items: [
      { href: "/approvals", label: "承認待ち" },
      { href: "/cron", label: "自動実行", exact: true },
      { href: "/cron/runs", label: "実行ログ" },
      { href: "/cron/audit", label: "操作履歴" },
      { href: "/github", label: "GitHub 連携" },
    ],
  },
  {
    label: "設定",
    items: [{ href: "/setup", label: "接続と健康状態" }],
  },
];

export function SideNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="side-nav" aria-label="primary">
      {groups.map((group) => (
        <div className="side-nav__group" key={group.label}>
          <div className="side-nav__group-label">{group.label}</div>
          {group.items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="side-nav__link"
                data-active={active ? "true" : "false"}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

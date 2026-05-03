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
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", exact: true }],
  },
  {
    label: "Meta Ads",
    items: [
      { href: "/accounts", label: "Accounts" },
      { href: "/plans", label: "Plans" },
      { href: "/campaigns", label: "Campaigns" },
    ],
  },
  {
    label: "AI Workflows",
    items: [
      { href: "/improvements", label: "Improvements" },
      { href: "/creatives", label: "Creatives" },
    ],
  },
  {
    label: "GitOps",
    items: [
      { href: "/github", label: "GitHub" },
      { href: "/approvals", label: "Approvals" },
      { href: "/cron", label: "Schedules", exact: true },
      { href: "/cron/runs", label: "Runs" },
      { href: "/cron/audit", label: "Audit" },
      { href: "/logs", label: "Logs" },
    ],
  },
  {
    label: "Maintenance",
    items: [{ href: "/setup", label: "Setup & Health" }],
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

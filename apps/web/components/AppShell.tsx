import type { ReactNode } from "react";
import { SideNav } from "./SideNav";
import { TopBar } from "./TopBar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <TopBar />
      <div className="shell-grid">
        <SideNav />
        <main className="page-area">{children}</main>
      </div>
    </div>
  );
}

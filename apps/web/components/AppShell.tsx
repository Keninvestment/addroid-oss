import type { ReactNode } from "react";
import { I18nProvider, type WebLanguage } from "./I18nProvider";
import { SideNav } from "./SideNav";
import { TopBar } from "./TopBar";

export function AppShell({
  children,
  language,
}: {
  children: ReactNode;
  language: WebLanguage;
}) {
  return (
    <I18nProvider language={language}>
      <div className="app-shell">
        <TopBar language={language} />
        <div className="shell-grid">
          <SideNav />
          <main className="page-area">{children}</main>
        </div>
      </div>
    </I18nProvider>
  );
}

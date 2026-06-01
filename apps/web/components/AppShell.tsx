import type { ReactNode } from "react";
import { I18nProvider } from "./I18nProvider";
import { SideNav } from "./SideNav";
import { TopBar } from "./TopBar";
import type { WebLanguage } from "../lib/i18n";

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

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { languageToHtmlLang } from "@addroid/config";
import { AppShell } from "../components/AppShell";
import { ToastProvider } from "../components/ui/Toast";
import { resolveWebLanguage } from "../lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdDroid OSS",
  description:
    "AdDroid OSS — localhost-only, outbound-only operator console for GitOps-managed Meta ad operations.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const headerList = await headers();
  const language = await resolveWebLanguage(headerList.get("accept-language"));
  return (
    <html lang={languageToHtmlLang(language)}>
      <body>
        <ToastProvider>
          <AppShell language={language}>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}

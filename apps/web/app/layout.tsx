import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import { ToastProvider } from "../components/ui/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdDroid OSS",
  description:
    "AdDroid OSS — localhost-only, outbound-only operator console for GitOps-managed Meta ad operations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}

"use client";

import type { ReactNode } from "react";

export function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="async-label">
      <span className="async-spinner" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function LoadingDots({ label }: { label: ReactNode }) {
  return (
    <span className="async-dots-label">
      <span>{label}</span>
      <span className="async-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

import type { ReactNode } from "react";

export type StatusState = "ok" | "warn" | "error" | "info" | "idle";

export function StatusDot({
  state,
  children,
}: {
  state: StatusState;
  children: ReactNode;
}) {
  return (
    <span className="status-dot" data-state={state}>
      <span>{children}</span>
    </span>
  );
}

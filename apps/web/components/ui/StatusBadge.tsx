import type { ReactNode } from "react";
import type { StatusState } from "./StatusDot";

export function StatusBadge({
  state,
  children,
}: {
  state: StatusState;
  children: ReactNode;
}) {
  return (
    <span className="status-badge" data-state={state}>
      {children}
    </span>
  );
}

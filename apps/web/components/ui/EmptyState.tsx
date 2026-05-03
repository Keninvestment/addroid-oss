import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3 className="empty-state__title">{title}</h3>
      {description ? <p className="empty-state__body">{description}</p> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

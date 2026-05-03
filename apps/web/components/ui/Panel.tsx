import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  status,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel__head">
        <div>
          <h2 className="panel__title">{title}</h2>
          {subtitle ? <p className="panel__subtitle">{subtitle}</p> : null}
        </div>
        {status ? <div>{status}</div> : null}
      </header>
      <div>{children}</div>
    </section>
  );
}

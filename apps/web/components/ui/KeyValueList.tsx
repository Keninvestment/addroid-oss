import type { ReactNode } from "react";

export interface KeyValueEntry {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export function KeyValueList({ items }: { items: KeyValueEntry[] }) {
  return (
    <dl className="kv">
      {items.map((item, index) => (
        <FragmentRow key={index} item={item} />
      ))}
    </dl>
  );
}

function FragmentRow({ item }: { item: KeyValueEntry }) {
  return (
    <>
      <dt>{item.label}</dt>
      <dd className={item.mono ? "mono" : undefined} style={item.mono ? { fontFamily: "var(--font-mono)" } : undefined}>
        {item.value}
      </dd>
    </>
  );
}

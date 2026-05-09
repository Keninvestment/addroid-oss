"use client";

// AdDroid OSS — /campaigns 上部の Toolbar.
//
// Account / Status / 検索の 3 フィルタを URL クエリに同期する。
// SSR ページ (/campaigns/page.tsx) はクエリを読み取って Prisma へ渡す。
// ここでは UI のみ — フィルタ確定タイミングは change / submit。
//
// CLAUDE.md guardrail #4 (API-First for Every View): フィルタの値はサーバーサイドで
// Prisma に流し込み、結果は SSR で描画される。クライアント側で再フェッチしない。

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

export interface AccountOption {
  id: string;
  key: string;
  metaAccountId: string | null;
  displayName: string;
}

export interface CampaignsToolbarProps {
  accounts: AccountOption[];
  selectedAccountId: string | null;
  selectedStatus: string;
  selectedQuery: string;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "PAUSED", label: "PAUSED" },
  { value: "ACTIVE", label: "ACTIVE" },
  { value: "ARCHIVED", label: "ARCHIVED" },
];

export function CampaignsToolbar({
  accounts,
  selectedAccountId,
  selectedStatus,
  selectedQuery,
}: CampaignsToolbarProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [draftQuery, setDraftQuery] = useState(selectedQuery);

  const baseHref = useMemo(() => {
    const next = new URLSearchParams(params?.toString() ?? "");
    return next;
  }, [params]);

  function navigate(updates: Record<string, string | null>) {
    const next = new URLSearchParams(baseHref.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    const search = next.toString();
    router.push(search ? `/campaigns?${search}` : "/campaigns");
  }

  return (
    <div className="toolbar" role="group" aria-label="キャンペーンの絞り込み">
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="campaigns-account">
          Account
        </label>
        <select
          id="campaigns-account"
          className="form-select"
          value={selectedAccountId ?? ""}
          onChange={(ev) =>
            navigate({
              accountId: ev.target.value || null,
              campaignId: null,
              adsetId: null,
            })
          }
          disabled={accounts.length === 0}
        >
          {accounts.length === 0 ? (
            <option value="">アカウント未登録</option>
          ) : (
            accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.metaAccountId ?? account.key} — {account.displayName}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="campaigns-status">
          Status
        </label>
        <select
          id="campaigns-status"
          className="form-select"
          value={selectedStatus}
          onChange={(ev) =>
            navigate({ status: ev.target.value === "all" ? null : ev.target.value })
          }
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <form
        className="toolbar__field toolbar__field--grow"
        onSubmit={(ev) => {
          ev.preventDefault();
          navigate({ q: draftQuery.trim() || null });
        }}
      >
        <label className="toolbar__label" htmlFor="campaigns-q">
          Search
        </label>
        <input
          id="campaigns-q"
          className="form-input form-input--search"
          type="search"
          placeholder="name で部分一致"
          value={draftQuery}
          onChange={(ev) => setDraftQuery(ev.target.value)}
        />
      </form>
    </div>
  );
}

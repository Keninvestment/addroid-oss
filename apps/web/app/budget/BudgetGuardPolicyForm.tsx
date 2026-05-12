"use client";

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../../components/ui/Toast";

interface AccountOption {
  key: string;
  displayName: string;
  currency: string | null;
}

interface PolicyAccount {
  dailyBudget?: number;
  monthlyBudget?: number;
  currency?: string;
}

interface BudgetGuardPolicyFormProps {
  accounts: AccountOption[];
  policy: {
    alerts?: {
      dailyBudgetAlertRatio?: number;
      monthlyPaceRatio?: number;
      dayOverDayRatio?: number;
      noConversionsSpendMin?: number;
    };
    autoPause?: {
      enabled?: boolean;
      minDailyBudgetRatio?: number;
      minDayOverDayRatio?: number;
      safeCategories?: string[];
    };
    accounts?: Record<string, PolicyAccount>;
  } | null;
  initialCron: string;
  initialEnabled: boolean;
  disabled?: boolean;
}

export function BudgetGuardPolicyForm({
  accounts,
  policy,
  initialCron,
  initialEnabled,
  disabled = false,
}: BudgetGuardPolicyFormProps) {
  const router = useRouter();
  const toast = useToast();
  const firstAccountKey = accounts[0]?.key ?? "";
  const [accountKey, setAccountKey] = useState(firstAccountKey);
  const [saving, setSaving] = useState(false);
  const selectedAccount = accounts.find((a) => a.key === accountKey) ?? accounts[0] ?? null;
  const accountPolicy = policy?.accounts?.[accountKey] ?? null;
  const [dailyBudget, setDailyBudget] = useState(
    accountPolicy?.dailyBudget?.toString() ?? ""
  );
  const [monthlyBudget, setMonthlyBudget] = useState(
    accountPolicy?.monthlyBudget?.toString() ?? ""
  );
  const [currency, setCurrency] = useState(
    accountPolicy?.currency ?? selectedAccount?.currency ?? "JPY"
  );
  const [enabled, setEnabled] = useState(initialEnabled);
  const [runTime, setRunTime] = useState(dailyTimeFromCron(initialCron) ?? "09:30");

  const [dailyBudgetAlertPercent, setDailyBudgetAlertPercent] = useState(
    ratioToPercent(policy?.alerts?.dailyBudgetAlertRatio ?? 0.8)
  );
  const [monthlyPacePercent, setMonthlyPacePercent] = useState(
    ratioToPercent(policy?.alerts?.monthlyPaceRatio ?? 1)
  );
  const [dayOverDayPercent, setDayOverDayPercent] = useState(
    ratioToPercent(policy?.alerts?.dayOverDayRatio ?? 1.5)
  );
  const [noConversionsSpendMin, setNoConversionsSpendMin] = useState(
    policy?.alerts?.noConversionsSpendMin && policy.alerts.noConversionsSpendMin > 0
      ? String(policy.alerts.noConversionsSpendMin)
      : ""
  );
  const [autoPauseEnabled, setAutoPauseEnabled] = useState(
    policy?.autoPause?.enabled ?? false
  );
  const [autoPauseMinDailyBudgetPercent, setAutoPauseMinDailyBudgetPercent] =
    useState(ratioToPercent(policy?.autoPause?.minDailyBudgetRatio ?? 1.2));
  const [autoPauseMinDayOverDayPercent, setAutoPauseMinDayOverDayPercent] =
    useState(ratioToPercent(policy?.autoPause?.minDayOverDayRatio ?? 2));
  const [safeCategories, setSafeCategories] = useState(
    (policy?.autoPause?.safeCategories ?? []).join(", ")
  );

  const accountChoices = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.key,
        label: `${account.displayName} (${account.key})`,
      })),
    [accounts]
  );

  function selectAccount(nextKey: string) {
    setAccountKey(nextKey);
    const nextAccount = accounts.find((a) => a.key === nextKey) ?? null;
    const nextPolicy = policy?.accounts?.[nextKey] ?? null;
    setDailyBudget(nextPolicy?.dailyBudget?.toString() ?? "");
    setMonthlyBudget(nextPolicy?.monthlyBudget?.toString() ?? "");
    setCurrency(nextPolicy?.currency ?? nextAccount?.currency ?? "JPY");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountKey) return;
    setSaving(true);
    try {
      const res = await fetch("/api/budget/policy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdDroid-Web-Action": "1",
        },
        body: JSON.stringify({
          accountKey,
          dailyBudget: Number(dailyBudget),
          monthlyBudget: Number(monthlyBudget),
          currency,
          dailyBudgetAlertRatio: percentToRatio(dailyBudgetAlertPercent),
          monthlyPaceRatio: percentToRatio(monthlyPacePercent),
          dayOverDayRatio: percentToRatio(dayOverDayPercent),
          noConversionsSpendMin:
            noConversionsSpendMin.trim() === "" ? null : Number(noConversionsSpendMin),
          autoPauseEnabled,
          autoPauseMinDailyBudgetRatio: percentToRatio(autoPauseMinDailyBudgetPercent),
          autoPauseMinDayOverDayRatio: percentToRatio(autoPauseMinDayOverDayPercent),
          safeCategories,
          cron: cronFromDailyTime(runTime),
          enabled,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        enabled?: boolean;
        cron?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.push({
        variant: "success",
        title: "予算チェックのルールを保存しました",
        description: `${body.enabled ? "自動実行 ON" : "自動実行 OFF"} / ${body.cron ?? cronFromDailyTime(runTime)}`,
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "予算チェックのルールを保存できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "1rem" }}>
      {accounts.length === 0 ? (
        <div className="empty-state">
          <h3 className="empty-state__title">広告アカウントがありません</h3>
          <p className="empty-state__body">
            先に accounts で Meta 広告アカウントを同期してください。
          </p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
              gap: "0.75rem",
              alignItems: "end",
            }}
          >
            <label className="toolbar__field">
              <span>広告アカウント</span>
              <select
                className="form-select"
                value={accountKey}
                onChange={(e) => selectAccount(e.target.value)}
                disabled={disabled || saving}
              >
                {accountChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <MoneyField
              label="1日の予算"
              value={dailyBudget}
              onChange={setDailyBudget}
              disabled={disabled || saving}
              required
            />
            <MoneyField
              label="1か月の予算"
              value={monthlyBudget}
              onChange={setMonthlyBudget}
              disabled={disabled || saving}
              required
            />
            <label className="toolbar__field">
              <span>通貨</span>
              <input
                className="form-input"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                disabled={disabled || saving}
                maxLength={8}
              />
            </label>
            <label className="toolbar__field">
              <span>毎日の確認時刻</span>
              <input
                className="form-input"
                type="time"
                value={runTime}
                onChange={(e) => setRunTime(e.target.value)}
                disabled={disabled || saving}
              />
            </label>
            <label className="toolbar__field" style={{ flexDirection: "row", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={disabled || saving}
              />
              <span>自動実行する</span>
            </label>
          </div>

          <details>
            <summary
              style={{
                cursor: "pointer",
                color: "var(--color-text-secondary)",
                fontWeight: 600,
              }}
            >
              詳細設定
            </summary>
            <div style={{ display: "grid", gap: "0.875rem", paddingTop: "0.875rem" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
                  gap: "0.75rem",
                }}
              >
                <PercentField
                  label="1日予算の注意ライン"
                  value={dailyBudgetAlertPercent}
                  onChange={setDailyBudgetAlertPercent}
                  disabled={disabled || saving}
                />
                <PercentField
                  label="月予算ペースの注意ライン"
                  value={monthlyPacePercent}
                  onChange={setMonthlyPacePercent}
                  disabled={disabled || saving}
                />
                <PercentField
                  label="前日比の注意ライン"
                  value={dayOverDayPercent}
                  onChange={setDayOverDayPercent}
                  disabled={disabled || saving}
                />
                <MoneyField
                  label="CVなし最低消化"
                  value={noConversionsSpendMin}
                  onChange={setNoConversionsSpendMin}
                  disabled={disabled || saving}
                  placeholder="未設定"
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
                  gap: "0.75rem",
                  alignItems: "end",
                }}
              >
                <label className="toolbar__field" style={{ flexDirection: "row", gap: "0.5rem" }}>
                  <input
                    type="checkbox"
                    checked={autoPauseEnabled}
                    onChange={(e) => setAutoPauseEnabled(e.target.checked)}
                    disabled={disabled || saving}
                  />
                  <span>停止すべき広告を提案する</span>
                </label>
                <PercentField
                  label="提案する 1日予算ライン"
                  value={autoPauseMinDailyBudgetPercent}
                  onChange={setAutoPauseMinDailyBudgetPercent}
                  disabled={disabled || saving || !autoPauseEnabled}
                />
                <PercentField
                  label="提案する 前日比ライン"
                  value={autoPauseMinDayOverDayPercent}
                  onChange={setAutoPauseMinDayOverDayPercent}
                  disabled={disabled || saving || !autoPauseEnabled}
                />
                <label className="toolbar__field">
                  <span>安全カテゴリ</span>
                  <input
                    className="form-input"
                    value={safeCategories}
                    onChange={(e) => setSafeCategories(e.target.value)}
                    disabled={disabled || saving || !autoPauseEnabled}
                    placeholder="auto_pause"
                  />
                </label>
              </div>
            </div>
          </details>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={disabled || saving}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function MoneyField({
  label,
  value,
  onChange,
  disabled,
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="toolbar__field">
      <span>{label}</span>
      <input
        className="form-input"
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
      />
    </label>
  );
}

function PercentField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toolbar__field">
      <span>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        <input
          className="form-input"
          type="number"
          min="0"
          step="1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
        <span style={{ color: "var(--color-text-secondary)" }}>%</span>
      </div>
    </label>
  );
}

function ratioToPercent(value: number): string {
  return String(Math.round(value * 100));
}

function percentToRatio(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : 0;
}

function dailyTimeFromCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") {
    return null;
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23
  ) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cronFromDailyTime(value: string): string {
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return "30 9 * * *";
  }
  return `${minute} ${hour} * * *`;
}

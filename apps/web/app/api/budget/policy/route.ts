// AdDroid OSS — POST /api/budget/policy.
//
// Saves `workflows/budget-guard.yaml` through the same local ops-repo boundary
// that validation/plan use, then optionally enables the budget_guard preset.

import { NextResponse } from "next/server";
import { requireTrustedJsonWebAction } from "../../../../lib/request-guard";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../lib/github-runtime";
import { setCronScheduleEnabled } from "../../../../lib/cron-actions";
import { saveBudgetGuardPolicyConfig } from "../../../../../worker/src/lib/budget-guard-policy-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON body を読み取れませんでした。" },
      { status: 400 }
    );
  }

  try {
    const workspace = await ensureWebWorkspace();
    const saved = await saveBudgetGuardPolicyConfig({
      prisma,
      workspaceId: workspace.id,
      input: normalizePayload(payload),
      actor: "user:web-ui",
    });
    const cron = readOptionalString(payload.cron);
    const enabled = payload.enabled === true;
    const schedule = await setCronScheduleEnabled("budget_guard", {
      cron,
      enabled,
    });
    if (!schedule.ok) {
      return NextResponse.json(
        {
          ok: false,
          policySaved: true,
          error: schedule.error,
          accountKey: saved.accountKey,
          yamlPath: saved.yamlPath,
        },
        { status: schedule.status }
      );
    }
    return NextResponse.json({
      ok: true,
      accountKey: saved.accountKey,
      yamlPath: saved.yamlPath,
      cron: schedule.cron,
      enabled: schedule.enabled,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 }
    );
  }
}

function normalizePayload(payload: Record<string, unknown>) {
  return {
    accountKey: readOptionalString(payload.accountKey),
    dailyBudget: readNumber(payload.dailyBudget, "dailyBudget"),
    monthlyBudget: readNumber(payload.monthlyBudget, "monthlyBudget"),
    currency: readOptionalString(payload.currency),
    dailyBudgetAlertRatio: readOptionalNumber(payload.dailyBudgetAlertRatio),
    monthlyPaceRatio: readOptionalNumber(payload.monthlyPaceRatio),
    dayOverDayRatio: readOptionalNumber(payload.dayOverDayRatio),
    noConversionsSpendMin: readOptionalNumber(payload.noConversionsSpendMin),
    autoPauseEnabled: payload.autoPauseEnabled === true,
    autoPauseMinDailyBudgetRatio: readOptionalNumber(
      payload.autoPauseMinDailyBudgetRatio
    ),
    autoPauseMinDayOverDayRatio: readOptionalNumber(
      payload.autoPauseMinDayOverDayRatio
    ),
    safeCategories:
      Array.isArray(payload.safeCategories) || typeof payload.safeCategories === "string"
        ? (payload.safeCategories as string[] | string)
        : [],
  };
}

function readNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} は数値で指定してください。`);
  return n;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

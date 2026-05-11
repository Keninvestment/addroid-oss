// AdDroid OSS — POST /api/campaigns/sync.
//
// /campaigns の表示元である ads_hierarchy を、Meta Graph API の読み取り結果から
// 同期する。Meta 側の変更は行わず、campaign/adset/ad の現在状態をローカルDBへ
// upsert するだけに限定する。

import { NextResponse } from "next/server";
import { META_GRAPH_API_VERSION } from "@addroid/meta-adapter";
import { Prisma } from "@addroid/db";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace, getActiveMetaAdapter } from "../../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

interface Body {
  accountId?: unknown;
}

type NodeType = "campaign" | "adset" | "ad";
type InsightsLevel = NodeType;

interface GraphRow {
  id: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  campaignId: string | null;
  adsetId: string | null;
  raw: Record<string, unknown>;
}

interface GraphPage {
  data?: unknown;
  paging?: { next?: unknown };
  error?: { message?: unknown; type?: unknown; code?: unknown };
}

interface GraphInsightsRow {
  nodeType: InsightsLevel;
  nodeKey: string;
  raw: Record<string, unknown>;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
}

const CONVERSION_ACTION_TYPES = [
  "purchase",
  "lead",
  "complete_registration",
  "offsite_conversion",
  "omni_purchase",
];

export async function POST(request: Request) {
  let payload: Body = {};
  try {
    payload = (await request.json()) as Body;
  } catch {
    /* body は任意 */
  }

  const workspace = await ensureWebWorkspace();
  const accountId =
    typeof payload.accountId === "string" && payload.accountId.trim()
      ? payload.accountId.trim()
      : null;

  const ws = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: { defaultAdAccountId: true },
  });
  const account = await prisma.adAccount.findFirst({
    where: {
      workspaceId: workspace.id,
      active: true,
      ...(accountId
        ? { id: accountId }
        : ws?.defaultAdAccountId
          ? { id: ws.defaultAdAccountId }
          : {}),
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      key: true,
      metaAccountId: true,
      displayName: true,
      timezoneName: true,
    },
  });
  if (!account) {
    return NextResponse.json(
      { ok: false, error: "同期対象の広告アカウントがありません。" },
      { status: 404 }
    );
  }

  const metaAccountId = account.metaAccountId ?? account.key;
  if (!metaAccountId) {
    return NextResponse.json(
      { ok: false, error: "広告アカウントIDが未設定です。" },
      { status: 400 }
    );
  }

  const { adapter } = await getActiveMetaAdapter();
  const lease = await adapter.loadAccessTokenPlaintext();
  if (!lease?.accessToken) {
    return NextResponse.json(
      { ok: false, error: "Meta token が未接続です。" },
      { status: 401 }
    );
  }

  try {
    const [campaigns, adsets, ads] = await Promise.all([
      fetchGraphRows(metaAccountId, "campaigns", lease.accessToken),
      fetchGraphRows(metaAccountId, "adsets", lease.accessToken),
      fetchGraphRows(metaAccountId, "ads", lease.accessToken),
    ]);
    const result = await persistHierarchy({
      accountId: account.id,
      campaigns,
      adsets,
      ads,
    });
    const metricDate = currentDateForTimeZone(account.timezoneName);
    let metricResult:
      | { metricDate: string; rows: number; snapshots: number; error?: undefined }
      | { metricDate: string; rows: number; snapshots: number; error: string } = {
      metricDate,
      rows: 0,
      snapshots: 0,
    };
    try {
      const insightRows = await fetchGraphInsights(metaAccountId, lease.accessToken, metricDate);
      const snapshots = await persistPerformanceSnapshots({
        accountId: account.id,
        metricDate,
        rows: insightRows,
      });
      metricResult = {
        metricDate,
        rows: insightRows.length,
        snapshots,
      };
    } catch (err) {
      metricResult = {
        metricDate,
        rows: 0,
        snapshots: 0,
        error: (err as Error).message,
      };
    }
    await prisma.auditLog
      .create({
        data: {
          workspaceId: workspace.id,
          actor: "user:web-ui",
          action: "campaigns.synced_from_meta",
          target: `ad_account:${account.id}`,
          ref: metaAccountId,
          metadata: {
            campaignCount: campaigns.length,
            adsetCount: adsets.length,
            adCount: ads.length,
            upserted: result.upserted,
            metricDate: metricResult.metricDate,
            metricRows: metricResult.rows,
            metricSnapshots: metricResult.snapshots,
            metricError: metricResult.error ?? null,
          } satisfies Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    return NextResponse.json({
      ok: true,
      account: {
        id: account.id,
        key: account.key,
        displayName: account.displayName,
        metaAccountId,
      },
      campaigns: campaigns.length,
      adsets: adsets.length,
      ads: ads.length,
      upserted: result.upserted,
      metrics: metricResult,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 }
    );
  }
}

async function fetchGraphInsights(
  accountId: string,
  accessToken: string,
  metricDate: string
): Promise<GraphInsightsRow[]> {
  const levels: InsightsLevel[] = ["campaign", "adset", "ad"];
  const nested = await Promise.all(
    levels.map((level) => fetchGraphInsightsLevel(accountId, level, accessToken, metricDate))
  );
  return nested.flat();
}

async function fetchGraphInsightsLevel(
  accountId: string,
  level: InsightsLevel,
  accessToken: string,
  metricDate: string
): Promise<GraphInsightsRow[]> {
  let url = new URL(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/insights`
  );
  url.searchParams.set("level", level);
  url.searchParams.set("fields", insightsFieldsForLevel(level));
  url.searchParams.set("time_range", JSON.stringify({ since: metricDate, until: metricDate }));
  url.searchParams.set("limit", "500");

  const rows: GraphInsightsRow[] = [];
  for (let page = 0; page < 10 && url; page += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as GraphPage;
    if (!res.ok || body.error) {
      const message =
        typeof body.error?.message === "string"
          ? body.error.message
          : `Meta Graph API insights failed: HTTP ${res.status}`;
      throw new Error(message);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      if (!isRecord(item)) continue;
      const nodeKey = readString(item[`${level}_id`]) ?? readString(item.id);
      if (!nodeKey) continue;
      rows.push({
        nodeType: level,
        nodeKey,
        raw: item,
        impressions: integerField(item, "impressions"),
        clicks: integerField(item, "clicks"),
        spendMicros: majorToMicros(numberField(item, "spend")),
        conversions: extractConversions(item),
      });
    }
    const next = typeof body.paging?.next === "string" ? body.paging.next : "";
    if (!next) break;
    url = new URL(next);
    url.searchParams.delete("access_token");
  }
  return rows;
}

function insightsFieldsForLevel(level: InsightsLevel): string {
  const identity =
    level === "campaign"
      ? "campaign_id,campaign_name"
      : level === "adset"
        ? "adset_id,adset_name,campaign_id"
        : "ad_id,ad_name,adset_id,campaign_id";
  return `${identity},spend,impressions,clicks,actions,date_start,date_stop`;
}

async function persistPerformanceSnapshots(input: {
  accountId: string;
  metricDate: string;
  rows: GraphInsightsRow[];
}): Promise<number> {
  if (input.rows.length === 0) return 0;
  const nodes = await prisma.adsHierarchyNode.findMany({
    where: {
      accountId: input.accountId,
      nodeType: { in: ["campaign", "adset", "ad"] },
    },
    select: { id: true, nodeType: true, nodeKey: true, externalId: true },
  });
  const nodeIdByKey = new Map<string, string>();
  for (const node of nodes) {
    nodeIdByKey.set(metricNodeKey(node.nodeType, node.nodeKey), node.id);
    if (node.externalId) nodeIdByKey.set(metricNodeKey(node.nodeType, node.externalId), node.id);
  }

  const metricDate = new Date(`${input.metricDate}T00:00:00.000Z`);
  let snapshots = 0;
  for (const row of input.rows) {
    const hierarchyId = nodeIdByKey.get(metricNodeKey(row.nodeType, row.nodeKey)) ?? null;
    await prisma.performanceSnapshot.upsert({
      where: {
        accountId_nodeType_nodeKey_metricDate: {
          accountId: input.accountId,
          nodeType: row.nodeType,
          nodeKey: row.nodeKey,
          metricDate,
        },
      },
      update: {
        hierarchyId,
        impressions: row.impressions,
        clicks: row.clicks,
        spendMicros: row.spendMicros,
        conversions: row.conversions,
        raw: row.raw as Prisma.InputJsonValue,
        source: "meta_graph_insights",
      },
      create: {
        accountId: input.accountId,
        hierarchyId,
        nodeType: row.nodeType,
        nodeKey: row.nodeKey,
        metricDate,
        impressions: row.impressions,
        clicks: row.clicks,
        spendMicros: row.spendMicros,
        conversions: row.conversions,
        raw: row.raw as Prisma.InputJsonValue,
        source: "meta_graph_insights",
      },
    });
    snapshots += 1;
  }
  return snapshots;
}

async function fetchGraphRows(
  accountId: string,
  edge: "campaigns" | "adsets" | "ads",
  accessToken: string
): Promise<GraphRow[]> {
  const fields =
    edge === "campaigns"
      ? "id,name,status,effective_status,configured_status,updated_time"
      : edge === "adsets"
        ? "id,name,status,effective_status,configured_status,campaign_id,updated_time"
        : "id,name,status,effective_status,configured_status,campaign_id,adset_id,updated_time";
  let url = new URL(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/${edge}`
  );
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "500");

  const rows: GraphRow[] = [];
  for (let page = 0; page < 10 && url; page += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as GraphPage;
    if (!res.ok || body.error) {
      const message =
        typeof body.error?.message === "string"
          ? body.error.message
          : `Meta Graph API ${edge} failed: HTTP ${res.status}`;
      throw new Error(message);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      rows.push({
        id: item.id,
        name: readString(item.name),
        status: readString(item.status),
        effectiveStatus: readString(item.effective_status),
        configuredStatus: readString(item.configured_status),
        campaignId: readString(item.campaign_id),
        adsetId: readString(item.adset_id),
        raw: item,
      });
    }
    const next = typeof body.paging?.next === "string" ? body.paging.next : "";
    if (!next) break;
    url = new URL(next);
    url.searchParams.delete("access_token");
  }
  return rows;
}

async function persistHierarchy(input: {
  accountId: string;
  campaigns: GraphRow[];
  adsets: GraphRow[];
  ads: GraphRow[];
}): Promise<{ upserted: number }> {
  const campaignIds = new Map<string, string>();
  const adsetIds = new Map<string, string>();
  let upserted = 0;

  for (const row of input.campaigns) {
    const saved = await upsertNode(input.accountId, "campaign", row, null);
    campaignIds.set(row.id, saved.id);
    upserted += 1;
  }
  for (const row of input.adsets) {
    const saved = await upsertNode(
      input.accountId,
      "adset",
      row,
      row.campaignId ? campaignIds.get(row.campaignId) ?? null : null
    );
    adsetIds.set(row.id, saved.id);
    upserted += 1;
  }
  for (const row of input.ads) {
    await upsertNode(
      input.accountId,
      "ad",
      row,
      row.adsetId ? adsetIds.get(row.adsetId) ?? null : null
    );
    upserted += 1;
  }

  return { upserted };
}

async function upsertNode(
  accountId: string,
  nodeType: NodeType,
  row: GraphRow,
  parentId: string | null
): Promise<{ id: string }> {
  const status = normalizeMetaStatus(row.effectiveStatus ?? row.status);
  const data = {
    displayName: row.name ?? row.id,
    status,
    externalId: row.id,
    parentId,
    spec: {
      source: "meta_graph_sync",
      configuredStatus: row.configuredStatus ?? row.status,
      effectiveStatus: row.effectiveStatus,
      syncedAt: new Date().toISOString(),
      raw: row.raw,
    } as Prisma.InputJsonValue,
  };
  return prisma.adsHierarchyNode.upsert({
    where: {
      accountId_nodeType_nodeKey: {
        accountId,
        nodeType,
        nodeKey: row.id,
      },
    },
    update: data,
    create: {
      accountId,
      nodeType,
      nodeKey: row.id,
      ...data,
    },
    select: { id: true },
  });
}

function normalizeMetaStatus(value: string | null): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "archived" || normalized === "deleted") return normalized;
  return "paused";
}

function metricNodeKey(nodeType: string, nodeKey: string): string {
  return `${nodeType}:${nodeKey}`;
}

function currentDateForTimeZone(timeZone: string | null): string {
  const safeTimeZone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractConversions(row: Record<string, unknown>): number {
  const direct = numberField(row, "conversions");
  if (direct > 0) return Math.floor(direct);
  if (!Array.isArray(row.actions)) return 0;
  let total = 0;
  for (const action of row.actions) {
    if (!isRecord(action)) continue;
    const actionType = readString(action.action_type);
    if (!actionType) continue;
    if (CONVERSION_ACTION_TYPES.some((needle) => actionType.includes(needle))) {
      total += numberField(action, "value");
    }
  }
  return Math.floor(total);
}

function integerField(row: Record<string, unknown>, key: string): number {
  return Math.max(0, Math.floor(numberField(row, key)));
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function majorToMicros(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

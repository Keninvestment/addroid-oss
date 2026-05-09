import { spawn } from "node:child_process";
import { type PrismaClient } from "@addroid/db";
import { getCryptoBoundary } from "@addroid/config";

export async function runMetaAdsReadOnlyQuery(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  args: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ label: string; rows: unknown[]; rowCount: number; message: string }> {
  const env = opts.env ?? process.env;
  const plan = buildMetaAdsReadOnlyInvocation(opts.args);
  const runtime = await prepareMetaAdsCliRuntime({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    accountKey: plan.accountKey,
    requiresAdAccount: plan.requiresAdAccount,
    env,
  });
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ACCESS_TOKEN: runtime.accessToken,
    META_ACCESS_TOKEN: runtime.accessToken,
  };
  if (runtime.adAccountId) childEnv.AD_ACCOUNT_ID = runtime.adAccountId;
  if (plan.businessId) childEnv.BUSINESS_ID = plan.businessId;
  const result = await spawnMetaAdsCli({
    binaryPath: runtime.binaryPath,
    args: plan.args,
    env: childEnv,
  });
  if (result.code !== 0) {
    throw new Error(
      [
        "Meta Ads の読み取りに失敗しました。",
        sanitizeMetaCliText(result.stderr || result.stdout, runtime.accessToken),
      ].join("\n")
    );
  }
  const rows = extractUnknownRows(parseUnknownJson(result.stdout));
  return {
    label: plan.label,
    rows,
    rowCount: rows.length,
    message: `Meta Ads から ${plan.label} を取得しました。結果: ${rows.length}件`,
  };
}

function buildMetaAdsReadOnlyInvocation(args: Record<string, unknown>): {
  accountKey: string | null;
  businessId: string | null;
  requiresAdAccount: boolean;
  args: string[];
  label: string;
} {
  const resource = normalizeMetaResource(requireMetaString(args, "resource"));
  const action = optionalMetaEnum(args, "action", ["get", "list", "current"]) ?? (resource === "insights" ? "get" : "list");
  if (action === "current" && resource !== "adaccount") throw new Error("current は adaccount のみ対応しています");
  const accountKey = readMetaStringArg(args, "accountKey", "account_key");
  const businessId = readMetaStringArg(args, "businessId", "business_id");
  const out = ["--output", "json", "ads"];
  if (businessId) out.push("--business-id", businessId);
  if (resource === "insights") {
    if (action !== "get") throw new Error("insights は get のみ対応しています");
    out.push("insights", "get");
    const fields = readStringArray(args.fields);
    out.push("--fields", (fields.length ? fields : ["spend", "impressions", "clicks", "ctr", "cpc", "reach", "frequency", "cpm", "cpp", "actions"]).join(","));
    const datePreset = optionalMetaEnumValue(readMetaStringArg(args, "datePreset", "date_preset"), "datePreset", [
      "today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d", "last_90d", "this_month", "last_month",
    ]);
    if (datePreset) out.push("--date-preset", datePreset);
    pushMetaOptional(out, "--since", readMetaStringArg(args, "since"));
    pushMetaOptional(out, "--until", readMetaStringArg(args, "until"));
    const timeIncrement = optionalMetaEnumValue(readMetaStringArg(args, "timeIncrement", "time_increment"), "timeIncrement", ["daily", "weekly", "monthly", "all_days"]);
    if (timeIncrement) out.push("--time-increment", timeIncrement);
    const breakdowns = readStringArray(args.breakdowns).concat(readStringArray(args.breakdown));
    for (const breakdown of breakdowns) out.push("--breakdown", breakdown);
    pushMetaOptional(out, "--campaign-id", readMetaStringArg(args, "campaignId", "campaign_id"));
    pushMetaOptional(out, "--adset-id", readMetaStringArg(args, "adsetId", "adset_id"));
    pushMetaOptional(out, "--ad-id", readMetaStringArg(args, "adId", "ad_id"));
    pushMetaOptional(out, "--sort", args.sort);
    const limit = readPositiveInt(args.limit);
    if (limit) out.push("--limit", String(Math.min(limit, 100)));
    return { accountKey, businessId, requiresAdAccount: true, args: out, label: "insights" };
  }
  out.push(metaResourceCommand(resource), action);
  if (action === "current") return { accountKey, businessId, requiresAdAccount: false, args: out, label: "adaccount current" };
  if (action === "get") {
    const id = readMetaResourceId(resource, args);
    if (!id && resource !== "adaccount") throw new Error(`${metaResourceCommand(resource)} get には id が必要です`);
    if (id) out.push(id);
  } else {
    const parentId =
      resource === "adset"
        ? readMetaStringArg(args, "campaignId", "campaign_id")
        : resource === "ad"
          ? readMetaStringArg(args, "adsetId", "adset_id")
          : null;
    if (parentId) out.push(parentId);
    if (resource === "product_feed" || resource === "product_item" || resource === "product_set") {
      const catalogId = readMetaStringArg(args, "catalogId", "catalog_id");
      if (!catalogId) throw new Error(`${metaResourceCommand(resource)} list には catalogId が必要です`);
      out.push("--catalog-id", catalogId);
    }
    const limit = readPositiveInt(args.limit);
    if (limit) out.push("--limit", String(Math.min(limit, 100)));
  }
  return {
    accountKey,
    businessId,
    requiresAdAccount: resourceRequiresAdAccount(resource, businessId),
    args: out,
    label: `${metaResourceCommand(resource)} ${action}`,
  };
}

async function prepareMetaAdsCliRuntime(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  accountKey: string | null;
  requiresAdAccount: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<{ binaryPath: string; accessToken: string; adAccountId: string | null }> {
  const binaryPath = opts.env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) throw new Error("ADDROID_META_CLI_BIN が未設定です");
  const token = await opts.prisma.oAuthToken.findFirst({
    where: { provider: "meta" },
    orderBy: { connectedAt: "desc" },
    select: { accessTokenCiphertext: true },
  });
  if (!token) throw new Error("Meta token が未接続です。");
  const account = opts.accountKey
    ? await opts.prisma.adAccount.findFirst({
        where: { workspaceId: opts.workspaceId, OR: [{ key: opts.accountKey }, { metaAccountId: opts.accountKey }] },
        orderBy: { updatedAt: "desc" },
        select: { key: true, metaAccountId: true },
      })
    : await opts.prisma.adAccount.findFirst({
        where: { workspaceId: opts.workspaceId, active: true },
        orderBy: { updatedAt: "desc" },
        select: { key: true, metaAccountId: true },
      });
  const adAccountId = account?.metaAccountId ?? account?.key ?? opts.accountKey;
  if (!adAccountId && opts.requiresAdAccount) throw new Error("広告アカウントが選択されていません。");
  return {
    binaryPath,
    accessToken: getCryptoBoundary(opts.env).decrypt(token.accessTokenCiphertext),
    adAccountId: adAccountId ?? null,
  };
}

function spawnMetaAdsCli(input: {
  binaryPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, input.args, {
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type MetaReadOnlyResource =
  | "insights" | "adaccount" | "campaign" | "adset" | "ad" | "creative"
  | "catalog" | "dataset" | "page" | "product_feed" | "product_item" | "product_set";

function normalizeMetaResource(value: string): MetaReadOnlyResource {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const allowed: MetaReadOnlyResource[] = ["insights", "adaccount", "campaign", "adset", "ad", "creative", "catalog", "dataset", "page", "product_feed", "product_item", "product_set"];
  if (allowed.includes(normalized as MetaReadOnlyResource)) return normalized as MetaReadOnlyResource;
  throw new Error(`resource は ${allowed.join(" / ")} のいずれかで指定してください`);
}

function metaResourceCommand(resource: MetaReadOnlyResource): string {
  return resource.replace(/_/g, "-");
}

function resourceRequiresAdAccount(resource: MetaReadOnlyResource, businessId: string | null): boolean {
  if (resource === "adaccount" || resource === "page") return false;
  if ((resource === "catalog" || resource === "dataset") && businessId) return false;
  if (resource === "product_feed" || resource === "product_item" || resource === "product_set") return false;
  return true;
}

function readMetaResourceId(resource: MetaReadOnlyResource, args: Record<string, unknown>): string | null {
  const keys: Partial<Record<MetaReadOnlyResource, string[]>> = {
    adaccount: ["accountId", "account_id", "adAccountId", "ad_account_id"],
    campaign: ["campaignId", "campaign_id"],
    adset: ["adsetId", "adset_id"],
    ad: ["adId", "ad_id"],
    creative: ["creativeId", "creative_id"],
    catalog: ["catalogId", "catalog_id"],
    dataset: ["datasetId", "dataset_id", "pixelId", "pixel_id"],
    page: ["pageId", "page_id"],
    product_feed: ["productFeedId", "product_feed_id"],
    product_item: ["productItemId", "product_item_id"],
    product_set: ["productSetId", "product_set_id"],
  };
  for (const key of keys[resource] ?? []) {
    const value = readOptionalString(args[key]);
    if (value) return value;
  }
  return readOptionalString(args.id);
}

function requireMetaString(args: Record<string, unknown>, key: string): string {
  const value = readOptionalString(args[key]);
  if (!value) throw new Error(`${key} を指定してください`);
  return value;
}

function readMetaStringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = readOptionalString(args[key]);
    if (value) return value;
  }
  return null;
}

function optionalMetaEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | null {
  return optionalMetaEnumValue(readOptionalString(args[key]), key, allowed);
}

function optionalMetaEnumValue<T extends string>(value: string | null, key: string, allowed: readonly T[]): T | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T;
  throw new Error(`${key} は ${allowed.join(" / ")} のいずれかで指定してください`);
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []) : [];
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function pushMetaOptional(out: string[], flag: string, value: unknown): void {
  const text = readOptionalString(value);
  if (text) out.push(flag, text);
}

function sanitizeMetaCliText(text: string, token: string): string {
  return text.split(token).join("[REDACTED]").trim().slice(0, 1200);
}

function parseUnknownJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function extractUnknownRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return [];
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

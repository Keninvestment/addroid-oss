// AdDroid OSS — Meta Ads CLI backed daily-report insights provider.
//
// This provider keeps the current DailyReportInsightsProvider contract intact
// while using the official CLI command surface as the primary read path.

import { spawn as nodeSpawn } from "node:child_process";
import {
  fetchInsights,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliUnsupportedOperationError,
  MetaCliVersionUnverifiedError,
  type MetaAdapter,
  type MetaCliExecutionResult,
  type MetaCliRunnerOptions,
  type MetaCliVersionVerification,
} from "@addroid/meta-adapter";
import {
  enabledBreakdownLevels,
  subtractOneUtcDay,
  type DailyReportInsightsProvider,
  type DailyReportInsightsRequest,
  type DailyReportInsightsResponse,
  type DailyReportInsightsRow,
  type DailyReportNodeType,
} from "@addroid/queue";
import { META_CLI_MIN_VERSION } from "./apply-meta-executor.js";

export interface MetaCliDailyReportInsightsProviderOptions {
  runner: Pick<MetaCliRunner, "run">;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null | undefined>;
  fields?: string[];
  conversionActionTypes?: string[];
  timeoutMs?: number;
}

export class MetaCliDailyReportInsightsProvider implements DailyReportInsightsProvider {
  private readonly runner: Pick<MetaCliRunner, "run">;
  private readonly resolveAdAccountId:
    | ((accountKey: string) => Promise<string | null | undefined>)
    | undefined;
  private readonly fields: string[];
  private readonly conversionActionTypes: string[];
  private readonly timeoutMs: number;

  constructor(opts: MetaCliDailyReportInsightsProviderOptions) {
    this.runner = opts.runner;
    this.resolveAdAccountId = opts.resolveAdAccountId;
    this.fields = opts.fields ?? [
      "spend",
      "impressions",
      "clicks",
      "conversions",
      "actions",
      "frequency",
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "ad_id",
      "ad_name",
      "account_id",
      "account_name",
    ];
    this.conversionActionTypes = opts.conversionActionTypes ?? [
      "purchase",
      "lead",
      "complete_registration",
      "offsite_conversion",
      "omni_purchase",
    ];
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async fetchInsights(
    req: DailyReportInsightsRequest
  ): Promise<DailyReportInsightsResponse> {
    const levels = enabledBreakdownLevels(req.breakdownsPolicy ?? {
      fetchAccount: true,
      fetchCampaign: true,
      fetchAdset: true,
      fetchAd: true,
      synthesizeAccountFromCampaigns: true,
    });
    const adAccountId = this.resolveAdAccountId
      ? await this.resolveAdAccountId(req.accountKey)
      : null;
    const current: DailyReportInsightsRow[] = [];
    const prior: DailyReportInsightsRow[] = [];
    const details: string[] = [];

    try {
      for (const level of levels) {
        const currentResult = await this.fetchPeriod({
          accountKey: req.accountKey,
          adAccountId,
          level,
          metricDate: req.metricDate,
        });
        current.push(...currentResult.rows);
        details.push(currentResult.detail);
        if (req.includePriorPeriod) {
          const priorDate = subtractOneUtcDay(req.metricDate);
          const priorResult = await this.fetchPeriod({
            accountKey: req.accountKey,
            adAccountId,
            level,
            metricDate: priorDate,
          });
          prior.push(...priorResult.rows);
          details.push(priorResult.detail);
        }
      }
    } catch (err) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: summarizeCliInsightsError(err),
      };
    }

    return {
      current,
      prior,
      source: "meta_ads_cli",
      detail: details.filter(Boolean).join("; "),
    };
  }

  private async fetchPeriod(input: {
    accountKey: string;
    adAccountId?: string | null;
    level: DailyReportNodeType;
    metricDate: string;
  }): Promise<{ rows: DailyReportInsightsRow[]; detail: string }> {
    const args = [
      "--output",
      "json",
      "ads",
      "insights",
      "get",
      "--fields",
      this.fields.join(","),
      "--level",
      input.level,
      "--time-range",
      JSON.stringify({ since: input.metricDate, until: input.metricDate }),
      "--no-input",
    ];
    const result = await this.runner.run({
      accountKey: input.accountKey,
      adAccountId: input.adAccountId ?? null,
      args,
      timeoutMs: this.timeoutMs,
    });
    if (result.exitClass !== "success") {
      throw new Error(
        `meta ads insights get failed for ${input.level}/${input.metricDate}: ${result.exitClass}`
      );
    }
    return {
      rows: parseInsightsRows(result, input.level, this.conversionActionTypes),
      detail: `${input.level}/${input.metricDate}: ${result.exitClass}`,
    };
  }
}

export class GraphApiDailyReportInsightsProvider implements DailyReportInsightsProvider {
  private readonly metaAdapter: MetaAdapter;
  private readonly resolveAdAccountId:
    | ((accountKey: string) => Promise<string | null | undefined>)
    | undefined;
  private readonly fields: string[];
  private readonly conversionActionTypes: string[];

  constructor(opts: {
    metaAdapter: MetaAdapter;
    resolveAdAccountId?: (accountKey: string) => Promise<string | null | undefined>;
    fields?: string[];
    conversionActionTypes?: string[];
  }) {
    this.metaAdapter = opts.metaAdapter;
    this.resolveAdAccountId = opts.resolveAdAccountId;
    this.fields = opts.fields ?? [
      "spend",
      "impressions",
      "clicks",
      "conversions",
      "actions",
      "frequency",
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "ad_id",
      "ad_name",
      "account_id",
      "account_name",
    ];
    this.conversionActionTypes = opts.conversionActionTypes ?? [
      "purchase",
      "lead",
      "complete_registration",
      "offsite_conversion",
      "omni_purchase",
    ];
  }

  async fetchInsights(
    req: DailyReportInsightsRequest
  ): Promise<DailyReportInsightsResponse> {
    const lease = await this.metaAdapter.loadAccessTokenPlaintext();
    if (!lease) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: "Meta access token is missing; reconnect Meta.",
      };
    }
    const adAccountId = this.resolveAdAccountId
      ? await this.resolveAdAccountId(req.accountKey)
      : req.accountKey;
    if (!adAccountId) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: "Meta ad account id is missing.",
      };
    }
    const levels = enabledBreakdownLevels(req.breakdownsPolicy ?? {
      fetchAccount: true,
      fetchCampaign: true,
      fetchAdset: true,
      fetchAd: true,
      synthesizeAccountFromCampaigns: true,
    });
    const current: DailyReportInsightsRow[] = [];
    const prior: DailyReportInsightsRow[] = [];
    try {
      for (const level of levels) {
        const rows = await fetchInsights({
          accessToken: lease.accessToken,
          adAccountId,
          fields: this.fields,
          level,
          timeRange: { since: req.metricDate, until: req.metricDate },
        });
        current.push(
          ...parseInsightsPayload(rows, level, this.conversionActionTypes)
        );
        if (req.includePriorPeriod) {
          const priorDate = subtractOneUtcDay(req.metricDate);
          const priorRows = await fetchInsights({
            accessToken: lease.accessToken,
            adAccountId,
            fields: this.fields,
            level,
            timeRange: { since: priorDate, until: priorDate },
          });
          prior.push(
            ...parseInsightsPayload(priorRows, level, this.conversionActionTypes)
          );
        }
      }
    } catch (err) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: err instanceof Error ? err.message : "Meta Graph insights failed.",
      };
    }
    return {
      current,
      prior,
      source: "graph_api",
      detail: "Meta Graph API insights fallback",
    };
  }
}

export interface ResolveMetaCliInsightsProviderOptions {
  metaAdapter: MetaAdapter;
  env?: NodeJS.ProcessEnv;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null | undefined>;
  spawnImpl?: MetaCliRunnerOptions["spawnImpl"];
  versionResolver?: MetaCliRunnerOptions["versionResolver"];
}

export interface MetaCliInsightsProviderSelection {
  provider: DailyReportInsightsProvider | null;
  mode: "cli" | "graph_api" | "unconfigured";
  reason: string;
  versionVerification?: MetaCliVersionVerification;
}

export async function resolveMetaCliInsightsProvider(
  opts: ResolveMetaCliInsightsProviderOptions
): Promise<MetaCliInsightsProviderSelection> {
  const env = opts.env ?? process.env;
  const binaryPath = env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) {
    if (env.ADDROID_META_GRAPH_INSIGHTS_FALLBACK === "1") {
      return {
        provider: new GraphApiDailyReportInsightsProvider({
          metaAdapter: opts.metaAdapter,
          ...(opts.resolveAdAccountId ? { resolveAdAccountId: opts.resolveAdAccountId } : {}),
        }),
        mode: "graph_api",
        reason:
          "ADDROID_META_CLI_BIN is not set; ADDROID_META_GRAPH_INSIGHTS_FALLBACK=1 selects Graph API read fallback",
      };
    }
    return {
      provider: null,
      mode: "unconfigured",
      reason: "ADDROID_META_CLI_BIN is not set; daily_report insights use mock provider",
    };
  }
  const runner = new MetaCliRunner({
    binaryPath,
    spawnImpl: opts.spawnImpl ?? nodeSpawn,
    minVersion: META_CLI_MIN_VERSION,
    requireVerifiedVersion: true,
    loadTokenForAccount: async () => {
      const lease = await opts.metaAdapter.loadAccessTokenPlaintext();
      if (!lease) return null;
      return { accessToken: lease.accessToken };
    },
    ...(opts.versionResolver ? { versionResolver: opts.versionResolver } : {}),
  });
  const verification = await runner.verifyVersion();
  return {
    provider: new MetaCliDailyReportInsightsProvider({
      runner,
      ...(opts.resolveAdAccountId ? { resolveAdAccountId: opts.resolveAdAccountId } : {}),
    }),
    mode: "cli",
    versionVerification: verification,
    reason: verification.ok
      ? `using meta-ads-cli at ${binaryPath} for insights (${verification.detail})`
      : `meta-ads-cli at ${binaryPath} failed version verification (${verification.detail}); insights will fail closed`,
  };
}

function parseInsightsRows(
  result: MetaCliExecutionResult,
  fallbackLevel: DailyReportNodeType,
  conversionActionTypes: readonly string[]
): DailyReportInsightsRow[] {
  const payload = parseJson(result.stdout);
  return parseInsightsPayload(payload, fallbackLevel, conversionActionTypes);
}

function parseInsightsPayload(
  payload: unknown,
  fallbackLevel: DailyReportNodeType,
  conversionActionTypes: readonly string[]
): DailyReportInsightsRow[] {
  const rows = extractArray(payload);
  const out: DailyReportInsightsRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const level = inferLevel(row, fallbackLevel);
    const nodeKey = inferNodeKey(row, level);
    if (!nodeKey) continue;
    out.push({
      nodeType: level,
      nodeKey,
      displayName: inferDisplayName(row, level) ?? undefined,
      spendMicros: majorToMicros(numberField(row, "spend")),
      impressions: integerField(row, "impressions"),
      clicks: integerField(row, "clicks"),
      conversions: extractConversions(row, conversionActionTypes),
      frequency: nullableNumberField(row, "frequency"),
    });
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return [];
}

function inferLevel(
  row: Record<string, unknown>,
  fallback: DailyReportNodeType
): DailyReportNodeType {
  const level = stringField(row, "level")?.toLowerCase();
  if (level === "account" || level === "campaign" || level === "adset" || level === "ad") {
    return level;
  }
  if (stringField(row, "ad_id")) return "ad";
  if (stringField(row, "adset_id")) return "adset";
  if (stringField(row, "campaign_id")) return "campaign";
  return fallback;
}

function inferNodeKey(
  row: Record<string, unknown>,
  level: DailyReportNodeType
): string | null {
  if (level === "ad") return stringField(row, "ad_id") ?? stringField(row, "id");
  if (level === "adset") return stringField(row, "adset_id") ?? stringField(row, "id");
  if (level === "campaign") return stringField(row, "campaign_id") ?? stringField(row, "id");
  return stringField(row, "account_id") ?? stringField(row, "id") ?? "account";
}

function inferDisplayName(
  row: Record<string, unknown>,
  level: DailyReportNodeType
): string | null {
  if (level === "ad") return stringField(row, "ad_name") ?? stringField(row, "name");
  if (level === "adset") return stringField(row, "adset_name") ?? stringField(row, "name");
  if (level === "campaign") return stringField(row, "campaign_name") ?? stringField(row, "name");
  return stringField(row, "account_name") ?? stringField(row, "name");
}

function extractConversions(
  row: Record<string, unknown>,
  actionTypes: readonly string[]
): number {
  const direct = numberField(row, "conversions");
  if (direct > 0) return Math.floor(direct);
  const actions = row.actions;
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const type = stringField(action, "action_type");
    if (!type) continue;
    if (actionTypes.some((needle) => type.includes(needle))) {
      total += numberField(action, "value");
    }
  }
  return Math.floor(total);
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberField(row: Record<string, unknown>, key: string): number {
  return nullableNumberField(row, key) ?? 0;
}

function nullableNumberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function integerField(row: Record<string, unknown>, key: string): number {
  return Math.max(0, Math.floor(numberField(row, key)));
}

function majorToMicros(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeCliInsightsError(err: unknown): string {
  if (err instanceof MetaCliVersionUnverifiedError) {
    return "Meta Ads CLI version is not verified for insights.";
  }
  if (err instanceof MetaCliMissingTokenError) {
    return "Meta access token is missing; reconnect Meta.";
  }
  if (err instanceof MetaCliUnsupportedOperationError) {
    return "Meta Ads CLI insights operation is not in the verified command matrix.";
  }
  return err instanceof Error ? err.message : "Meta Ads CLI insights failed.";
}

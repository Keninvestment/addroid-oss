// AdDroid OSS — Automation planned action to Meta Graph API mutation boundary.
//
// The rule engine only returns planned actions. This module is the narrow
// worker-side adapter that can turn an approved action into a CLI invocation.

import {
  META_GRAPH_API_VERSION,
  MetaAdapterUnauthenticatedError,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliUnsupportedOperationError,
  MetaCliVersionUnverifiedError,
  MetaTokenExpiredError,
  type MetaAdapter,
  type MetaCliExecutionResult,
  type MetaCliRunnerOptions,
} from "@addroid/meta-adapter";
import type { AutomationLevel, AutomationPlannedAction } from "@addroid/queue";
import { META_CLI_MIN_VERSION } from "./apply-meta-executor.js";

export type AutomationCliMutationStatus =
  | "success"
  | "auth_error"
  | "unsupported"
  | "cli_unverified"
  | "api_error"
  | "unknown_error";

export interface AutomationCliMutationResult {
  status: AutomationCliMutationStatus;
  message: string;
  result?: MetaCliExecutionResult;
}

export interface AutomationMutationExecutor {
  execute(action: AutomationPlannedAction): Promise<AutomationCliMutationResult>;
}

export interface AutomationTargetResolver {
  resolveExternalId(input: {
    accountId: string;
    hierarchyId: string | null;
    level: AutomationLevel;
    targetKey: string;
  }): Promise<string | null>;
}

export interface AutomationCliMutationExecutorOptions {
  runner: Pick<MetaCliRunner, "run">;
  resolver: AutomationTargetResolver;
}

export interface AutomationMutationExecutorSelection {
  executor: AutomationMutationExecutor | null;
  mode: "graph" | "cli" | "mock" | "fail_closed";
  reason: string;
}

class MetaGraphAutomationError extends Error {
  readonly status: AutomationCliMutationStatus;
  readonly httpStatus: number | null;
  constructor(message: string, opts?: { status?: AutomationCliMutationStatus; httpStatus?: number | null }) {
    super(message);
    this.name = "MetaGraphAutomationError";
    this.status = opts?.status ?? "unknown_error";
    this.httpStatus = opts?.httpStatus ?? null;
  }
}

export class AutomationGraphMutationExecutor implements AutomationMutationExecutor {
  private readonly metaAdapter: MetaAdapter;
  private readonly resolver: AutomationTargetResolver;

  constructor(opts: { metaAdapter: MetaAdapter; resolver: AutomationTargetResolver }) {
    this.metaAdapter = opts.metaAdapter;
    this.resolver = opts.resolver;
  }

  async execute(action: AutomationPlannedAction): Promise<AutomationCliMutationResult> {
    const externalId = await this.resolver.resolveExternalId({
      accountId: action.accountId,
      hierarchyId: action.hierarchyId,
      level: action.level,
      targetKey: action.targetKey,
    });
    if (!externalId) {
      return {
        status: "api_error",
        message: `automation ${action.actionType} rejected: no external id for ${action.level}:${action.targetKey}`,
      };
    }
    const payload = buildAutomationGraphPayload(action);
    if (!payload) {
      return {
        status: "unsupported",
        message: `automation action is not supported by Graph executor: ${action.actionType}`,
      };
    }
    let lease;
    try {
      lease = await this.metaAdapter.loadAccessTokenPlaintext();
    } catch (err) {
      if (
        err instanceof MetaTokenExpiredError ||
        err instanceof MetaAdapterUnauthenticatedError
      ) {
        return { status: "auth_error", message: "Meta token is missing or expired; reconnect Meta." };
      }
      throw err;
    }
    if (!lease) {
      return { status: "auth_error", message: "Meta token is missing; reconnect Meta." };
    }
    try {
      await postAutomationGraphJson(externalId, lease.accessToken, payload);
      return {
        status: "success",
        message: `automation ${action.actionType} ${action.level}:${externalId} -> graph success`,
      };
    } catch (err) {
      if (err instanceof MetaGraphAutomationError) {
        return {
          status: err.status,
          message: `automation ${action.actionType} ${action.level}:${externalId} -> ${err.message}`,
        };
      }
      return {
        status: "unknown_error",
        message: err instanceof Error ? err.message : "automation mutation failed",
      };
    }
  }
}

export class AutomationCliMutationExecutor {
  private readonly runner: Pick<MetaCliRunner, "run">;
  private readonly resolver: AutomationTargetResolver;

  constructor(opts: AutomationCliMutationExecutorOptions) {
    this.runner = opts.runner;
    this.resolver = opts.resolver;
  }

  async execute(action: AutomationPlannedAction): Promise<AutomationCliMutationResult> {
    const externalId = await this.resolver.resolveExternalId({
      accountId: action.accountId,
      hierarchyId: action.hierarchyId,
      level: action.level,
      targetKey: action.targetKey,
    });
    if (!externalId) {
      return {
        status: "api_error",
        message: `automation ${action.actionType} rejected: no external id for ${action.level}:${action.targetKey}`,
      };
    }
    const args = buildAutomationCliArgs(action, externalId);
    if (!args) {
      return {
        status: "unsupported",
        message: `automation action is not supported by CLI executor: ${action.actionType}`,
      };
    }
    try {
      const result = await this.runner.run({
        accountKey: action.accountKey ?? action.accountId,
        args,
        timeoutMs: 120_000,
      });
      return {
        status: result.exitClass === "success" ? "success" : "api_error",
        message: `automation ${action.actionType} ${action.level}:${externalId} -> ${result.exitClass}`,
        result,
      };
    } catch (err) {
      if (err instanceof MetaCliMissingTokenError) {
        return { status: "auth_error", message: "Meta token is missing; reconnect Meta." };
      }
      if (err instanceof MetaCliVersionUnverifiedError) {
        return {
          status: "cli_unverified",
          message: "Meta Ads CLI version is not verified for automation mutations.",
        };
      }
      if (err instanceof MetaCliUnsupportedOperationError) {
        return {
          status: "unsupported",
          message: "Meta Ads CLI operation is not in the verified command matrix.",
        };
      }
      return {
        status: "unknown_error",
        message: err instanceof Error ? err.message : "automation mutation failed",
      };
    }
  }
}

export function buildAutomationCliArgs(
  action: AutomationPlannedAction,
  externalId: string
): string[] | null {
  const singular = cliSingularResource(action.level);
  if (!singular) return null;

  if (action.actionType === "set_status") {
    const status = typeof action.payload.status === "string" ? action.payload.status : "";
    if (status !== "PAUSED" && status !== "ACTIVE") return null;
    return [
      "ads",
      singular,
      "update",
      externalId,
      "--status",
      status,
      "--no-input",
      "--force",
    ];
  }

  if (action.actionType === "adjust_budget") {
    const proposed = action.payload.proposedDailyBudget;
    if (typeof proposed !== "number" || !Number.isFinite(proposed) || proposed <= 0) {
      return null;
    }
    return [
      "ads",
      singular,
      "update",
      externalId,
      "--changes",
      JSON.stringify({ daily_budget: proposed }),
      "--no-input",
      "--force",
    ];
  }

  return null;
}

export function buildAutomationGraphPayload(
  action: AutomationPlannedAction
): Record<string, unknown> | null {
  if (action.actionType === "set_status") {
    const status = typeof action.payload.status === "string" ? action.payload.status : "";
    if (status !== "PAUSED" && status !== "ACTIVE") return null;
    return { status };
  }

  if (action.actionType === "adjust_budget") {
    const proposed = action.payload.proposedDailyBudget;
    if (typeof proposed !== "number" || !Number.isFinite(proposed) || proposed <= 0) {
      return null;
    }
    return { daily_budget: Math.round(proposed) };
  }

  return null;
}

async function postAutomationGraphJson(
  externalId: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") form.set(key, JSON.stringify(value));
    else if (typeof value === "boolean") form.set(key, value ? "true" : "false");
    else form.set(key, String(value));
  }
  const res = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${externalId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) throw automationGraphError(res.status, json);
}

function automationGraphError(status: number, json: unknown): MetaGraphAutomationError {
  const error =
    typeof json === "object" &&
    json !== null &&
    !Array.isArray(json) &&
    typeof (json as { error?: unknown }).error === "object" &&
    (json as { error?: unknown }).error !== null
      ? ((json as { error: Record<string, unknown> }).error)
      : null;
  const code = typeof error?.code === "number" ? error.code : null;
  const message =
    typeof error?.message === "string"
      ? error.message
      : `Meta Graph API returned HTTP ${status}`;
  return new MetaGraphAutomationError(message, {
    status: classifyAutomationGraphError(status, code),
    httpStatus: status,
  });
}

function classifyAutomationGraphError(status: number, code: number | null): AutomationCliMutationStatus {
  if (status === 401 || code === 190 || code === 102 || code === 104 || code === 463 || code === 467) {
    return "auth_error";
  }
  if (status >= 400 && status < 500) return "api_error";
  return "unknown_error";
}

export async function resolveAutomationMutationExecutor(opts: {
  env?: NodeJS.ProcessEnv;
  metaAdapter: MetaAdapter;
  resolver: AutomationTargetResolver;
  spawnImpl?: MetaCliRunnerOptions["spawnImpl"];
  versionResolver?: MetaCliRunnerOptions["versionResolver"];
}): Promise<AutomationMutationExecutorSelection> {
  const env = opts.env ?? process.env;
  if (env.ADDROID_META_ADS_CLI_MOCK !== "1") {
    return {
      executor: new AutomationGraphMutationExecutor({
        metaAdapter: opts.metaAdapter,
        resolver: opts.resolver,
      }),
      mode: "graph",
      reason:
        "using Meta Graph API as canonical automation mutation route; Meta Ads CLI is optional diagnostic/future backend only",
    };
  }
  const binaryPath = env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) {
    if (env.ADDROID_META_ADS_CLI_MOCK === "1") {
      return {
        executor: new AutomationCliMutationExecutor({
          runner: {
            async run(): Promise<MetaCliExecutionResult> {
              const now = new Date().toISOString();
              return {
                exitClass: "success",
                exitCode: 0,
                signal: null,
                stdout: JSON.stringify({ ok: true, mock: true }),
                stderr: "",
                sanitizedCommand: "meta <automation-mock>",
                sanitizedArgs: ["<automation-mock>"],
                throttleHeaders: null,
                durationMs: 0,
                startedAt: now,
                finishedAt: now,
                timedOut: false,
                accountKey: "mock",
                binary: "meta",
                recommendedAction: {
                  kind: "none",
                  retry: false,
                  notify: "none",
                  logLevel: "info",
                  reason: "mock automation success",
                },
              };
            },
          },
          resolver: opts.resolver,
        }),
        mode: "mock",
        reason:
          "ADDROID_META_CLI_BIN is not set; ADDROID_META_ADS_CLI_MOCK=1 selects the local-test automation mock executor",
      };
    }
    return {
      executor: null,
      mode: "fail_closed",
      reason:
        "ADDROID_META_CLI_BIN is not set and ADDROID_META_ADS_CLI_MOCK is not '1'; automation mutations fail closed",
    };
  }
  const runner = new MetaCliRunner({
    binaryPath,
    spawnImpl: opts.spawnImpl,
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
    executor: new AutomationCliMutationExecutor({ runner, resolver: opts.resolver }),
    mode: "cli",
    reason: verification.ok
      ? `using meta-ads-cli at ${binaryPath} (${verification.detail})`
      : `meta-ads-cli at ${binaryPath} failed version verification (${verification.detail}); automation will fail closed at execution`,
  };
}

function cliSingularResource(level: AutomationLevel): "campaign" | "adset" | "ad" | null {
  if (level === "campaign") return "campaign";
  if (level === "adset") return "adset";
  if (level === "ad") return "ad";
  return null;
}

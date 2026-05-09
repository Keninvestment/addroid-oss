// AdDroid OSS — Automation planned action to Meta Ads CLI mutation boundary.
//
// The rule engine only returns planned actions. This module is the narrow
// worker-side adapter that can turn an approved action into a CLI invocation.

import {
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliUnsupportedOperationError,
  MetaCliVersionUnverifiedError,
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
  executor: AutomationCliMutationExecutor | null;
  mode: "cli" | "mock" | "fail_closed";
  reason: string;
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

export async function resolveAutomationMutationExecutor(opts: {
  env?: NodeJS.ProcessEnv;
  metaAdapter: MetaAdapter;
  resolver: AutomationTargetResolver;
  spawnImpl?: MetaCliRunnerOptions["spawnImpl"];
  versionResolver?: MetaCliRunnerOptions["versionResolver"];
}): Promise<AutomationMutationExecutorSelection> {
  const env = opts.env ?? process.env;
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

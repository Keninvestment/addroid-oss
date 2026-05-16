// テスト共有: in-memory fake stores と fake pg-boss / github adapter。

import type {
  AccountExecutionModes,
  ApplyApprovalSnapshot,
  ApplyJobContext,
  ApplyJobStore,
  CronOpsStore,
  ExecutionLogInput,
  FailCronRunInput,
  FinishCronRunInput,
  GithubPollStore,
  MarkApplyFinishedInput,
  MarkApplyRunningInput,
  OpsRepoSnapshot,
  QueueGithubAdapter,
  QueuePollResult,
  RecordApplyAuditInput,
  RecordApplyBlockedInput,
  RecordApplyJobInput,
  RecordMergeAuditInput,
  RecordPollingStateInput,
  RecordPrApprovalInput,
  StartCronRunInput,
  UpsertAppliedAdsNodeInput,
  UpsertCronScheduleInput,
  UpsertPullRequestInput,
  WorkspaceExecutionModeContext,
} from "../store.js";
import type { ApplyJobBoss, ApplyJobSendOptions } from "../apply.js";
import type {
  AdsLoader,
  AdsLoaderInput,
  AdsLoadResult,
  ExecuteActionInput,
  ExecuteActionResult,
  MetaActionExecutor,
} from "../apply-executor.js";

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

export class FakeCronOpsStore implements CronOpsStore {
  upserts: UpsertCronScheduleInput[] = [];
  starts: (StartCronRunInput & { id: string })[] = [];
  finishes: FinishCronRunInput[] = [];
  fails: FailCronRunInput[] = [];
  logs: ExecutionLogInput[] = [];
  scheduleStates = new Map<string, "ok" | "error">();

  async upsertCronSchedule(input: UpsertCronScheduleInput) {
    this.upserts.push(input);
    return { id: id("sch") };
  }
  async startCronRun(input: StartCronRunInput) {
    const cronRunId = id("run");
    this.starts.push({ ...input, id: cronRunId });
    return { id: cronRunId };
  }
  async finishCronRun(input: FinishCronRunInput) {
    this.finishes.push(input);
    this.scheduleStates.set(input.scheduleName, "ok");
  }
  async failCronRun(input: FailCronRunInput) {
    this.fails.push(input);
    this.scheduleStates.set(input.scheduleName, "error");
  }
  async recordExecutionLog(input: ExecutionLogInput) {
    this.logs.push(input);
  }
}

export interface FakePullRequestRow {
  id: string;
  state: "open" | "closed" | "merged";
}

export class FakeGithubPollStore implements GithubPollStore {
  opsRepo: OpsRepoSnapshot | null = null;
  pollingStates: RecordPollingStateInput[] = [];
  prs = new Map<string, FakePullRequestRow>(); // key: `${repoId}#${number}`
  applyJobs: RecordApplyJobInput[] = [];
  mergeAudits: RecordMergeAuditInput[] = [];
  blockedApplies: RecordApplyBlockedInput[] = [];
  prApprovals: RecordPrApprovalInput[] = [];
  /**
   * regression fix: workspace executionMode + active ad_account.modeOverride
   * を返す境界の fake。既定は workspace=`proposal` / overrides=空 (= 既存
   * テストの happy path を維持する; mutate 可能な mode が観測されるため
   * github-poll の hard-lock は発動しない)。テストは `setExecutionModeContext`
   * で workspace=`report_only` 等に切り替える。
   */
  executionModeContext: WorkspaceExecutionModeContext = {
    workspaceMode: "proposal",
    accountOverrides: [],
  };

  setOpsRepo(snap: OpsRepoSnapshot | null) {
    this.opsRepo = snap;
  }

  setExecutionModeContext(ctx: WorkspaceExecutionModeContext) {
    this.executionModeContext = ctx;
  }

  async loadWorkspaceExecutionModeContext(_input: { workspaceId: string }) {
    return this.executionModeContext;
  }

  async findOpsRepo(_workspaceId: string) {
    return this.opsRepo;
  }
  async recordPollingState(input: RecordPollingStateInput) {
    this.pollingStates.push(input);
  }
  async upsertPullRequest(input: UpsertPullRequestInput) {
    const key = `${input.repoId}#${input.number}`;
    const prev = this.prs.get(key);
    const wasMerged = prev?.state === "merged";
    const isMerged = input.state === "merged";
    const transitionedToMerged = isMerged && !wasMerged;
    const row: FakePullRequestRow = { id: prev?.id ?? id("pr"), state: input.state };
    this.prs.set(key, row);
    return { id: row.id, transitionedToMerged };
  }
  async recordApplyJob(input: RecordApplyJobInput) {
    this.applyJobs.push(input);
    return { id: id("apply") };
  }
  async recordMergeAudit(input: RecordMergeAuditInput) {
    this.mergeAudits.push(input);
  }
  async recordApplyBlocked(input: RecordApplyBlockedInput) {
    this.blockedApplies.push(input);
  }
  async recordPrApproval(input: RecordPrApprovalInput) {
    this.prApprovals.push(input);
  }
  async findLatestPrApproval(input: { pullRequestId: string }) {
    // regression fix: 挿入順 (= createdAt 順) で最後に書かれた行を返す。
    for (let i = this.prApprovals.length - 1; i >= 0; i--) {
      const row = this.prApprovals[i]!;
      if (row.pullRequestId === input.pullRequestId) {
        const metadata =
          row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {};
        return {
          id: `approval-${i}`,
          decision: row.decision,
          approvedBy: row.approvedBy,
          headSha: typeof metadata.headSha === "string" ? metadata.headSha : null,
          decisionSource:
            typeof metadata.decisionSource === "string"
              ? metadata.decisionSource
              : null,
        };
      }
    }
    return null;
  }
}

export class FakeBoss implements ApplyJobBoss {
  sent: { name: string; data: unknown; options?: ApplyJobSendOptions }[] = [];
  nextJobIds: (string | null)[] = [];
  defaultJobId: string | null = "job-fake";
  /**
   * `singletonKey` ベースの "pending 中の同 key job 拒否" を fake する。true の
   * とき、既に sent された singletonKey と同じ key の send は null を返す
   * (= pg-boss の create-while-pending duplicate 抑止に相当)。
   */
  rejectDuplicateSingletons = false;

  async send(
    name: string,
    data: unknown,
    options?: ApplyJobSendOptions
  ): Promise<string | null> {
    if (
      this.rejectDuplicateSingletons &&
      options?.singletonKey &&
      this.sent.some((s) => s.options?.singletonKey === options.singletonKey)
    ) {
      this.sent.push({ name, data, ...(options ? { options } : {}) });
      return null;
    }
    this.sent.push({ name, data, ...(options ? { options } : {}) });
    if (this.nextJobIds.length > 0) {
      const v = this.nextJobIds.shift();
      return v === undefined ? this.defaultJobId : v;
    }
    return this.defaultJobId;
  }
}

export interface FakeAdapterScript {
  // 各 call の返却値、またはエラーを順に消費する
  results: (QueuePollResult | Error)[];
}

export class FakeGithubAdapter implements QueueGithubAdapter {
  calls: { spec: { owner: string; name: string; defaultBranch: string }; prev: { etag?: string } }[] = [];
  constructor(private readonly script: FakeAdapterScript) {}

  async pollPullRequests(
    spec: { owner: string; name: string; defaultBranch: string },
    prev: { etag?: string }
  ): Promise<QueuePollResult> {
    this.calls.push({ spec, prev });
    const next = this.script.results.shift();
    if (!next) {
      throw new Error("FakeGithubAdapter: no more scripted results");
    }
    if (next instanceof Error) throw next;
    return next;
  }
}

// ---------------------------------------------------------------------
// ApplyJobStore / AdsLoader / MetaActionExecutor fakes
// ---------------------------------------------------------------------

export class FakeApplyJobStore implements ApplyJobStore {
  contexts = new Map<string, ApplyJobContext>();
  /**
   * regression fix: 実行時 revalidation 用スナップショット。
   * setContext された apply_job は既定で「merged + matching accepted approval」と
   * みなす。stale / unapproved パスを試したいテストは `setApprovalSnapshot` で上書きする。
   */
  approvalSnapshots = new Map<string, ApplyApprovalSnapshot>();
  /** approvalSnapshots を明示的に null に倒すための allow-list。 */
  approvalSnapshotsCleared = new Set<string>();
  /**
   * regression fix: per-account execution mode 解決の fake 値。既定は
   * workspace=`proposal` / overrides=空 (= 既存テストの happy path を維持)。
   * テストは `setExecutionModeContext` で `report_only` / per-account override
   * を仕込み、Meta executor 直前の fail-closed を観測する。
   */
  executionModeContext: AccountExecutionModes = {
    workspaceMode: "proposal",
    overrideByAccountKey: {},
  };
  /** loadAccountExecutionModes に渡された accountKeys を順に記録する。 */
  loadAccountExecutionModesCalls: { workspaceId: string; accountKeys: readonly string[] }[] = [];
  runningCalls: MarkApplyRunningInput[] = [];
  finishedCalls: MarkApplyFinishedInput[] = [];
  executionLogs: ExecutionLogInput[] = [];
  audits: RecordApplyAuditInput[] = [];
  /**
   * regression fix: ads_hierarchy への upsert 入力を順に記録する。
   * テストでは externalId / lastCommitSha / parent 解決の正しさを assert する。
   */
  appliedAdsNodes: UpsertAppliedAdsNodeInput[] = [];
  /** `upsertAppliedAdsNode` を強制 throw させたいテスト用フラグ。 */
  failNextAppliedAdsNodeUpsert: Error | null = null;

  setContext(applyJobId: string, ctx: ApplyJobContext) {
    this.contexts.set(applyJobId, ctx);
  }

  /** 明示的に execution mode context を設定する (regression fix)。 */
  setExecutionModeContext(ctx: AccountExecutionModes) {
    this.executionModeContext = ctx;
  }

  async loadAccountExecutionModes(input: {
    workspaceId: string;
    accountKeys: readonly string[];
  }): Promise<AccountExecutionModes> {
    this.loadAccountExecutionModesCalls.push({
      workspaceId: input.workspaceId,
      accountKeys: [...input.accountKeys],
    });
    return this.executionModeContext;
  }

  /** 明示的に approval snapshot を設定する (regression fix)。 */
  setApprovalSnapshot(
    applyJobId: string,
    snapshot: ApplyApprovalSnapshot | null
  ) {
    if (snapshot === null) {
      this.approvalSnapshots.delete(applyJobId);
      this.approvalSnapshotsCleared.add(applyJobId);
    } else {
      this.approvalSnapshotsCleared.delete(applyJobId);
      this.approvalSnapshots.set(applyJobId, snapshot);
    }
  }

  async findApplyJobContext(applyJobId: string): Promise<ApplyJobContext | null> {
    return this.contexts.get(applyJobId) ?? null;
  }
  async loadApplyApprovalSnapshot(
    applyJobId: string
  ): Promise<ApplyApprovalSnapshot | null> {
    if (this.approvalSnapshotsCleared.has(applyJobId)) return null;
    const explicit = this.approvalSnapshots.get(applyJobId);
    if (explicit) return explicit;
    // 既定: setContext された apply_job は happy-path snapshot を返す。
    // これにより regression fix の追加チェックが既存テストの挙動を変えない。
    if (!this.contexts.has(applyJobId)) return null;
    return {
      pullRequestState: "merged",
      pullRequestHeadSha: "sha-default",
      latestApprovalDecision: "approved",
      // regression fix: 既定 happy-path snapshot にも approvalRecordId を載せる。
      // 値は apply_job ごとに決定的に組み立てる (テストが context 経由で参照する
      // ことを想定)。明示的に setApprovalSnapshot を呼ぶテストはこの値を上書きする。
      approvalRecordId: `appr-default-${applyJobId}`,
      approvalRecordHeadSha: "sha-default",
      approvalDecisionSource: "web_merge",
      mergedAt: new Date("2026-05-01T00:00:00Z"),
    };
  }
  async markApplyRunning(input: MarkApplyRunningInput) {
    this.runningCalls.push(input);
  }
  async markApplyFinished(input: MarkApplyFinishedInput) {
    this.finishedCalls.push(input);
  }
  async recordApplyExecutionLog(input: ExecutionLogInput) {
    this.executionLogs.push(input);
  }
  async recordApplyAudit(input: RecordApplyAuditInput) {
    this.audits.push(input);
  }
  async upsertAppliedAdsNode(
    input: UpsertAppliedAdsNodeInput
  ): Promise<{ id: string }> {
    if (this.failNextAppliedAdsNodeUpsert) {
      const err = this.failNextAppliedAdsNodeUpsert;
      this.failNextAppliedAdsNodeUpsert = null;
      throw err;
    }
    this.appliedAdsNodes.push(input);
    return { id: id("hier") };
  }
}

export class FakeAdsLoader implements AdsLoader {
  calls: AdsLoaderInput[] = [];
  result: AdsLoadResult | Error;
  constructor(result: AdsLoadResult | Error) {
    this.result = result;
  }
  async loadForApply(input: AdsLoaderInput): Promise<AdsLoadResult> {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

/**
 * 連番でレスポンスを返す MetaActionExecutor テスト用 fake。
 * `responses` を attempt 順に消費する (足りなければ最後の値を再利用)。
 */
export class FakeMetaActionExecutor implements MetaActionExecutor {
  calls: ExecuteActionInput[] = [];
  responses: ExecuteActionResult[];
  /** 例外を投げさせたい場合に true。 */
  throwOnNext = false;

  constructor(responses: ExecuteActionResult[] = []) {
    this.responses = responses;
  }

  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    this.calls.push(input);
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new Error("FakeMetaActionExecutor: scripted throw");
    }
    if (this.responses.length === 0) {
      // regression fix: create_* の default success にも deterministic な
      // externalId を載せる。これがないと runExecuteApply の create_* fail-closed
      // ガードが既定 fake を fail させ、無関係なテストが落ちる。
      return defaultSuccess(input);
    }
    if (this.responses.length === 1) {
      return this.responses[0]!;
    }
    return this.responses.shift()!;
  }
}

function defaultSuccess(input: ExecuteActionInput): ExecuteActionResult {
  const out: ExecuteActionResult = {
    status: "success",
    message: `default success for ${input.action.kind}`,
    logPayload: { default: true },
  };
  const ext = defaultExternalIdFor(input.action.kind, input.action);
  if (ext) out.externalId = ext;
  return out;
}

function defaultExternalIdFor(
  kind: ExecuteActionInput["action"]["kind"],
  action: ExecuteActionInput["action"]
): string | undefined {
  switch (kind) {
    case "create_campaign":
    case "update_campaign":
      return `fake-cmp-${(action as { campaignId: string }).campaignId}`;
    case "create_adset":
    case "update_adset":
      return `fake-as-${(action as { adsetId: string }).adsetId}`;
    case "create_ad":
    case "update_ad":
      return `fake-ad-${(action as { adId: string }).adId}`;
    case "create_creative":
    case "update_creative":
      return `fake-cr-${(action as { creativeId: string }).creativeId}`;
    default:
      return undefined;
  }
}

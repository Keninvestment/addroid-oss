import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreatePullRequestInput, GithubAdapter } from "@addroid/github-adapter";
import { toDateStringInTimeZone } from "@addroid/queue";
import {
  MockImageProvider,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageProvider,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMProvider,
} from "@addroid/llm-provider";
import {
  createCreativeSubmissionProposal,
  createStandaloneCreativeGeneration,
  normalizeCreativeSubmissionInput,
} from "../creative-submission-runtime.js";
import {
  createCreativePromotionProposal,
  normalizeCreativePromotionBatchInput,
} from "../creative-promotion-runtime.js";

test("createCreativeSubmissionProposal writes creative/ad draft through GitOps PR only", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-ops-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "cli-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "spring-sale",
        adName: "Spring Sale Ad",
        headline: "Spring Sale",
        primaryText: "Try the new offer today.",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "text",
      },
    });

    assert.equal(result.prNumber, 42);
    assert.equal(result.planOk, true);
    assert.equal(result.mediaType, "text");
    assert.equal(github.created.length, 1);
    const pr = github.created[0]!;
    assert.match(pr.title, /Ops change/);
    assert.match(pr.files[0]!.path, /^operations\/primary\/.+\.json$/);
    assert.match(pr.files[0]!.diff, /"nodeKey": "spring-sale"/);
    assert.match(pr.files[0]!.diff, /\{\{creative:spring-sale\}\}/);
    assert.match(pr.body, /Human review and PR merge are required/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal can create a new adset under an existing campaign", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-adset-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "cli-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "summer-sale",
        adName: "Summer Sale Ad",
        headline: "Summer Sale",
        primaryText: "Try the summer offer today.",
        pageId: "page_123",
        linkUrl: "https://example.com/summer",
        callToAction: "SHOP_NOW",
        campaignId: "cmp_existing",
        adsetName: "Summer JP",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        bidAmount: 3,
        startTime: "2026-06-01T00:00:00+09:00",
        endTime: "2026-06-30T23:59:59+09:00",
        pixelId: "pixel_123",
        countries: ["JP"],
        mediaType: "text",
      },
    });

    assert.equal(result.prNumber, 42);
    assert.equal(result.planOk, true);
    const pr = github.created[0]!;
    assert.match(pr.files[0]!.diff, /"nodeKey": "summer-jp"/);
    assert.match(pr.files[0]!.diff, /"Summer JP"/);
    assert.match(pr.files[0]!.diff, /"--optimization-goal"/);
    assert.match(pr.files[0]!.diff, /"link_clicks"/);
    assert.match(pr.files[0]!.diff, /"--billing-event"/);
    assert.match(pr.files[0]!.diff, /"impressions"/);
    assert.match(pr.files[0]!.diff, /"--bid-amount"/);
    assert.match(pr.files[0]!.diff, /"3"/);
    assert.match(pr.files[0]!.diff, /"pixel_123"/);
    assert.match(pr.files[0]!.diff, /"page_123"/);
    assert.match(pr.files[0]!.diff, /"https:\/\/example.com\/summer"/);
    assert.match(pr.files[0]!.diff, /"shop_now"/);
    assert.match(pr.files[0]!.diff, /\{\{creative:summer-sale\}\}/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal creates operation manifest without local brand identity state", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-identity-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "cli-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "inferred",
        adName: "Inferred Ad",
        headline: "Inferred",
        primaryText: "Use existing identity.",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "text",
      },
    });

    const diff = github.created[0]!.files[0]!.diff;
    assert.match(diff, /"nodeKey": "inferred"/);
    assert.doesNotMatch(diff, /brand\.yaml/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal no longer migrates legacy brand identity state", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-legacy-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "new-after-legacy",
        adName: "New After Legacy Ad",
        headline: "New",
        primaryText: "Create after legacy migration.",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "text",
      },
    });

    assert.equal(result.planOk, true);
    const diff = github.created[0]!.files[0]!.diff;
    assert.doesNotMatch(diff, /brand\.yaml/);
    assert.match(diff, /"nodeKey": "new-after-legacy"/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal adopts an existing Meta campaign and creates a new adset", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-adopt-campaign-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "new-set-profile",
        adName: "New Set Profile Ad",
        headline: "New Set",
        primaryText: "既存キャンペーンに新規セットで入稿",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        instagramActorId: "65414107577",
        linkUrl: "http://instagram.com/shishasin2022kumamoto",
        callToAction: "OPEN_LINK",
        campaignId: "120228334025190756",
        campaignName: "CP_SIN熊本店 縦長 - 動画 - プロフ誘導2 - CP予算",
        adsetName: "新規広告セット",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        dailyBudget: 500,
        countries: ["JP"],
        mediaType: "text",
      },
    });

    assert.equal(result.planOk, true);
    assert.match(result.planSummary, /actions=3/);
    const pr = github.created[0]!;
    assert.match(pr.files[0]!.diff, /120228334025190756/);
    assert.match(pr.files[0]!.diff, /新規広告セット/);
    assert.match(pr.files[0]!.diff, /link_clicks/);
    assert.match(pr.files[0]!.diff, /impressions/);
    assert.match(pr.files[0]!.diff, /"--daily-budget"/);
    assert.match(pr.files[0]!.diff, /"500"/);
    assert.match(pr.files[0]!.diff, /\{\{creative:new-set-profile\}\}/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal targets existing Meta campaign/adset without local brand state", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-adopt-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "profile-link",
        adName: "Profile Link Ad",
        headline: "Profile Link",
        primaryText: "プロフィールをチェック",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        instagramActorId: "65414107577",
        linkUrl: "http://instagram.com/shishasin2022kumamoto",
        callToAction: "OPEN_LINK",
        campaignId: "120228334025190756",
        adsetId: "120228334025180756",
        customEventType: "LEAD",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        mediaType: "text",
      },
    });

    assert.equal(result.planOk, true);
    assert.match(result.planSummary, /actions=2/);
    const pr = github.created[0]!;
    assert.match(pr.files[0]!.diff, /120228334025180756/);
    assert.match(pr.files[0]!.diff, /\{\{creative:profile-link\}\}/);
    assert.match(pr.files[0]!.diff, /"--instagram-actor-id"/);
    assert.match(pr.files[0]!.diff, /"65414107577"/);
    assert.doesNotMatch(pr.files[0]!.diff, /--instagram-user-id/);
    assert.doesNotMatch(pr.files[0]!.diff, /custom-event-type/);
    assert.doesNotMatch(pr.files[0]!.diff, /optimization-goal/);
    assert.doesNotMatch(pr.files[0]!.diff, /billing-event/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("normalizeCreativePromotionBatchInput drops null optional values", () => {
  const input = normalizeCreativePromotionBatchInput({
    creativeId: "4356ead2-8f2e-4cb9-a0f2-cfb0055c8666",
    campaignId: "120228334025190756",
    adsetId: "120228334025180756",
    instagramActorId: "65414107577",
    customEventType: null,
    callToAction: null,
    objective: null,
    urgency: null,
  });

  assert.equal(input.instagramActorId, "65414107577");
  assert.equal(input.customEventType, undefined);
  assert.equal(input.callToAction, undefined);
  assert.equal(input.objective, undefined);
  assert.equal(input.urgency, undefined);
});

test("createCreativePromotionProposal allows reusing a creative already attached to a PR", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-reuse-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const prisma = fakePrisma();
    let updatedParameters: unknown = null;
    const creativeApi = prisma.creative as unknown as {
      findFirst: () => Promise<Record<string, unknown>>;
      update: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    };
    creativeApi.findFirst = async () => ({
      id: "source_cr_1",
      accountId: "acct_1",
      pullRequestId: "previous_pr",
      key: "source-key",
      displayName: "Reusable Creative",
      mediaType: "text",
      status: "attached_to_pr",
      prompt: "promote this existing creative",
      parameters: {
        creativeContext: {
          target: {
            creative: {
              pageId: "281900655012835",
              linkUrl: "https://example.com/reuse",
              instagramUserId: "17841465387326763",
            },
          },
        },
        promotedToSubmissionPr: {
          prNumber: 10,
          pullRequestId: "previous_pr",
          submissionCreativeId: "old-submission",
          promotedAt: "2026-05-01T00:00:00.000Z",
        },
      },
      storagePath: null,
      spec: {
        adText: {
          headline: "Reusable",
          primaryText: "Use this creative again.",
          description: "Second submission",
          callToAction: "LEARN_MORE",
        },
      },
      account: { key: "primary", displayName: "Primary" },
      pullRequest: { number: 10, htmlUrl: "https://github.example/octo/ops/pull/10" },
    });
    creativeApi.update = async (args) => {
      updatedParameters = args.data.parameters;
      return { id: "source_cr_1" };
    };
    const github = new FakeGithubAdapter();
    const result = await createCreativePromotionProposal({
      prisma: prisma as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        creativeId: "source_cr_1",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
      },
    });

    assert.equal(result.planOk, true);
    assert.notEqual(result.creativeId, "reusable-creative");
    assert.match(result.creativeId, /^reusable-creative-submission-[a-f0-9]{8}$/);
    assert.equal(github.created.length, 1);
    assert.match(github.created[0]!.files[0]!.diff, /281900655012835/);
    assert.match(github.created[0]!.files[0]!.diff, /https:\/\/example\.com\/reuse/);
    const parameters = updatedParameters as {
      promotedToSubmissionPr?: { prNumber?: number; submissionCreativeId?: string };
      promotedToSubmissionPrHistory?: Array<{ prNumber?: number; submissionCreativeId?: string }>;
    };
    assert.equal(parameters.promotedToSubmissionPr?.prNumber, 42);
    assert.equal(parameters.promotedToSubmissionPr?.submissionCreativeId, result.creativeId);
    assert.equal(parameters.promotedToSubmissionPrHistory?.length, 2);
    assert.equal(parameters.promotedToSubmissionPrHistory?.[0]?.prNumber, 10);
    assert.equal(parameters.promotedToSubmissionPrHistory?.[1]?.prNumber, 42);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("normalizeCreativeSubmissionInput accepts account-currency budget fields", () => {
  const input = normalizeCreativeSubmissionInput({
    creativeName: "jpy-sale",
    adName: "JPY Sale Ad",
    headline: "JPY Sale",
    campaignName: "JPY Campaign",
    adsetName: "JP",
    objective: "OUTCOME_TRAFFIC",
    dailyBudget: 500,
  });

  assert.equal(input.dailyBudget, 500);
});

test("normalizeCreativeSubmissionInput maps destinationUrl to linkUrl", () => {
  const input = normalizeCreativeSubmissionInput({
    creativeName: "destination-url",
    adName: "Destination URL Ad",
    headline: "Destination",
    primaryText: "Use destinationUrl alias.",
    campaignId: "cmp_existing",
    adsetId: "as_existing",
    mediaType: "image",
    destinationUrl: "https://example.com/destination",
  });

  assert.equal(input.linkUrl, "https://example.com/destination");
});

test("createCreativeSubmissionProposal rejects link-ad creative without destination URL before opening PR", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-missing-link-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    await assert.rejects(
      createCreativeSubmissionProposal({
        prisma: fakePrisma() as never,
        githubAdapter: github as unknown as GithubAdapter,
        workspaceId: "ws_1",
        actor: "test",
        source: "web-chat",
        env: {
          ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
          ADDROID_HOME: homeDir,
        },
        input: {
          accountKey: "primary",
          creativeName: "missing-link",
          adName: "Missing Link Ad",
          headline: "Missing link",
          primaryText: "This image creative needs a destination URL.",
          campaignId: "cmp_existing",
          adsetId: "as_existing",
          mediaType: "image",
        },
      }),
      /linkUrl または destinationUrl が必要/
    );
    assert.equal(github.created.length, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal lets PR review carry business validation for zero budgets", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-dryrun-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
        prisma: fakePrisma() as never,
        githubAdapter: github as unknown as GithubAdapter,
        workspaceId: "ws_1",
        actor: "test",
        source: "web-chat",
        env: {
          ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
          ADDROID_HOME: homeDir,
        },
        input: {
          accountKey: "primary",
          creativeName: "bad-budget",
          adName: "Bad Budget Ad",
          headline: "Bad Budget",
          primaryText: "dry-run details",
          campaignName: "Bad Budget Campaign",
          adsetName: "Bad Budget Adset",
          objective: "OUTCOME_TRAFFIC",
          optimizationGoal: "LINK_CLICKS",
          billingEvent: "IMPRESSIONS",
          dailyBudget: 0,
          mediaType: "text",
        },
      });
    assert.equal(result.planOk, true);
    assert.equal(github.created.length, 1);
    assert.match(github.created[0]!.files[0]!.diff, /"--daily-budget"/);
    assert.match(github.created[0]!.files[0]!.diff, /"0"/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("normalizeCreativeSubmissionInput preserves Instagram profile Meta values", () => {
  const input = normalizeCreativeSubmissionInput({
    creativeName: "profile-visit",
    adName: "Profile Visit Ad",
    headline: "Profile Visit",
    campaignId: "cmp_existing",
    adsetName: "Profile Visit JP",
    linkUrl: "https://example.com/profile",
    callToAction: "VIEW_INSTAGRAM_PROFILE",
    optimizationGoal: "VISIT_INSTAGRAM_PROFILE",
  });

  assert.equal(input.callToAction, "VIEW_INSTAGRAM_PROFILE");
  assert.equal(input.optimizationGoal, "VISIT_INSTAGRAM_PROFILE");
});

test("normalizeCreativeSubmissionInput accepts safe Meta enum tokens without a local allowlist", () => {
  const input = normalizeCreativeSubmissionInput({
    creativeName: "future-token",
    adName: "Future Token Ad",
    headline: "Future Token",
    campaignId: "cmp_existing",
    adsetName: "Future Token JP",
    linkUrl: "https://example.com/future",
    callToAction: "call_now",
    optimizationGoal: "future_goal",
    billingEvent: "future_billing",
  });

  assert.equal(input.callToAction, "CALL_NOW");
  assert.equal(input.optimizationGoal, "FUTURE_GOAL");
  assert.equal(input.billingEvent, "FUTURE_BILLING");
});

test("createCreativeSubmissionProposal writes account-currency budget to operation manifest", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-budget-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: {
        accountKey: "primary",
        creativeName: "jpy-sale",
        adName: "JPY Sale Ad",
        headline: "JPY Sale",
        primaryText: "Try the offer today.",
        campaignName: "JPY Campaign",
        adsetName: "JP 25-44",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        dailyBudget: 500,
        countries: ["JP"],
        mediaType: "text",
      },
    });

    assert.equal(result.planOk, true);
    const pr = github.created[0]!;
    assert.match(pr.files[0]!.diff, /"--daily-budget"/);
    assert.match(pr.files[0]!.diff, /"500"/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal uses winning creative context when generating an image", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-context-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const referenceKey = "creative-submissions/primary/winner/main.png";
    fs.mkdirSync(path.join(homeDir, "storage", path.dirname(referenceKey)), { recursive: true });
    fs.writeFileSync(path.join(homeDir, "storage", referenceKey), Buffer.from("reference-png"));
    const prisma = fakePrisma() as ReturnType<typeof fakePrisma> & {
      performanceSnapshot: { findMany: () => Promise<unknown[]> };
    };
    const metricDate = toDateStringInTimeZone(new Date(), "Asia/Tokyo");
    prisma.performanceSnapshot = {
      async findMany() {
        return [
          snapshotRow({
            id: "snap_winner",
            nodeKey: "ad_winner",
            hierarchyId: "h_ad_winner",
            displayName: "Winning Ad",
            creativeRef: "winner-cr",
            metricDate,
            impressions: 1000,
            clicks: 80,
            conversions: 8,
            spendMicros: 120_000_000n,
          }),
          snapshotRow({
            id: "snap_weak",
            nodeKey: "ad_weak",
            hierarchyId: "h_ad_weak",
            displayName: "Weak Ad",
            creativeRef: "weak-cr",
            metricDate,
            impressions: 1000,
            clicks: 10,
            conversions: 0,
            spendMicros: 200_000_000n,
          }),
        ];
      },
    };
    prisma.creative.findMany = async () => [
      {
        key: "winner-cr",
        displayName: "Winner Creative",
        mediaType: "image",
        spec: {
          headline: "Best seller",
          primaryText: "The proven offer",
          callToAction: "SHOP_NOW",
          storageRef: "storage://creatives/primary/winner",
          images: [referenceKey],
        },
        prompt: "winning product-forward layout",
        provider: "mock",
        model: "placeholder-1080",
        storageRef: "storage://creatives/primary/winner",
      },
    ];
    const imageProvider = new CapturingImageProvider();
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: prisma as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      input: {
        accountKey: "primary",
        creativeName: "context-sale",
        adName: "Context Sale Ad",
        headline: "Context Sale",
        primaryText: "Try the contextual offer today.",
        prompt: "make a new sale visual",
        linkUrl: "https://example.com/context-sale",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "image",
        generateImage: true,
      },
    });

    assert.equal(result.generatedImage, true);
    assert.match(imageProvider.requests[0]!.prompt, /Winning Ad/);
    assert.match(imageProvider.requests[0]!.prompt, /Winner Creative/);
    assert.match(imageProvider.requests[0]!.prompt, /storage:\/\/creatives\/primary\/winner/);
    assert.match(imageProvider.requests[0]!.prompt, /Do not invent unrelated industries/);
    assert.equal(imageProvider.requests[0]!.referenceImages?.length ?? 0, 0);
    assert.match(imageProvider.requests[0]!.prompt, /abstract visual brief mode/);
    assert.match(github.created[0]!.files[0]!.diff, /context-sale/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal uses user referenceImagePaths as visual brief by default", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-ref-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const referencePath = path.join(rootDir, "reference.png");
    fs.writeFileSync(referencePath, Buffer.from("not-a-real-png-but-valid-test-bytes"));
    const imageProvider = new CapturingImageProvider();
    const llmProvider = new ReferenceSummaryLLMProvider();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: new FakeGithubAdapter() as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider,
      input: {
        accountKey: "primary",
        creativeName: "ref-sale",
        adName: "Ref Sale Ad",
        prompt: "添付画像の雰囲気を参考に新しい広告画像を生成",
        linkUrl: "https://example.com/ref-sale",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "image",
        generateImage: true,
        referenceImagePaths: [referencePath],
      },
    });

    assert.equal(result.generatedImage, true);
    assert.equal(imageProvider.requests[0]!.referenceImages?.length ?? 0, 0);
    assert.match(imageProvider.requests[0]!.prompt, /Reference image visual analysis/);
    assert.match(imageProvider.requests[0]!.prompt, /attached reference summary/);
    assert.match(imageProvider.requests[0]!.prompt, /abstract visual brief mode/);
    assert.match(imageProvider.requests[0]!.prompt, /Change at least two of/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal sends referenceImagePaths to provider only when prompt explicitly asks for direct image reference", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-direct-ref-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const referencePath = path.join(rootDir, "reference.png");
    fs.writeFileSync(referencePath, Buffer.from("not-a-real-png-but-valid-test-bytes"));
    const imageProvider = new CapturingImageProvider();
    const llmProvider = new ReferenceSummaryLLMProvider();
    await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: new FakeGithubAdapter() as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider,
      input: {
        accountKey: "primary",
        creativeName: "direct-ref-sale",
        adName: "Direct Ref Sale Ad",
        prompt: "この画像をベースに、Meta広告向け画像を加工して別案を生成",
        linkUrl: "https://example.com/direct-ref-sale",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "image",
        generateImage: true,
        referenceImagePaths: [referencePath],
      },
    });

    assert.equal(imageProvider.requests[0]!.referenceImages?.length, 1);
    assert.equal(imageProvider.requests[0]!.referenceImages?.[0]?.sourceRef, referencePath);
    assert.equal(imageProvider.requests[0]!.referenceImages?.[0]?.localPath, referencePath);
    assert.match(imageProvider.requests[0]!.prompt, /direct image reference mode/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createStandaloneCreativeGeneration keeps Slack-style reference images as visual brief by default", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-standalone-ref-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const referencePath = path.join(rootDir, "reference.png");
    fs.writeFileSync(referencePath, Buffer.from("not-a-real-png-but-valid-test-bytes"));
    const imageProvider = new CapturingImageProvider();
    await createStandaloneCreativeGeneration({
      prisma: fakePrisma() as never,
      workspaceId: "ws_1",
      actor: "slack:test",
      source: "slack-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider: new ReferenceSummaryLLMProvider(),
      input: {
        accountKey: "primary",
        prompt: "添付画像の雰囲気を参考に、別案の広告画像を生成",
        referenceImagePaths: [referencePath],
        variantCount: 1,
      },
    });

    assert.equal(imageProvider.requests[0]!.referenceImages?.length ?? 0, 0);
    assert.match(imageProvider.requests[0]!.prompt, /Reference image visual analysis/);
    assert.match(imageProvider.requests[0]!.prompt, /abstract visual brief mode/);
    assert.match(imageProvider.requests[0]!.prompt, /Do not reproduce the same object arrangement/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createStandaloneCreativeGeneration asks Codex to inspect an explicit landing page URL", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-landing-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const imageProvider = new CapturingImageProvider();
    const llmProvider = new LandingPageLLMProvider();
    await createStandaloneCreativeGeneration({
      prisma: fakePrisma() as never,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider,
      input: {
        accountKey: "primary",
        prompt: "遷移先LPの内容を参考に、新しい広告画像を生成",
        linkUrl: "https://example.com/landing?utm_source=test",
        variantCount: 1,
      },
    });

    assert.equal(
      llmProvider.requests.some((request) => /https:\/\/example.com\/landing\?utm_source=test/.test(request)),
      true
    );
    assert.match(imageProvider.requests[0]!.prompt, /Landing page context/);
    assert.match(imageProvider.requests[0]!.prompt, /静かなデモ予約/);
    assert.match(imageProvider.requests[0]!.prompt, /linkUrl=https:\/\/example.com\/landing/);
    assert.doesNotMatch(imageProvider.requests[0]!.prompt, /utm_source/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createStandaloneCreativeGeneration does not ask Codex to inspect private landing page URLs", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-private-landing-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const imageProvider = new CapturingImageProvider();
    const llmProvider = new LandingPageLLMProvider();
    await createStandaloneCreativeGeneration({
      prisma: fakePrisma() as never,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider,
      input: {
        accountKey: "primary",
        prompt: "遷移先LPの内容を参考に、新しい広告画像を生成",
        linkUrl: "http://127.0.0.1:3000/internal",
        variantCount: 1,
      },
    });

    assert.equal(
      llmProvider.requests.some((request) => /URL: http:\/\/127\.0\.0\.1:3000\/internal/.test(request)),
      false
    );
    assert.match(imageProvider.requests[0]!.prompt, /local\/private network URLs are not allowed/);
    assert.doesNotMatch(imageProvider.requests[0]!.prompt, /linkUrl=http:\/\/127\.0\.0\.1/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createStandaloneCreativeGeneration stores Meta ad text variants with generated images", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-text-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const imageProvider = new CapturingImageProvider();
    const prisma = fakePrisma();
    const createdData: Array<Record<string, unknown>> = [];
    const creativeApi = prisma.creative as unknown as {
      create: (args: { data: Record<string, unknown>; select?: unknown }) => Promise<{ id: string }>;
      createdData: Array<Record<string, unknown>>;
    };
    let creativeSeq = 0;
    creativeApi.createdData = createdData;
    creativeApi.create = async (args) => {
      createdData.push(args.data);
      creativeSeq += 1;
      return { id: `creative_row_text_${creativeSeq}` };
    };

    const result = await createStandaloneCreativeGeneration({
      prisma: prisma as never,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider: new CreativeTextLLMProvider(),
      input: {
        accountKey: "primary",
        prompt: "新しい体験予約向けのMeta広告画像を生成",
        variantCount: 2,
      },
    });

    assert.equal(result.generatedImage, true);
    assert.equal(createdData.length, 2);
    const spec = createdData[0]!.spec as {
      adText?: { headline?: string; primaryText?: string; description?: string; callToAction?: string };
      textVariants?: unknown[];
      metaTextRecommendations?: { primaryText?: number; headline?: number; description?: number };
    };
    assert.equal(spec.adText?.headline, "静かに相談できる予約");
    assert.equal(spec.adText?.primaryText, "落ち着いた空間で、次の体験を気軽に相談。");
    assert.equal(spec.adText?.description, "予約前に詳しく確認");
    assert.equal(spec.adText?.callToAction, "LEARN_MORE");
    assert.equal(spec.textVariants?.length, 2);
    assert.equal(spec.metaTextRecommendations?.primaryText, 125);
    assert.match(imageProvider.requests[0]!.prompt, /headline=静かに相談できる予約/);
    assert.match(imageProvider.requests[0]!.prompt, /primaryText=落ち着いた空間/);
    assert.match(result.message, /広告テキスト案/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createStandaloneCreativeGeneration sends reference image to provider only for direct-reference prompts", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-standalone-direct-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const referencePath = path.join(rootDir, "reference.png");
    fs.writeFileSync(referencePath, Buffer.from("not-a-real-png-but-valid-test-bytes"));
    const imageProvider = new CapturingImageProvider();
    await createStandaloneCreativeGeneration({
      prisma: fakePrisma() as never,
      workspaceId: "ws_1",
      actor: "slack:test",
      source: "slack-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      imageProvider,
      llmProvider: new ReferenceSummaryLLMProvider(),
      input: {
        accountKey: "primary",
        prompt: "この画像をベースに広告画像を加工して生成",
        referenceImagePaths: [referencePath],
        variantCount: 1,
      },
    });

    assert.equal(imageProvider.requests[0]!.referenceImages?.length, 1);
    assert.equal(imageProvider.requests[0]!.referenceImages?.[0]?.sourceRef, referencePath);
    assert.match(imageProvider.requests[0]!.prompt, /direct image reference mode/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal rejects settings Meta Ads CLI cannot apply", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-cli-limit-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    await assert.rejects(
      () =>
        createCreativeSubmissionProposal({
          prisma: fakePrisma() as never,
          githubAdapter: github as unknown as GithubAdapter,
          workspaceId: "ws_1",
          actor: "test",
          source: "cli-chat",
          env: {
            ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
            ADDROID_HOME: homeDir,
          },
          input: normalizeCreativeSubmissionInput({
            accountKey: "primary",
            creativeName: "profile-visit",
            adName: "Profile Visit Ad",
            headline: "Profile Visit",
            primaryText: "Try the offer today.",
            pageId: "page_123",
            linkUrl: "https://example.com/profile",
            callToAction: "VIEW_INSTAGRAM_PROFILE",
            campaignId: "cmp_existing",
            adsetName: "Profile Visit JP",
            optimizationGoal: "PROFILE_VISIT",
            billingEvent: "IMPRESSIONS",
            ageMin: 20,
            publisherPlatforms: ["instagram"],
            countries: ["JP"],
            mediaType: "text",
          }),
        }),
      /Meta Ads CLI で反映できる範囲外/
    );
    assert.equal(github.created.length, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

function writeOpsFixture(rootDir: string): void {
  const files: Record<string, string> = {
    ".addroid/project.yaml": `version: 1
workspace:
  slug: default
  displayName: "Default"
`,
    "workflows/cron.yaml": `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: true
`,
    "operations/.gitkeep": "",
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
}

function snapshotRow(input: {
  id: string;
  nodeKey: string;
  hierarchyId: string;
  displayName: string;
  creativeRef: string;
  metricDate: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendMicros: bigint;
}) {
  return {
    id: input.id,
    nodeType: "ad",
    nodeKey: input.nodeKey,
    hierarchyId: input.hierarchyId,
    metricDate: new Date(`${input.metricDate}T00:00:00.000Z`),
    impressions: input.impressions,
    clicks: input.clicks,
    conversions: input.conversions,
    spendMicros: input.spendMicros,
    createdAt: new Date(`${input.metricDate}T01:00:00.000Z`),
    raw: { displayName: input.displayName },
    hierarchy: {
      id: input.hierarchyId,
      nodeType: "ad",
      nodeKey: input.nodeKey,
      displayName: input.displayName,
      status: "ACTIVE",
      externalId: input.nodeKey,
      spec: { creativeRef: input.creativeRef },
    },
  };
}

function fakePrisma() {
  let aiRunSeq = 0;
  let creativeSeq = 0;
  return {
    workspace: {
      async findUnique() {
        return {
          opsRepoId: "repo_1",
          defaultAdAccount: { id: "acct_1", key: "primary", displayName: "Primary", currency: "JPY", timezoneName: "Asia/Tokyo" },
        };
      },
    },
    githubRepo: {
      async findUnique() {
        return { id: "repo_1", owner: "octo", name: "ops", defaultBranch: "main" };
      },
    },
    adAccount: {
      async findUnique() {
        return { id: "acct_1", key: "primary", displayName: "Primary", currency: "JPY", timezoneName: "Asia/Tokyo" };
      },
    },
    githubPullRequest: {
      async upsert() {
        return { id: "pr_1" };
      },
    },
    creative: {
      async findMany(): Promise<unknown[]> {
        return [];
      },
      async create() {
        creativeSeq += 1;
        return { id: `creative_row_${creativeSeq}` };
      },
    },
    aiRun: {
      async create() {
        aiRunSeq += 1;
        return { id: `ai_run_${aiRunSeq}` };
      },
    },
    approvalRecord: {
      async create() {
        return { id: "approval_1" };
      },
    },
    auditLog: {
      async create() {
        return { id: "audit_1" };
      },
    },
  };
}

class CapturingImageProvider implements ImageProvider {
  readonly name = "mock";
  readonly defaultModel = "placeholder-1080";
  readonly enabled = true;
  readonly requests: ImageGenerateRequest[] = [];
  private readonly delegate = new MockImageProvider();

  async generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    this.requests.push(req);
    return this.delegate.generateImage(req);
  }
}

class ReferenceSummaryLLMProvider implements LLMProvider {
  readonly name = "mock" as const;
  readonly authKind = "none" as const;
  readonly defaultModel = "mock-vision";

  async beginOAuth(): Promise<never> { throw new Error("not implemented"); }
  async completeOAuth(): Promise<never> { throw new Error("not implemented"); }
  async refreshToken(): Promise<never> { throw new Error("not implemented"); }
  async disconnect(): Promise<boolean> { return true; }
  async getConnection() { return null; }
  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    return {
      content: "attached reference summary: bold product crop, warm color, simple composition",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      meta: {
        provider: "mock",
        model: this.defaultModel,
        requestId: "mock-reference-summary",
        accountIdentifier: "mock",
      },
      costUsd: 0,
    };
  }
  async generateImage(): Promise<never> { throw new Error("not implemented"); }
  async embed(): Promise<never> { throw new Error("not implemented"); }
}

class LandingPageLLMProvider implements LLMProvider {
  readonly name = "codex" as const;
  readonly authKind = "app_server" as const;
  readonly defaultModel = "gpt-5.5";
  readonly requests: string[] = [];

  async beginOAuth(): Promise<never> { throw new Error("not implemented"); }
  async completeOAuth(): Promise<never> { throw new Error("not implemented"); }
  async refreshToken(): Promise<never> { throw new Error("not implemented"); }
  async disconnect(): Promise<boolean> { return true; }
  async getConnection() {
    return {
      provider: "codex" as const,
      accountIdentifier: "test",
      scopes: [],
      connectedAt: new Date("2026-05-14T00:00:00.000Z").toISOString(),
      expiresAt: null,
      defaultModel: this.defaultModel,
    };
  }
  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    this.requests.push(req.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    ).join("\n\n"));
    return {
      content: "商品/サービス: SaaSのデモ予約\n主な訴求: 静かなデモ予約\nCTA: Book a demo\n画像ヒント: 落ち着いた管理画面と予約導線\n避けるべき未確認主張: 数値保証",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      meta: {
        provider: "codex",
        model: this.defaultModel,
        requestId: "landing-brief",
        accountIdentifier: "test",
      },
      costUsd: 0,
    };
  }
  async generateImage(): Promise<never> { throw new Error("not implemented"); }
  async embed(): Promise<never> { throw new Error("not implemented"); }
}

class CreativeTextLLMProvider implements LLMProvider {
  readonly name = "mock" as const;
  readonly authKind = "none" as const;
  readonly defaultModel = "mock-copy";

  async beginOAuth(): Promise<never> { throw new Error("not implemented"); }
  async completeOAuth(): Promise<never> { throw new Error("not implemented"); }
  async refreshToken(): Promise<never> { throw new Error("not implemented"); }
  async disconnect(): Promise<boolean> { return true; }
  async getConnection() { return null; }
  async complete(): Promise<LLMCompletionResult> {
    return {
      content: JSON.stringify({
        variants: [
          {
            primaryText: "落ち着いた空間で、次の体験を気軽に相談。",
            headline: "静かに相談できる予約",
            description: "予約前に詳しく確認",
            callToAction: "LEARN_MORE",
            rationale: "予約前の安心感を強調",
          },
          {
            primaryText: "忙しい日にも、短時間で雰囲気を確認できます。",
            headline: "雰囲気を見て選ぶ",
            description: "詳細を確認",
            callToAction: "LEARN_MORE",
            rationale: "比較検討層向け",
          },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      meta: {
        provider: "mock",
        model: this.defaultModel,
        requestId: "mock-copy",
        accountIdentifier: "mock",
      },
      costUsd: 0,
    };
  }
  async generateImage(): Promise<never> { throw new Error("not implemented"); }
  async embed(): Promise<never> { throw new Error("not implemented"); }
}

class FakeGithubAdapter {
  readonly created: CreatePullRequestInput[] = [];

  async createPullRequest(input: CreatePullRequestInput) {
    this.created.push(input);
    return {
      number: 42,
      htmlUrl: "https://github.example/octo/ops/pull/42",
      headSha: "abc123",
    };
  }
}

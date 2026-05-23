import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
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

test("createCreativeSubmissionProposal drops ad create tracking specs without an object", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-tracking-specs-"));
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
        creativeName: "tracking-specs",
        adName: "Tracking Specs Ad",
        headline: "Tracking Specs",
        primaryText: "Try the new offer today.",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        mediaType: "text",
        trackingSpecs: [
          { "action.type": ["visit_instagram_profile"] },
          { "action.type": ["instagram_direct_message_reply"], page: ["281900655012835"] },
          { "action.type": ["post_engagement"], post: ["old_post_id"], "post.wall": ["281900655012835"] },
        ],
        adGraphPayload: {
          tracking_specs: [
            { "action.type": ["visit_instagram_profile"] },
            { "action.type": ["link_click"], object: ["281900655012835"] },
          ],
        },
      },
    });

    const operation = operationJsonFromDiff(github.created[0]!.files[0]!.diff);
    const ad = operation.actions.find((action) => action.kind === "ad.create");
    assert.deepEqual(ad?.payload.trackingSpecs, [
      { "action.type": ["instagram_direct_message_reply"], page: ["281900655012835"] },
    ]);
    assert.deepEqual(ad?.payload.graphPayload?.tracking_specs, [
      { "action.type": ["link_click"], object: ["281900655012835"] },
    ]);
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
    assert.match(pr.files[0]!.diff, /"nodeKey": "summer-jp-\d{4}-\d{2}-\d{2}_addroid"/);
    assert.match(pr.files[0]!.diff, /"Summer JP \d{4}-\d{2}-\d{2}_addroid"/);
    assert.match(pr.files[0]!.diff, /"kind": "adset\.create"/);
    assert.match(pr.files[0]!.diff, /"optimizationGoal": "LINK_CLICKS"/);
    assert.match(pr.files[0]!.diff, /"billingEvent": "IMPRESSIONS"/);
    assert.match(pr.files[0]!.diff, /"bidAmount": 3/);
    assert.match(pr.files[0]!.diff, /"pixel_123"/);
    assert.match(pr.files[0]!.diff, /"page_123"/);
    assert.match(pr.files[0]!.diff, /"https:\/\/example.com\/summer"/);
    assert.match(pr.files[0]!.diff, /"callToAction": "SHOP_NOW"/);
    assert.match(pr.files[0]!.diff, /\{\{creative:summer-sale\}\}/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal appends addroid date suffix unless names are explicit", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-name-suffix-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const autoGithub = new FakeGithubAdapter();
    await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: autoGithub as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: normalizeCreativeSubmissionInput({
        accountKey: "primary",
        placementMode: "new_campaign",
        creativeName: "auto-name-creative",
        headline: "Auto Name",
        primaryText: "Auto name submission.",
        pageId: "page_123",
        linkUrl: "https://example.com/auto",
        callToAction: "LEARN_MORE",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        dailyBudget: 500,
        mediaType: "text",
      }),
    });
    const auto = operationJsonFromDiff(autoGithub.created[0]!.files[0]!.diff);
    const autoCampaign = auto.actions.find((action) => action.kind === "campaign.create");
    const autoAdset = auto.actions.find((action) => action.kind === "adset.create");
    const autoAd = auto.actions.find((action) => action.kind === "ad.create");
    assert.match(String(autoCampaign?.payload.name), /\d{4}-\d{2}-\d{2}_addroid$/);
    assert.match(String(autoAdset?.payload.name), /\d{4}-\d{2}-\d{2}_addroid$/);
    assert.match(String(autoAd?.payload.name), /\d{4}-\d{2}-\d{2}_addroid$/);

    const explicitGithub = new FakeGithubAdapter();
    await createCreativeSubmissionProposal({
      prisma: fakePrisma() as never,
      githubAdapter: explicitGithub as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
      },
      input: normalizeCreativeSubmissionInput({
        accountKey: "primary",
        placementMode: "new_campaign",
        campaignName: "Exact Campaign",
        campaignNameExplicit: true,
        adsetName: "Exact Adset",
        adsetNameExplicit: true,
        adName: "Exact Ad",
        adNameExplicit: true,
        creativeName: "explicit-name-creative",
        headline: "Exact Name",
        primaryText: "Explicit name submission.",
        pageId: "page_123",
        linkUrl: "https://example.com/exact",
        callToAction: "LEARN_MORE",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        dailyBudget: 500,
        mediaType: "text",
      }),
    });
    const explicit = operationJsonFromDiff(explicitGithub.created[0]!.files[0]!.diff);
    const explicitCampaign = explicit.actions.find((action) => action.kind === "campaign.create");
    const explicitAdset = explicit.actions.find((action) => action.kind === "adset.create");
    const explicitAd = explicit.actions.find((action) => action.kind === "ad.create");
    assert.equal(explicitCampaign?.payload.name, "Exact Campaign");
    assert.equal(explicitAdset?.payload.name, "Exact Adset");
    assert.equal(explicitAd?.payload.name, "Exact Ad");
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
    assert.match(pr.files[0]!.diff, /"optimizationGoal": "LINK_CLICKS"/);
    assert.match(pr.files[0]!.diff, /"billingEvent": "IMPRESSIONS"/);
    assert.match(pr.files[0]!.diff, /"dailyBudget": 500/);
    assert.match(pr.files[0]!.diff, /\{\{creative:new-set-profile\}\}/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal treats resolver ids as inheritance only for new_campaign placement", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-new-campaign-intent-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  const restoreFetch = installMetaGraphReadMock({
    cmp_existing_from_resolver: {
      id: "cmp_existing_from_resolver",
      objective: "OUTCOME_TRAFFIC",
      buying_type: "AUCTION",
      daily_budget: "200",
    },
    as_existing_from_resolver: {
      id: "as_existing_from_resolver",
      optimization_goal: "PROFILE_VISIT",
      billing_event: "IMPRESSIONS",
      destination_type: "INSTAGRAM_PROFILE",
      targeting: { age_min: 20, geo_locations: { countries: ["JP"] } },
      promoted_object: { page_id: "281900655012835" },
    },
  });
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
        ADDROID_META_OAUTH_MOCK: "1",
      },
      input: {
        accountKey: "primary",
        placementMode: "new_campaign",
        campaignId: "cmp_existing_from_resolver",
        adsetId: "as_existing_from_resolver",
        campaignName: "2026-05-21 CP 新規",
        adsetName: "2026-05-21 ADS 新規",
        creativeName: "new-campaign-creative",
        adName: "New Campaign Ad",
        headline: "New Campaign",
        primaryText: "既存オン配信と同様の設定で新規キャンペーンへ入稿",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        instagramActorId: "17841465387326763",
        linkUrl: "http://instagram.com/shishasin2022kumamoto",
        callToAction: "VIEW_INSTAGRAM_PROFILE",
        objective: "OUTCOME_TRAFFIC",
        optimizationGoal: "PROFILE_VISIT",
        billingEvent: "IMPRESSIONS",
        dailyBudget: 200,
        targeting: { geo_locations: { countries: ["JP"] }, age_min: 20 },
        mediaType: "text",
      },
    });

    assert.equal(result.planOk, true);
    assert.match(result.planSummary, /actions=4/);
    const diff = github.created[0]!.files[0]!.diff;
    assert.match(diff, /"kind": "campaign\.create"/);
    assert.match(diff, /"kind": "adset\.create"/);
    assert.match(diff, /"kind": "ad\.create"/);
    assert.doesNotMatch(diff, /"adsetRef": "as_existing_from_resolver"/);
    assert.match(diff, /"adsetRef": "\{\{adset:/);
    assert.doesNotMatch(diff, /"campaignRef": "cmp_existing_from_resolver"/);
  } finally {
    restoreFetch();
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
        instagramActorId: "17841465387326763",
        instagramAppLink: "instagram://user?username=shishasin2022kumamoto&userid=65414107577",
        linkUrl: "http://instagram.com/shishasin2022kumamoto",
        callToAction: "VIEW_INSTAGRAM_PROFILE",
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
    assert.match(pr.files[0]!.diff, /"callToAction": "VIEW_INSTAGRAM_PROFILE"/);
    assert.match(pr.files[0]!.diff, /"instagramActorId": "17841465387326763"/);
    assert.match(pr.files[0]!.diff, /"17841465387326763"/);
    assert.match(pr.files[0]!.diff, /"instagramAppLink":/);
    assert.match(pr.files[0]!.diff, /"instagram:\/\/user\?username=shishasin2022kumamoto&userid=65414107577"/);
    assert.match(pr.files[0]!.diff, /"instagramUserId": "17841465387326763"/);
    assert.doesNotMatch(pr.files[0]!.diff, /custom-event-type/);
    assert.doesNotMatch(pr.files[0]!.diff, /optimizationGoal/);
    assert.doesNotMatch(pr.files[0]!.diff, /billingEvent/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal does not infer 9:16 from Instagram profile CTA alone", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-normalize-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const squarePng = await sharp({
      create: {
        width: 1080,
        height: 1080,
        channels: 3,
        background: "#336699",
      },
    }).png().toBuffer();
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
        creativeName: "profile-image",
        adName: "Profile Image Ad",
        headline: "Profile",
        primaryText: "Instagramプロフィールへ誘導します。",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        instagramActorId: "17841465387326763",
        instagramAppLink: "instagram://user?username=shishasin2022kumamoto&userid=65414107577",
        linkUrl: "http://instagram.com/shishasin2022kumamoto",
        callToAction: "VIEW_INSTAGRAM_PROFILE",
        campaignId: "120228334025190756",
        adsetId: "120228334025180756",
        mediaType: "image",
        uploadedMedia: [{ filename: "square.png", bytes: squarePng, mimeType: "image/png" }],
      },
    });

    assert.equal(result.mediaType, "image");
    assert.equal(result.storageKeys.length, 1);
    assert.match(result.storageKeys[0]!, /square\.png$/);
    const normalizedPath = path.join(homeDir, "storage", result.storageKeys[0]!);
    const metadata = await sharp(normalizedPath).metadata();
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1080);
    assert.match(github.created[0]!.files[0]!.diff, /square\.png/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal requests 9:16 image generation from explicit placement", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-generate-profile-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const imageProvider = new CapturingImageProvider();
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
      input: {
        accountKey: "primary",
        creativeName: "profile-generated",
        adName: "Profile Generated Ad",
        prompt: "プロフィール訪問向けの店舗広告画像を生成",
        linkUrl: "http://instagram.com/shishasin2022kumamoto",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        instagramActorId: "17841465387326763",
        instagramAppLink: "instagram://user?username=shishasin2022kumamoto&userid=65414107577",
        callToAction: "VIEW_INSTAGRAM_PROFILE",
        campaignId: "120228334025190756",
        adsetId: "120228334025180756",
        mediaType: "image",
        generateImage: true,
        imagePlacement: "story_reels",
      },
    });

    assert.equal(result.generatedImage, true);
    const condition = imageProvider.requests[0]!.variationConditions[0]!;
    assert.equal(condition.width, 1080);
    assert.equal(condition.height, 1920);
    assert.equal(condition.variantKey, "story_reels");
    assert.match(condition.styleNotes ?? "", /safe margins/);
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
    inheritFromAdId: "120228334025200756",
    instagramActorId: "65414107577",
    customEventType: null,
    callToAction: null,
    objective: null,
    urgency: null,
  });

  assert.equal(input.instagramActorId, "65414107577");
  assert.equal(input.inheritFromAdId, "120228334025200756");
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

test("createCreativePromotionProposal prefers Instagram profile CTA for Instagram profile destinations", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-profile-cta-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  try {
    writeOpsFixture(rootDir);
    const prisma = fakePrisma();
    const creativeApi = prisma.creative as unknown as {
      findFirst: () => Promise<Record<string, unknown>>;
      update: () => Promise<{ id: string }>;
    };
    creativeApi.findFirst = async () => ({
      id: "source_cr_profile",
      accountId: "acct_1",
      pullRequestId: null,
      key: "source-profile",
      displayName: "Profile Creative",
      mediaType: "text",
      status: "approved",
      prompt: "promote profile",
      parameters: {},
      storagePath: null,
      spec: {
        adText: {
          headline: "Profile",
          primaryText: "Visit the profile.",
          description: "Instagram profile",
          callToAction: "LEARN_MORE",
        },
      },
      account: { key: "primary", displayName: "Primary" },
      pullRequest: null,
    });
    creativeApi.update = async () => ({ id: "source_cr_profile" });
    const github = new FakeGithubAdapter();
    await createCreativePromotionProposal({
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
        creativeId: "source_cr_profile",
        campaignId: "cmp_existing",
        adsetId: "as_existing",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        instagramAppLink: "instagram://user?username=example&userid=123",
        linkUrl: "https://instagram.com/example",
      },
    });

    const operation = operationJsonFromDiff(github.created[0]!.files[0]!.diff);
    const creative = operation.actions.find((action) => action.kind === "creative.create");
    assert.equal(creative?.payload.callToAction, "VIEW_INSTAGRAM_PROFILE");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativePromotionProposal does not inherit ad tracking or conversion specs from source ad", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-source-ad-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  const restoreFetch = installMetaGraphReadMock({
    cmp_active: {
      id: "cmp_active",
      objective: "OUTCOME_TRAFFIC",
      buying_type: "AUCTION",
      daily_budget: "200",
    },
    as_active: {
      id: "as_active",
      optimization_goal: "PROFILE_VISIT",
      billing_event: "IMPRESSIONS",
      destination_type: "INSTAGRAM_PROFILE",
      targeting: { age_min: 20, geo_locations: { countries: ["JP"] } },
      promoted_object: { page_id: "281900655012835" },
    },
    ad_active: {
      id: "ad_active",
      tracking_specs: [
        { "action.type": ["visit_instagram_profile"] },
        { "action.type": ["post_engagement"], post: ["old_post_id"], "post.wall": ["281900655012835"] },
      ],
      conversion_specs: [
        { "action.type": ["onsite_conversion"], conversion_id: ["7277158392389258", "7776117722449388"] },
      ],
    },
  });
  try {
    writeOpsFixture(rootDir);
    const prisma = fakePrisma();
    const creativeApi = prisma.creative as unknown as {
      findFirst: () => Promise<Record<string, unknown>>;
      update: () => Promise<{ id: string }>;
    };
    creativeApi.findFirst = async () => ({
      id: "source_cr_context_ad",
      accountId: "acct_1",
      pullRequestId: null,
      key: "source-context-ad",
      displayName: "Context Ad Creative",
      mediaType: "text",
      status: "approved",
      prompt: "promote with source ad context",
      parameters: {
        creativeContext: {
          target: {
            hierarchy: "ad",
            nodeKey: "ad_active",
            creative: {
              pageId: "281900655012835",
              linkUrl: "https://instagram.com/example",
              instagramUserId: "17841465387326763",
            },
          },
        },
      },
      storagePath: null,
      spec: {
        adText: {
          headline: "Profile",
          primaryText: "Visit the profile.",
          description: "Instagram profile",
          callToAction: "VIEW_INSTAGRAM_PROFILE",
        },
      },
      account: { key: "primary", displayName: "Primary" },
      pullRequest: null,
    });
    creativeApi.update = async () => ({ id: "source_cr_context_ad" });
    const github = new FakeGithubAdapter();
    await createCreativePromotionProposal({
      prisma: prisma as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
        ADDROID_META_OAUTH_MOCK: "1",
      },
      input: {
        creativeId: "source_cr_context_ad",
        placementMode: "new_campaign",
        inheritFromCampaignId: "cmp_active",
        inheritFromAdsetId: "as_active",
        campaignName: "Copied Campaign",
        adsetName: "Copied Adset",
        objective: "OUTCOME_TRAFFIC",
        dailyBudget: 200,
      },
    });

    const operation = operationJsonFromDiff(github.created[0]!.files[0]!.diff);
    const ad = operation.actions.find((action) => action.kind === "ad.create");
    assert.equal(ad?.payload.trackingSpecs, undefined);
    assert.equal(ad?.payload.conversionSpecs, undefined);
    assert.equal(ad?.payload.graphPayload?.tracking_specs, undefined);
    assert.equal(ad?.payload.graphPayload?.conversion_specs, undefined);
  } finally {
    restoreFetch();
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
    assert.match(github.created[0]!.files[0]!.diff, /"dailyBudget": 0/);
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
    assert.match(pr.files[0]!.diff, /"dailyBudget": 500/);
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
    assert.deepEqual(
      imageProvider.requests[0]!.variationConditions.map((c) => [c.width, c.height, c.variantKey]),
      [
        [1080, 1080, "feed_square_0"],
        [1080, 1350, "feed_portrait_1"],
      ]
    );
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

test("createCreativeSubmissionProposal accepts Graph-only targeting and objective settings", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-cli-limit-"));
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
        optimizationSubEvent: "NONE",
        billingEvent: "IMPRESSIONS",
        adsetBidStrategy: "LOWEST_COST_WITHOUT_CAP",
        attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 7 }],
        destinationType: "INSTAGRAM_PROFILE",
        creativeGraphPayload: { url_tags: "utm_source=meta&utm_medium=paid" },
        adGraphPayload: { conversion_domain: "example.com" },
        ageMin: 20,
        publisherPlatforms: ["instagram"],
        countries: ["JP"],
        mediaType: "text",
      }),
    });
    assert.equal(result.planOk, true);
    assert.equal(github.created.length, 1);
    assert.match(github.created[0]!.files[0]!.diff, /"optimizationGoal": "PROFILE_VISIT"/);
    assert.match(github.created[0]!.files[0]!.diff, /"optimizationSubEvent": "NONE"/);
    assert.match(github.created[0]!.files[0]!.diff, /"bidStrategy": "LOWEST_COST_WITHOUT_CAP"/);
    assert.match(github.created[0]!.files[0]!.diff, /"attributionSpec"/);
    assert.match(github.created[0]!.files[0]!.diff, /"destinationType": "INSTAGRAM_PROFILE"/);
    assert.match(github.created[0]!.files[0]!.diff, /"graphPayload"/);
    assert.match(github.created[0]!.files[0]!.diff, /"conversion_domain": "example.com"/);
    assert.match(github.created[0]!.files[0]!.diff, /"age_min": 20/);
    assert.match(github.created[0]!.files[0]!.diff, /"publisher_platforms"/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal keeps inherited campaign budget off new adset", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-inherit-budget-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  const restoreFetch = installMetaGraphReadMock({
    cmp_active: {
      id: "cmp_active",
      objective: "OUTCOME_TRAFFIC",
      buying_type: "AUCTION",
      daily_budget: "200",
    },
    as_active: {
      id: "as_active",
      optimization_goal: "PROFILE_VISIT",
      billing_event: "IMPRESSIONS",
      destination_type: "INSTAGRAM_PROFILE",
      targeting: { age_min: 20, geo_locations: { countries: ["JP"] } },
      promoted_object: { page_id: "281900655012835" },
    },
    ad_active: {
      id: "ad_active",
      tracking_specs: [
        { "action.type": ["visit_instagram_profile"] },
        { "action.type": ["instagram_direct_message_reply"], page: ["281900655012835"] },
        { "action.type": ["post_engagement"], post: ["old_post_id"], "post.wall": ["281900655012835"] },
      ],
      conversion_specs: [
        { "action.type": ["onsite_conversion"], conversion_id: ["7277158392389258", "7776117722449388"] },
      ],
    },
  });
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createCreativeSubmissionProposal({
      prisma: fakePrisma({
        hierarchyNodes: [
          {
            nodeType: "campaign",
            externalId: "cmp_active",
            spec: {
              raw: {
                objective: "OUTCOME_TRAFFIC",
                buying_type: "AUCTION",
                daily_budget: "200",
              },
            },
          },
          {
            nodeType: "adset",
            externalId: "as_active",
            spec: {
              raw: {
                optimization_goal: "PROFILE_VISIT",
                billing_event: "IMPRESSIONS",
                destination_type: "INSTAGRAM_PROFILE",
                targeting: { age_min: 20, geo_locations: { countries: ["JP"] } },
                promoted_object: { page_id: "281900655012835" },
              },
            },
          },
        ],
      }) as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "web-chat",
      env: {
        ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
        ADDROID_HOME: homeDir,
        ADDROID_META_OAUTH_MOCK: "1",
      },
      input: normalizeCreativeSubmissionInput({
        accountKey: "primary",
        placementMode: "new_campaign",
        inheritFromCampaignId: "cmp_active",
        inheritFromAdsetId: "as_active",
        inheritFromAdId: "ad_active",
        creativeName: "profile-copy",
        adName: "Profile Copy Ad",
        headline: "Profile Copy",
        primaryText: "Visit the Instagram profile.",
        pageId: "281900655012835",
        instagramUserId: "17841465387326763",
        linkUrl: "https://instagram.com/example",
        callToAction: "LEARN_MORE",
        campaignName: "Copied Campaign",
        adsetName: "Copied Adset",
        objective: "OUTCOME_ENGAGEMENT",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "CLICKS",
        destinationType: "WEBSITE",
        dailyBudget: 200,
        mediaType: "text",
      }),
    });

    assert.equal(result.planOk, true);
    const operation = operationJsonFromDiff(github.created[0]!.files[0]!.diff);
    const creative = operation.actions.find((action) => action.kind === "creative.create");
    const campaign = operation.actions.find((action) => action.kind === "campaign.create");
    const adset = operation.actions.find((action) => action.kind === "adset.create");
    const ad = operation.actions.find((action) => action.kind === "ad.create");
    assert.equal(creative?.payload.callToAction, "VIEW_INSTAGRAM_PROFILE");
    assert.equal(campaign?.payload.objective, "OUTCOME_TRAFFIC");
    assert.equal(campaign?.payload.graphPayload?.objective, "OUTCOME_TRAFFIC");
    assert.equal(campaign?.payload.dailyBudget, 200);
    assert.equal(adset?.payload.dailyBudget, undefined);
    assert.equal(adset?.payload.optimizationGoal, "PROFILE_VISIT");
    assert.equal(adset?.payload.billingEvent, "IMPRESSIONS");
    assert.equal(adset?.payload.destinationType, "INSTAGRAM_PROFILE");
    assert.equal(adset?.payload.graphPayload?.optimization_goal, "PROFILE_VISIT");
    assert.equal(adset?.payload.graphPayload?.billing_event, "IMPRESSIONS");
    assert.deepEqual(adset?.payload.graphPayload?.promoted_object, { page_id: "281900655012835" });
    assert.equal(ad?.payload.trackingSpecs, undefined);
    assert.equal(ad?.payload.conversionSpecs, undefined);
    assert.equal(ad?.payload.graphPayload?.tracking_specs, undefined);
    assert.equal(ad?.payload.graphPayload?.conversion_specs, undefined);
  } finally {
    restoreFetch();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createCreativeSubmissionProposal refuses DB-only inheritance for new campaign creation", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-inherit-fail-closed-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-creative-home-"));
  const restoreFetch = installMetaGraphReadMock({});
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    await assert.rejects(
      createCreativeSubmissionProposal({
        prisma: fakePrisma({
          hierarchyNodes: [
            {
              nodeType: "campaign",
              externalId: "cmp_cache_only",
              spec: { raw: { objective: "OUTCOME_TRAFFIC", daily_budget: "200" } },
            },
            {
              nodeType: "adset",
              externalId: "as_cache_only",
              spec: {
                raw: {
                  optimization_goal: "PROFILE_VISIT",
                  billing_event: "IMPRESSIONS",
                  destination_type: "INSTAGRAM_PROFILE",
                  targeting: { age_min: 20, geo_locations: { countries: ["JP"] } },
                },
              },
            },
          ],
        }) as never,
        githubAdapter: github as unknown as GithubAdapter,
        workspaceId: "ws_1",
        actor: "test",
        source: "web-chat",
        env: {
          ADDROID_OPS_REPO_LOCAL_DIR: rootDir,
          ADDROID_HOME: homeDir,
          ADDROID_META_OAUTH_MOCK: "1",
        },
        input: normalizeCreativeSubmissionInput({
          accountKey: "primary",
          placementMode: "new_campaign",
          inheritFromCampaignId: "cmp_cache_only",
          inheritFromAdsetId: "as_cache_only",
          campaignName: "Copied Campaign",
          adsetName: "Copied Adset",
          creativeName: "cache-only-copy",
          adName: "Cache Only Copy Ad",
          headline: "Profile Copy",
          primaryText: "Visit the Instagram profile.",
          pageId: "281900655012835",
          instagramUserId: "17841465387326763",
          linkUrl: "https://instagram.com/example",
          callToAction: "VIEW_INSTAGRAM_PROFILE",
          objective: "OUTCOME_TRAFFIC",
          optimizationGoal: "PROFILE_VISIT",
          billingEvent: "IMPRESSIONS",
          dailyBudget: 200,
          mediaType: "text",
        }),
      }),
      /DB キャッシュでは作成しません/
    );
    assert.equal(github.created.length, 0);
  } finally {
    restoreFetch();
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

function operationJsonFromDiff(diff: string): {
  actions: Array<{ kind: string; payload: Record<string, any> }>;
} {
  const json = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return JSON.parse(json);
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

function fakePrisma(options: {
  hierarchyNodes?: Array<{ nodeType: string; externalId: string; spec: unknown }>;
} = {}) {
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
        return { id: "acct_1", key: "primary", displayName: "Primary", currency: "JPY", timezoneName: "Asia/Tokyo", metaAccountId: "act_123" };
      },
      async findFirst() {
        return { id: "acct_1", key: "primary", displayName: "Primary", currency: "JPY", timezoneName: "Asia/Tokyo", metaAccountId: "act_123" };
      },
    },
    oAuthToken: {
      async findFirst() {
        return {
          provider: "meta",
          accountIdentifier: "mock-user",
          scopes: [],
          accessTokenCiphertext: "mock-token",
          refreshTokenCiphertext: null,
          expiresAt: null,
          connectedAt: new Date("2026-05-22T00:00:00.000Z"),
        };
      },
    },
    adsHierarchyNode: {
      async findFirst(query: { where?: { nodeType?: string; OR?: Array<Record<string, string>> } }) {
        const nodeType = query.where?.nodeType;
        const ids = query.where?.OR?.flatMap((item) => Object.values(item)) ?? [];
        const node = options.hierarchyNodes?.find((item) => item.nodeType === nodeType && ids.includes(item.externalId));
        return node ? { spec: node.spec } : null;
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

function installMetaGraphReadMock(objects: Record<string, Record<string, unknown>>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const id = decodeURIComponent(parts[parts.length - 1] ?? "");
    if (id === "instagram_accounts") {
      return {
        ok: true,
        json: async () => ({ data: [] }),
      } as Response;
    }
    const body = objects[id];
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      json: async () => body ?? { error: { message: `missing mock graph object ${id}` } },
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
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

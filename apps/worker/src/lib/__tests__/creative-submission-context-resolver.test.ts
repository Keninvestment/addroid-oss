import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCreativeIdFromMetaAd,
  parseMetaCliObjectRecord,
  resolveCreativeSubmissionContext,
  summarizeCreativeForSubmission,
} from "../creative-submission-context-resolver.js";

test("parseMetaCliObjectRecord parses Meta SDK object repr strings", () => {
  assert.deepEqual(parseMetaCliObjectRecord('<AdCreative> {"id": "cr_1"}'), { id: "cr_1" });
});

test("extractCreativeIdFromMetaAd reads creative id from Meta SDK object repr", () => {
  assert.equal(
    extractCreativeIdFromMetaAd({
      id: "ad_1",
      creative: '<AdCreative> {"id": "1740324726689527"}',
    }),
    "1740324726689527"
  );
});

test("summarizeCreativeForSubmission reads page, Instagram user, link, and CTA from object_story_spec repr", () => {
  const creative = summarizeCreativeForSubmission(
    {
      id: "1740324726689527",
      name: "existing creative",
      object_story_spec:
        '<AdCreativeObjectStorySpec> {"instagram_user_id":"17841465387326763","page_id":"281900655012835","video_data":{"call_to_action":{"type":"VIEW_INSTAGRAM_PROFILE","value":{"app_link":"instagram://user?username=shishasin2022kumamoto&userid=65414107577","link":"http://instagram.com/shishasin2022kumamoto","link_format":"VIDEO_LPP"}},"message":"body"}}',
    },
    "fallback"
  );
  assert.deepEqual(creative, {
    id: "1740324726689527",
    name: "existing creative",
    pageId: "281900655012835",
    instagramUserId: "17841465387326763",
    instagramActorId: null,
    instagramAppLink: "instagram://user?username=shishasin2022kumamoto&userid=65414107577",
    linkUrl: "http://instagram.com/shishasin2022kumamoto",
    callToAction: "VIEW_INSTAGRAM_PROFILE",
  });
});

test("resolveCreativeSubmissionContext resolves local active campaign/adset to Graph creative details", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalMock = process.env.ADDROID_META_OAUTH_MOCK;
  process.env.ADDROID_META_OAUTH_MOCK = "1";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/cmp_meta")) {
      return jsonResponse({
        id: "cmp_meta",
        name: "ON campaign",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        objective: "OUTCOME_TRAFFIC",
        buying_type: "AUCTION",
        daily_budget: "200",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        is_adset_budget_sharing_enabled: false,
        special_ad_categories: ["NONE"],
      });
    }
    if (url.pathname.endsWith("/as_meta")) {
      return jsonResponse({
        id: "as_meta",
        name: "ON adset",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        campaign_id: "cmp_meta",
        optimization_goal: "PROFILE_VISIT",
        billing_event: "IMPRESSIONS",
        destination_type: "INSTAGRAM_PROFILE",
        attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        promoted_object: { page_id: "281900655012835", smart_pse_enabled: false },
        targeting: {
          age_min: 20,
          age_max: 40,
          geo_locations: {
            cities: [
              {
                key: "1205902",
                name: "Kumamoto-shi",
                radius: 40,
                distance_unit: "kilometer",
                country: "JP",
              },
            ],
            location_types: ["home", "recent"],
          },
          targeting_automation: {
            advantage_audience: 0,
            individual_setting: { geo: 1 },
          },
        },
      });
    }
    if (url.pathname.endsWith("/as_meta/ads")) {
      return jsonResponse({
        data: [
          {
            id: "ad_meta",
            name: "Existing active ad",
            status: "ACTIVE",
            effective_status: "ACTIVE",
            creative: { id: "creative_meta" },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/ad_meta")) {
      return jsonResponse({
        id: "ad_meta",
        name: "Existing active ad",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        creative: { id: "creative_meta" },
      });
    }
    if (url.pathname.endsWith("/creative_meta")) {
      return jsonResponse({
        id: "creative_meta",
        name: "Existing creative",
        object_story_spec: {
          page_id: "281900655012835",
          instagram_user_id: "17841465387326763",
          link_data: {
            link: "https://example.com/lp",
            call_to_action: {
              type: "LEARN_MORE",
              value: { link: "https://example.com/lp" },
            },
          },
        },
      });
    }
    if (url.pathname.endsWith("/act_123/instagram_accounts")) {
      return jsonResponse({
        data: [
          {
            id: "17841465387326763",
            ig_id: "17841465387326763",
            username: "example",
          },
        ],
      });
    }
    return jsonResponse({ error: { message: `unexpected path ${url.pathname}` } }, 404);
  }) as typeof fetch;
  try {
    const result = await resolveCreativeSubmissionContext({
      prisma: fakeResolverPrisma(),
      workspaceId: "ws",
      env: process.env,
      input: {
        creativeId: "60f6dc16-e788-4e3a-a6b2-5316efc1e4a6",
        campaignId: "local-campaign",
        adsetId: "local-adset",
        sameAsExistingAd: true,
      },
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.missing, []);
    assert.equal(result.campaign?.id, "cmp_meta");
    assert.equal(result.adset?.id, "as_meta");
    assert.equal(result.existingAd?.id, "ad_meta");
    assert.equal(result.existingCreative?.id, "creative_meta");
    assert.deepEqual(result.suggestedPromotionArgs, {
      creativeId: "60f6dc16-e788-4e3a-a6b2-5316efc1e4a6",
      placementMode: "existing_adset",
      accountKey: "primary",
      campaignId: "cmp_meta",
      adsetId: "as_meta",
      inheritFromAdId: "ad_meta",
      sourceAdId: "ad_meta",
      pageId: "281900655012835",
      instagramUserId: "17841465387326763",
      instagramActorId: "17841465387326763",
      linkUrl: "https://example.com/lp",
      callToAction: "LEARN_MORE",
    });
    assert.match(result.message, /継承予定のキャンペーン設定/);
    assert.match(result.message, /目的: OUTCOME_TRAFFIC/);
    assert.match(result.message, /daily_budget=200/);
    assert.match(result.message, /継承予定の広告セット設定/);
    assert.match(result.message, /最適化\/課金: PROFILE_VISIT \/ IMPRESSIONS/);
    assert.match(result.message, /遷移先種別: INSTAGRAM_PROFILE/);
    assert.match(result.message, /年齢: 20-40/);
    assert.match(result.message, /Kumamoto-shi/);
    assert.deepEqual(calls, [
      "/v25.0/cmp_meta",
      "/v25.0/as_meta",
      "/v25.0/as_meta/ads",
      "/v25.0/ad_meta",
      "/v25.0/creative_meta",
      "/v25.0/act_123/instagram_accounts",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ADDROID_META_OAUTH_MOCK", originalMock);
  }
});

function fakeResolverPrisma() {
  return {
    creative: {
      findFirst: async () => ({
        id: "60f6dc16-e788-4e3a-a6b2-5316efc1e4a6",
        displayName: "Generated creative",
        status: "approved",
        account: { key: "primary" },
      }),
    },
    adAccount: {
      findFirst: async () => ({
        id: "db-account",
        key: "primary",
        metaAccountId: "123",
        active: true,
        workspaceId: "ws",
      }),
    },
    oAuthToken: {
      findFirst: async () => ({
        provider: "meta",
        accountIdentifier: "test",
        scopes: [],
        accessTokenCiphertext: "test-token",
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
    adsHierarchyNode: {
      findFirst: async (query: { where?: { OR?: Array<Record<string, string>> } }) => {
        const raw = query.where?.OR?.flatMap((item) => Object.values(item)).find((value) =>
          ["local-campaign", "local-adset", "local-ad", "cmp_meta", "as_meta", "ad_meta"].includes(value)
        );
        const externalId =
          raw === "local-campaign" || raw === "cmp_meta"
            ? "cmp_meta"
            : raw === "local-adset" || raw === "as_meta"
              ? "as_meta"
              : raw === "local-ad" || raw === "ad_meta"
                ? "ad_meta"
                : null;
        return externalId ? { externalId } : null;
      },
    },
  } as any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

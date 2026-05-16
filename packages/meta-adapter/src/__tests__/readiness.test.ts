import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchMetaAssetReadiness,
  formatMetaAssetReadinessSummary,
} from "../readiness.js";

test("fetchMetaAssetReadiness accepts page evidence from existing creatives", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    seen.push(String(url));
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/act_123")) {
      return json({ id: "act_123", name: "Account" });
    }
    if (parsed.pathname.endsWith("/act_123/instagram_accounts")) {
      return json({ data: [{ id: "17841465387326763", username: "sin_kumamoto" }] });
    }
    if (parsed.pathname.endsWith("/act_123/adsets")) {
      return json({ data: [] });
    }
    if (parsed.pathname.endsWith("/act_123/adcreatives")) {
      return json({
        data: [
          {
            id: "creative_1",
            object_story_spec: {
              page_id: "281900655012835",
              instagram_user_id: "17841465387326763",
            },
          },
        ],
      });
    }
    if (parsed.pathname.endsWith("/281900655012835")) {
      return json(
        {
          error: {
            message: "Unsupported get request.",
            code: 100,
          },
        },
        400
      );
    }
    return json({}, 404);
  };

  const report = await fetchMetaAssetReadiness({
    accessToken: "token",
    adAccountId: "123",
    pageId: "281900655012835",
    instagramUserId: "17841465387326763",
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, "warning");
  assert.equal(report.adAccountId, "act_123");
  assert.equal(report.checks.pageReadable?.ok, false);
  assert.equal(report.checks.pageSeenInCreativeObjectStorySpec, true);
  assert.equal(report.checks.identityPairSeenInCreativeObjectStorySpec, true);
  assert.equal(report.checks.instagramUserVisible, true);
  assert.match(formatMetaAssetReadinessSummary(report), /page=281900655012835:evidence/);
  assert.ok(
    seen.every((url) => !url.includes("access_token")),
    "access token must not be placed in Graph URLs"
  );
});

test("fetchMetaAssetReadiness blocks when requested Instagram account is not visible", async () => {
  const fetchImpl: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/act_123")) {
      return json({ id: "act_123", name: "Account" });
    }
    if (parsed.pathname.endsWith("/act_123/instagram_accounts")) {
      return json({ data: [{ id: "ig_other", username: "other" }] });
    }
    if (parsed.pathname.endsWith("/act_123/adsets")) {
      return json({ data: [] });
    }
    if (parsed.pathname.endsWith("/act_123/adcreatives")) {
      return json({ data: [] });
    }
    if (parsed.pathname.endsWith("/page_1")) {
      return json({ id: "page_1", name: "Page" });
    }
    return json({}, 404);
  };

  const report = await fetchMetaAssetReadiness({
    accessToken: "token",
    adAccountId: "act_123",
    pageId: "page_1",
    instagramUserId: "ig_missing",
    fetchImpl,
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, "blocked");
  assert.equal(report.checks.instagramUserVisible, false);
  assert.match(report.messages.join("\n"), /Instagram/);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

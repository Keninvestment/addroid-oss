import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCreativeIdFromMetaAd,
  parseMetaCliObjectRecord,
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
    instagramActorId: "65414107577",
    linkUrl: "http://instagram.com/shishasin2022kumamoto",
    callToAction: "VIEW_INSTAGRAM_PROFILE",
  });
});

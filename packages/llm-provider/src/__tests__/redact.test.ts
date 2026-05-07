import test from "node:test";
import assert from "node:assert/strict";
import { redactPayloadForError } from "../index.js";

test("redactPayloadForError redacts bearer and JSON credential values", () => {
  const out = redactPayloadForError(
    '{"access_token":"atk-secret","api_key":"sk-secret","message":"Bearer abc.def"}'
  );
  assert.doesNotMatch(out, /atk-secret|sk-secret|abc\.def/);
  assert.match(out, /\[REDACTED\]/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { requireTrustedJsonWebAction, TRUSTED_WEB_ACTION_HEADER } from "../request-guard";

function makeRequest(headers: HeadersInit): Request {
  return new Request("http://127.0.0.1:3000/api/github/bootstrap-ops-repo", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      ...headers,
    },
    body: JSON.stringify({ ok: true }),
  });
}

test("requireTrustedJsonWebAction rejects missing Web UI header", () => {
  const response = requireTrustedJsonWebAction(
    makeRequest({
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
    })
  );

  assert.equal(response?.status, 403);
});

test("requireTrustedJsonWebAction rejects simple non-JSON posts", () => {
  const response = requireTrustedJsonWebAction(
    makeRequest({
      [TRUSTED_WEB_ACTION_HEADER]: "1",
      "content-type": "text/plain",
      origin: "http://127.0.0.1:3000",
    })
  );

  assert.equal(response?.status, 415);
});

test("requireTrustedJsonWebAction rejects cross-site fetch metadata", () => {
  const response = requireTrustedJsonWebAction(
    makeRequest({
      [TRUSTED_WEB_ACTION_HEADER]: "1",
      "content-type": "application/json",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    })
  );

  assert.equal(response?.status, 403);
});

test("requireTrustedJsonWebAction rejects mismatched origins", () => {
  const response = requireTrustedJsonWebAction(
    makeRequest({
      [TRUSTED_WEB_ACTION_HEADER]: "1",
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
    })
  );

  assert.equal(response?.status, 403);
});

test("requireTrustedJsonWebAction accepts same-origin JSON Web UI actions", () => {
  const response = requireTrustedJsonWebAction(
    makeRequest({
      [TRUSTED_WEB_ACTION_HEADER]: "1",
      "content-type": "application/json; charset=utf-8",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    })
  );

  assert.equal(response, null);
});

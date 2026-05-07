import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDROID_REQUIRED_SCOPES,
  GITHUB_AUTHORIZE_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  OAuthExchangeError,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generateOAuthState,
  pollDeviceToken,
  requestDeviceCode,
  type OAuthClientConfig,
} from "../index.js";

const CLIENT: OAuthClientConfig = {
  clientId: "Iv1.example",
  clientSecret: "shhh",
  redirectUri: "http://127.0.0.1:3000/api/oauth/github/callback",
};

test("generateOAuthState returns a high-entropy string suitable for CSRF protection", () => {
  const a = generateOAuthState();
  const b = generateOAuthState();
  assert.notEqual(a, b);
  // 24 bytes → base64url ~32 chars, no padding.
  assert.match(a, /^[A-Za-z0-9_-]{30,}$/);
});

test("buildAuthorizationUrl points at github.com with required scopes and state", () => {
  const built = buildAuthorizationUrl({ client: CLIENT });
  assert.ok(built.authorizationUrl.startsWith(GITHUB_AUTHORIZE_URL + "?"));
  const parsed = new URL(built.authorizationUrl);
  assert.equal(parsed.origin, "https://github.com");
  assert.equal(parsed.searchParams.get("client_id"), CLIENT.clientId);
  assert.equal(parsed.searchParams.get("redirect_uri"), CLIENT.redirectUri);
  assert.equal(parsed.searchParams.get("scope"), ADDROID_REQUIRED_SCOPES.join(" "));
  assert.equal(parsed.searchParams.get("state"), built.state);
  assert.equal(parsed.searchParams.get("allow_signup"), "false");
});

test("buildAuthorizationUrl honors a caller-provided state", () => {
  const built = buildAuthorizationUrl({ client: CLIENT, state: "my-state-1" });
  assert.equal(built.state, "my-state-1");
  assert.equal(new URL(built.authorizationUrl).searchParams.get("state"), "my-state-1");
});

test("exchangeCodeForToken posts form-encoded body to the GitHub token endpoint", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        access_token: "gho_abc",
        scope: "repo,read:user",
        token_type: "bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const exchanged = await exchangeCodeForToken({
    client: CLIENT,
    code: "the-code",
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedUrl, GITHUB_TOKEN_URL);
  assert.equal(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/x-www-form-urlencoded");
  const body = new URLSearchParams(String(capturedInit?.body ?? ""));
  assert.equal(body.get("client_id"), CLIENT.clientId);
  assert.equal(body.get("client_secret"), CLIENT.clientSecret);
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("redirect_uri"), CLIENT.redirectUri);
  assert.equal(exchanged.accessToken, "gho_abc");
  assert.deepEqual(exchanged.grantedScopes, ["repo", "read:user"]);
  assert.equal(exchanged.tokenType, "bearer");
});

test("exchangeCodeForToken surfaces error payloads from GitHub", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ error: "bad_verification_code", error_description: "expired" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  await assert.rejects(
    () => exchangeCodeForToken({ client: CLIENT, code: "x", fetchImpl: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof OAuthExchangeError);
      assert.match((err as Error).message, /bad_verification_code/);
      assert.match((err as Error).message, /expired/);
      return true;
    }
  );
});

test("exchangeCodeForToken rejects on HTTP failures with the status code preserved", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("nope", { status: 502 });
  await assert.rejects(
    () => exchangeCodeForToken({ client: CLIENT, code: "x", fetchImpl: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof OAuthExchangeError);
      assert.equal((err as OAuthExchangeError).status, 502);
      return true;
    }
  );
});

test("exchangeCodeForToken rejects when GitHub omits access_token", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ scope: "repo" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    () => exchangeCodeForToken({ client: CLIENT, code: "x", fetchImpl: fakeFetch }),
    /did not return access_token/
  );
});

test("requestDeviceCode posts required scope and normalizes GitHub response", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 7,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const device = await requestDeviceCode({
    clientId: CLIENT.clientId,
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedUrl, GITHUB_DEVICE_CODE_URL);
  assert.equal(capturedInit?.method, "POST");
  const body = new URLSearchParams(String(capturedInit?.body ?? ""));
  assert.equal(body.get("client_id"), CLIENT.clientId);
  assert.equal(body.get("scope"), ADDROID_REQUIRED_SCOPES.join(" "));
  assert.deepEqual(device, {
    deviceCode: "device-123",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresInSeconds: 900,
    intervalSeconds: 7,
  });
});

test("pollDeviceToken returns pending while GitHub authorization is incomplete", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const result = await pollDeviceToken({
    clientId: CLIENT.clientId,
    deviceCode: "device-123",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(result, { pending: true });
});

test("pollDeviceToken exchanges device code for access token", async () => {
  let capturedBody = "";
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        access_token: "gho_device",
        scope: "repo,read:user",
        token_type: "bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const result = await pollDeviceToken({
    clientId: CLIENT.clientId,
    deviceCode: "device-123",
    fetchImpl: fakeFetch,
  });
  const body = new URLSearchParams(capturedBody);
  assert.equal(body.get("client_id"), CLIENT.clientId);
  assert.equal(body.get("device_code"), "device-123");
  assert.equal(
    body.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:device_code"
  );
  assert.deepEqual(result, {
    accessToken: "gho_device",
    grantedScopes: ["repo", "read:user"],
    tokenType: "bearer",
  });
});

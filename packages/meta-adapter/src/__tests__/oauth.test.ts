import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDROID_META_REQUIRED_SCOPES,
  META_AUTHORIZE_URL,
  META_GRAPH_API_VERSION,
  META_TOKEN_URL,
  MetaOAuthExchangeError,
  buildAppAccessToken,
  buildMetaAuthorizationUrl,
  debugToken,
  deriveExpiresAt,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  generateMetaOAuthState,
  type MetaOAuthClientConfig,
} from "../index.js";

const CLIENT: MetaOAuthClientConfig = {
  appId: "100000000000001",
  appSecret: "shh-app-secret",
  redirectUri: "http://127.0.0.1:3000/api/oauth/meta/callback",
};

test("generateMetaOAuthState returns a high-entropy base64url string", () => {
  const a = generateMetaOAuthState();
  const b = generateMetaOAuthState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{30,}$/);
});

test("buildMetaAuthorizationUrl points at facebook.com with required scopes and state", () => {
  const built = buildMetaAuthorizationUrl({ client: CLIENT });
  assert.ok(built.authorizationUrl.startsWith(META_AUTHORIZE_URL + "?"));
  const parsed = new URL(built.authorizationUrl);
  assert.equal(parsed.origin, "https://www.facebook.com");
  assert.equal(parsed.searchParams.get("client_id"), CLIENT.appId);
  assert.equal(parsed.searchParams.get("redirect_uri"), CLIENT.redirectUri);
  assert.equal(parsed.searchParams.get("scope"), ADDROID_META_REQUIRED_SCOPES.join(","));
  assert.equal(parsed.searchParams.get("state"), built.state);
  assert.equal(parsed.searchParams.get("response_type"), "code");
});

test("buildMetaAuthorizationUrl honors caller-provided state", () => {
  const built = buildMetaAuthorizationUrl({ client: CLIENT, state: "fixed-state-1" });
  assert.equal(built.state, "fixed-state-1");
  assert.equal(new URL(built.authorizationUrl).searchParams.get("state"), "fixed-state-1");
});

test("exchangeCodeForToken sends app_id, app_secret, code, redirect_uri in the POST body — never in the URL", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({ access_token: "EAA-short", expires_in: 3600, token_type: "bearer" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const exchanged = await exchangeCodeForToken({
    client: CLIENT,
    code: "the-code",
    fetchImpl: fakeFetch,
  });
  assert.ok(capturedUrl?.startsWith(META_TOKEN_URL));
  const url = new URL(capturedUrl!);
  assert.equal(capturedInit?.method, "POST");
  // 機密値が URL クエリに混入していないことを確認。
  assert.equal(url.searchParams.get("code"), null);
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.equal(url.searchParams.get("client_id"), null);
  assert.equal(url.searchParams.get("redirect_uri"), null);
  assert.equal(url.search, "");
  // application/x-www-form-urlencoded で全フィールドを body に詰める。
  const ct = new Headers(capturedInit?.headers).get("Content-Type") ?? "";
  assert.match(ct, /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(String(capturedInit?.body ?? ""));
  assert.equal(body.get("client_id"), CLIENT.appId);
  assert.equal(body.get("client_secret"), CLIENT.appSecret);
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("redirect_uri"), CLIENT.redirectUri);
  assert.equal(exchanged.accessToken, "EAA-short");
  assert.equal(exchanged.expiresInSeconds, 3600);
  assert.equal(exchanged.tokenType, "bearer");
});

test("exchangeForLongLivedToken puts fb_exchange_token in POST body — never in the URL", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ access_token: "EAA-long" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const exchanged = await exchangeForLongLivedToken({
    client: { appId: CLIENT.appId, appSecret: CLIENT.appSecret },
    shortLivedToken: "EAA-short",
    fetchImpl: fakeFetch,
  });
  assert.ok(capturedUrl);
  const url = new URL(capturedUrl!);
  assert.equal(capturedInit?.method, "POST");
  // 機密値 (fb_exchange_token / client_secret) は URL に絶対に出さない。
  assert.equal(url.searchParams.get("fb_exchange_token"), null);
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.equal(url.searchParams.get("grant_type"), null);
  assert.equal(url.searchParams.get("client_id"), null);
  assert.equal(url.search, "");
  // capturedUrl の文字列にもトークンの literal が含まれてはいけない。
  assert.equal(capturedUrl!.includes("EAA-short"), false);
  const body = new URLSearchParams(String(capturedInit?.body ?? ""));
  assert.equal(body.get("grant_type"), "fb_exchange_token");
  assert.equal(body.get("fb_exchange_token"), "EAA-short");
  assert.equal(body.get("client_id"), CLIENT.appId);
  assert.equal(body.get("client_secret"), CLIENT.appSecret);
  assert.equal(exchanged.accessToken, "EAA-long");
});

test("token endpoint surfaces Meta error payloads as MetaOAuthExchangeError", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Invalid OAuth access token",
          type: "OAuthException",
          code: 190,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  await assert.rejects(
    () => exchangeCodeForToken({ client: CLIENT, code: "x", fetchImpl: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof MetaOAuthExchangeError);
      assert.match((err as Error).message, /Invalid OAuth access token/);
      return true;
    }
  );
});

test("token endpoint preserves HTTP status on transport failures", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("nope", { status: 500 });
  await assert.rejects(
    () => exchangeCodeForToken({ client: CLIENT, code: "x", fetchImpl: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof MetaOAuthExchangeError);
      assert.equal((err as MetaOAuthExchangeError).status, 500);
      return true;
    }
  );
});

test("buildAppAccessToken concatenates app_id|app_secret", () => {
  assert.equal(buildAppAccessToken(CLIENT), `${CLIENT.appId}|${CLIENT.appSecret}`);
});

test("debugToken sends input_token and app access_token in the POST body — never in the URL", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    const u = new URL(capturedUrl);
    assert.ok(u.pathname.endsWith("/debug_token"));
    // 機密値は URL に絶対に出ない。
    assert.equal(u.searchParams.get("input_token"), null);
    assert.equal(u.searchParams.get("access_token"), null);
    assert.equal(u.search, "");
    // 文字列としても token literal が混ざっていない。
    assert.equal(capturedUrl.includes("user-token"), false);
    assert.equal(capturedUrl.includes("100|secret"), false);
    return new Response(
      JSON.stringify({
        data: {
          user_id: "987654321",
          app_id: "100000000000001",
          scopes: ["ads_read", "ads_management"],
          expires_at: 1735689600,
          is_valid: true,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const info = await debugToken({
    appAccessToken: "100|secret",
    inputToken: "user-token",
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedInit?.method, "POST");
  const ct = new Headers(capturedInit?.headers).get("Content-Type") ?? "";
  assert.match(ct, /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(String(capturedInit?.body ?? ""));
  assert.equal(body.get("input_token"), "user-token");
  assert.equal(body.get("access_token"), "100|secret");
  assert.equal(info.userId, "987654321");
  assert.equal(info.appId, "100000000000001");
  assert.deepEqual(info.scopes, ["ads_read", "ads_management"]);
  assert.equal(info.expiresAt, 1735689600);
  assert.equal(info.isValid, true);
});

test("deriveExpiresAt uses fallback 60 days when Meta omits expires_in", () => {
  const before = Date.now();
  const date = deriveExpiresAt({ accessToken: "x" }, 60 * 24 * 60 * 60);
  const ms = date.getTime() - before;
  // 60 日 ± 1 秒の許容
  assert.ok(ms >= 60 * 24 * 60 * 60 * 1000 - 1000);
  assert.ok(ms <= 60 * 24 * 60 * 60 * 1000 + 1000);
});

test("META_GRAPH_API_VERSION is set", () => {
  assert.match(META_GRAPH_API_VERSION, /^v\d+\.\d+$/);
});

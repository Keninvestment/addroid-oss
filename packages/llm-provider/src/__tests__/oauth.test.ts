import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexOAuthExchangeError,
  buildCodexAuthorizationUrl,
  deriveCodexExpiresAt,
  deriveS256CodeChallenge,
  exchangeCodexCodeForToken,
  generatePkceCodeVerifier,
  redactPayloadForError,
  refreshCodexAccessToken,
  type CodexOAuthClientConfig,
} from "../index.js";

const CLIENT_PKCE: CodexOAuthClientConfig = {
  clientId: "addroid-codex-cli",
  redirectUri: "http://127.0.0.1:3000/api/oauth/codex/callback",
  authorizationUrl: "https://auth.example.test/oauth/authorize",
  tokenUrl: "https://auth.example.test/oauth/token",
  tokenAuthMethod: "pkce_s256",
};

const CLIENT_CONFIDENTIAL: CodexOAuthClientConfig = {
  clientId: "addroid-confidential",
  clientSecret: "the-secret",
  redirectUri: "http://127.0.0.1:3000/api/oauth/codex/callback",
  authorizationUrl: "https://auth.example.test/oauth/authorize",
  tokenUrl: "https://auth.example.test/oauth/token",
  tokenAuthMethod: "client_secret_post",
};

test("buildCodexAuthorizationUrl emits PKCE challenge by default and never embeds secrets", () => {
  const built = buildCodexAuthorizationUrl({ client: CLIENT_PKCE });
  const url = new URL(built.authorizationUrl);
  assert.equal(url.origin + url.pathname, CLIENT_PKCE.authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), CLIENT_PKCE.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), CLIENT_PKCE.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  // verifier must be returned for callback re-submission
  assert.ok(built.codeVerifier && built.codeVerifier.length >= 43);
  // sensitive params must NOT appear on the URL
  for (const k of ["client_secret", "code", "refresh_token", "access_token", "code_verifier"]) {
    assert.equal(url.searchParams.get(k), null, `URL must not carry ${k}`);
  }
});

test("buildCodexAuthorizationUrl with client_secret_post does not request PKCE", () => {
  const built = buildCodexAuthorizationUrl({ client: CLIENT_CONFIDENTIAL });
  const url = new URL(built.authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), null);
  assert.equal(built.codeVerifier, undefined);
});

test("buildCodexAuthorizationUrl strips secret-like extra params defensively", () => {
  const built = buildCodexAuthorizationUrl({
    client: {
      ...CLIENT_PKCE,
      extraAuthorizeParams: {
        audience: "addroid-test",
        client_secret: "should-be-stripped",
        access_token: "should-be-stripped",
      },
    },
  });
  const url = new URL(built.authorizationUrl);
  assert.equal(url.searchParams.get("audience"), "addroid-test");
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.equal(url.searchParams.get("access_token"), null);
});

test("deriveS256CodeChallenge: known RFC 7636 example", () => {
  // RFC 7636 Appendix B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(deriveS256CodeChallenge(verifier), expected);
});

test("generatePkceCodeVerifier returns RFC 7636-compliant strings", () => {
  for (let i = 0; i < 5; i++) {
    const v = generatePkceCodeVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{43,128}$/);
  }
});

test("exchangeCodexCodeForToken uses POST body and returns parsed token (PKCE)", async () => {
  const captured: { url?: URL; body?: URLSearchParams } = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.url = new URL(String(input));
    captured.body = new URLSearchParams((init?.body as string) ?? "");
    return new Response(
      JSON.stringify({
        access_token: "atk-abc",
        refresh_token: "rtk-xyz",
        expires_in: 3600,
        scope: "openai offline_access",
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const out = await exchangeCodexCodeForToken({
    client: CLIENT_PKCE,
    code: "the-code",
    codeVerifier: "the-verifier-1234567890123456789012345678901234567890",
    fetchImpl: fakeFetch,
  });
  // URL must be the bare token endpoint — no secrets in querystring.
  assert.ok(captured.url);
  assert.equal(captured.url.search, "");
  // Sensitive params must travel in the body.
  assert.ok(captured.body);
  assert.equal(captured.body.get("grant_type"), "authorization_code");
  assert.equal(captured.body.get("code"), "the-code");
  assert.equal(captured.body.get("client_id"), CLIENT_PKCE.clientId);
  assert.equal(
    captured.body.get("code_verifier"),
    "the-verifier-1234567890123456789012345678901234567890"
  );
  assert.equal(captured.body.get("client_secret"), null);
  assert.equal(out.accessToken, "atk-abc");
  assert.equal(out.refreshToken, "rtk-xyz");
  assert.equal(out.expiresInSeconds, 3600);
  assert.deepEqual(out.grantedScopes.sort(), ["offline_access", "openai"]);
});

test("exchangeCodexCodeForToken with client_secret_post sends client_secret in body, not URL", async () => {
  const captured: { url?: URL; body?: URLSearchParams } = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.url = new URL(String(input));
    captured.body = new URLSearchParams((init?.body as string) ?? "");
    return new Response(JSON.stringify({ access_token: "atk", scope: "openai" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  await exchangeCodexCodeForToken({
    client: CLIENT_CONFIDENTIAL,
    code: "c",
    fetchImpl: fakeFetch,
  });
  assert.ok(captured.url);
  assert.equal(captured.url.search, "");
  assert.ok(captured.body);
  assert.equal(captured.body.get("client_secret"), "the-secret");
});

test("exchangeCodexCodeForToken: client_secret_post without clientSecret throws", async () => {
  const broken: CodexOAuthClientConfig = {
    ...CLIENT_CONFIDENTIAL,
    clientSecret: undefined as unknown as string,
  };
  await assert.rejects(
    () =>
      exchangeCodexCodeForToken({
        client: broken,
        code: "c",
        fetchImpl: async () =>
          new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      }),
    CodexOAuthExchangeError
  );
});

test("exchangeCodexCodeForToken bubbles up provider errors and redacts payload", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "code already used",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  await assert.rejects(
    () =>
      exchangeCodexCodeForToken({
        client: CLIENT_PKCE,
        code: "c",
        codeVerifier: "v".repeat(43),
        fetchImpl: fakeFetch,
      }),
    (err) => {
      assert.ok(err instanceof CodexOAuthExchangeError);
      assert.equal((err as CodexOAuthExchangeError).code, "invalid_grant");
      return true;
    }
  );
});

test("exchangeCodexCodeForToken sanitizes echoed credentials in error_description (message + payload)", async () => {
  // Provider が error_description に request body を echo back してしまう事故シナリオ。
  // authorization code / code_verifier / client_secret / Bearer token のいずれが含まれていても
  // Error.message と payload の双方で [REDACTED] になっていなければならない。
  const echoed =
    'invalid: code=AUTH-CODE-LEAKED&code_verifier=PKCE-VERIFIER-LEAKED&client_secret=SHHH ' +
    'Bearer abcd.efgh-_ rejected for "access_token":"atk-leaked"';
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: echoed,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  await assert.rejects(
    () =>
      exchangeCodexCodeForToken({
        client: CLIENT_PKCE,
        code: "AUTH-CODE-LEAKED",
        codeVerifier: "PKCE-VERIFIER-LEAKED-1234567890123456789012",
        fetchImpl: fakeFetch,
      }),
    (err) => {
      assert.ok(err instanceof CodexOAuthExchangeError);
      const e = err as CodexOAuthExchangeError;
      const message = e.message;
      // 機微素材は message に絶対に出さない。
      for (const leak of [
        "AUTH-CODE-LEAKED",
        "PKCE-VERIFIER-LEAKED",
        "SHHH",
        "atk-leaked",
        "abcd.efgh-_",
      ]) {
        assert.equal(message.includes(leak), false, `Error.message must not contain ${leak}`);
      }
      assert.match(message, /\[REDACTED\]/);
      // payload も同様。error_description は文字列のままで OK だが、機微素材は redacted。
      const payload = e.payload as { error?: string; error_description?: string };
      assert.equal(typeof payload, "object");
      assert.equal(payload.error, "invalid_grant");
      assert.ok(payload.error_description, "error_description must be preserved as redacted text");
      for (const leak of [
        "AUTH-CODE-LEAKED",
        "PKCE-VERIFIER-LEAKED",
        "SHHH",
        "atk-leaked",
        "abcd.efgh-_",
      ]) {
        assert.equal(
          payload.error_description!.includes(leak),
          false,
          `payload.error_description must not contain ${leak}`
        );
      }
      // .code フィールドも redactor を通っているので OAuth 規格外の漏洩を遮る。
      assert.equal(e.code, "invalid_grant");
      return true;
    }
  );
});

test("exchangeCodexCodeForToken on non-OK HTTP redacts echoed credentials in payload", async () => {
  // 400 系 + form-encoded で request body を echo back する provider のケース。
  const echoedBody =
    "error=invalid_request&code=LEAKED-AUTH-CODE&code_verifier=LEAKED-VERIFIER&client_secret=LEAKED-SECRET";
  const fakeFetch: typeof fetch = async () =>
    new Response(echoedBody, {
      status: 400,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  await assert.rejects(
    () =>
      exchangeCodexCodeForToken({
        client: CLIENT_PKCE,
        code: "LEAKED-AUTH-CODE",
        codeVerifier: "LEAKED-VERIFIER-1234567890123456789012345",
        fetchImpl: fakeFetch,
      }),
    (err) => {
      assert.ok(err instanceof CodexOAuthExchangeError);
      const payload = (err as CodexOAuthExchangeError).payload;
      assert.equal(typeof payload, "string");
      const text = payload as string;
      for (const leak of ["LEAKED-AUTH-CODE", "LEAKED-VERIFIER", "LEAKED-SECRET"]) {
        assert.equal(text.includes(leak), false, `payload must not contain ${leak}`);
      }
      assert.match(text, /code=\[REDACTED\]/);
      assert.match(text, /code_verifier=\[REDACTED\]/);
      assert.match(text, /client_secret=\[REDACTED\]/);
      return true;
    }
  );
});

test("refreshCodexAccessToken sends refresh_token in body and returns new tokens", async () => {
  const captured: { url?: URL; body?: URLSearchParams } = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.url = new URL(String(input));
    captured.body = new URLSearchParams((init?.body as string) ?? "");
    return new Response(
      JSON.stringify({ access_token: "new-atk", refresh_token: "new-rtk", expires_in: 1800 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const out = await refreshCodexAccessToken({
    client: CLIENT_PKCE,
    refreshToken: "old-rtk",
    fetchImpl: fakeFetch,
  });
  assert.ok(captured.url);
  assert.equal(captured.url.search, "");
  assert.ok(captured.body);
  assert.equal(captured.body.get("grant_type"), "refresh_token");
  assert.equal(captured.body.get("refresh_token"), "old-rtk");
  assert.equal(out.accessToken, "new-atk");
  assert.equal(out.refreshToken, "new-rtk");
});

test("redactPayloadForError replaces token-shaped strings with [REDACTED]", () => {
  const input =
    'Got: sk-AbCdEfGhijklmnopqrstuvwxyz0123 and Bearer EYJabc.def-_ + "access_token":"deadbeef"';
  const out = redactPayloadForError(input);
  assert.match(out, /sk-\[REDACTED\]/);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.match(out, /"access_token":"\[REDACTED\]"/);
  assert.equal(out.includes("sk-AbCdEfGhijklmnopqrstuvwxyz0123"), false);
  assert.equal(out.includes("EYJabc.def-_"), false);
});

test("redactPayloadForError redacts OAuth credentials echoed in JSON shape", () => {
  const input =
    '{"code":"AUTH-CODE-XYZ","code_verifier":"PKCE-VERIFIER-XYZ","client_secret":"SECRET-XYZ","refresh_token":"rtk","id_token":"jwt"}';
  const out = redactPayloadForError(input);
  for (const leak of [
    "AUTH-CODE-XYZ",
    "PKCE-VERIFIER-XYZ",
    "SECRET-XYZ",
    "rtk",
    "jwt",
  ]) {
    assert.equal(out.includes(leak), false, `output must not contain ${leak}`);
  }
  assert.match(out, /"code":"\[REDACTED\]"/);
  assert.match(out, /"code_verifier":"\[REDACTED\]"/);
  assert.match(out, /"client_secret":"\[REDACTED\]"/);
  assert.match(out, /"refresh_token":"\[REDACTED\]"/);
  assert.match(out, /"id_token":"\[REDACTED\]"/);
});

test("redactPayloadForError redacts OAuth credentials echoed in form-encoded shape", () => {
  const input =
    "error=invalid_request&code=AUTH-LEAK&code_verifier=PKCE-LEAK&client_secret=SECRET-LEAK&access_token=ATK-LEAK";
  const out = redactPayloadForError(input);
  for (const leak of ["AUTH-LEAK", "PKCE-LEAK", "SECRET-LEAK", "ATK-LEAK"]) {
    assert.equal(out.includes(leak), false, `output must not contain ${leak}`);
  }
  assert.match(out, /code=\[REDACTED\]/);
  assert.match(out, /code_verifier=\[REDACTED\]/);
  assert.match(out, /client_secret=\[REDACTED\]/);
  assert.match(out, /access_token=\[REDACTED\]/);
});

test("redactPayloadForError truncates oversized payloads", () => {
  const big = "x".repeat(2048);
  const out = redactPayloadForError(big);
  assert.ok(out.length < big.length);
  assert.match(out, /…\[truncated\]$/);
});

test("deriveCodexExpiresAt uses fallback when expires_in is absent", () => {
  const before = Date.now();
  const expiresAt = deriveCodexExpiresAt({ accessToken: "x", grantedScopes: [] }, 600);
  const drift = expiresAt.getTime() - before - 600 * 1000;
  assert.ok(Math.abs(drift) < 5000, `drift too large: ${drift}`);
});

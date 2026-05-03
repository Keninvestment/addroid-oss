// `@addroid/config` slack-auth helpers のユニットテスト。
// fetch を注入できるシグネチャを持っているので、Slack に出ずにエラー経路まで網羅する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSlackInstallationMetadata,
  openSocketModeConnection,
  postSlackMessage,
  redactSecretTail,
  SlackApiError,
  SlackTokenValidationError,
  validateSlackInputs,
  verifyBotToken,
  verifySocketModeConnection,
  type SlackFetch,
  type SocketModeChannel,
  type SocketModeChannelHandlers,
  type SocketModeChannelOpener,
} from "../slack-auth.js";

const VALID = {
  botToken: "xoxb-1234567890-abcdef",
  appToken: "xapp-1234567890-abcdef",
  notificationChannelId: "C012ABCDEF",
};

function fakeFetch(
  expected: { url: RegExp; tokenStartsWith: string; bodyIncludes?: string },
  response: { ok?: boolean; status?: number; payload: unknown }
): SlackFetch {
  return async (url, init) => {
    assert.match(url, expected.url);
    assert.equal(init.method, "POST");
    assert.match(init.headers["Authorization"] ?? "", new RegExp(`^Bearer ${expected.tokenStartsWith}`));
    if (expected.bodyIncludes) {
      assert.ok(
        init.body.includes(expected.bodyIncludes),
        `body should include ${expected.bodyIncludes}`
      );
    }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.payload,
    };
  };
}

test("validateSlackInputs は欠落値を SlackTokenValidationError で返す", () => {
  assert.throws(() => validateSlackInputs({}), (e) => {
    return e instanceof SlackTokenValidationError && e.code === "missing_bot_token";
  });
  assert.throws(
    () => validateSlackInputs({ botToken: VALID.botToken }),
    (e) => e instanceof SlackTokenValidationError && e.code === "missing_app_token"
  );
  assert.throws(
    () =>
      validateSlackInputs({
        botToken: VALID.botToken,
        appToken: VALID.appToken,
      }),
    (e) =>
      e instanceof SlackTokenValidationError && e.code === "missing_channel_id"
  );
});

test("validateSlackInputs は形式違反を拒否する", () => {
  assert.throws(
    () =>
      validateSlackInputs({
        botToken: "xoxp-not-a-bot-token-aaaaaa",
        appToken: VALID.appToken,
        notificationChannelId: VALID.notificationChannelId,
      }),
    (e) => e instanceof SlackTokenValidationError && e.code === "invalid_bot_token"
  );
  assert.throws(
    () =>
      validateSlackInputs({
        botToken: VALID.botToken,
        appToken: "xoxb-not-an-app-token-aaaaaa",
        notificationChannelId: VALID.notificationChannelId,
      }),
    (e) => e instanceof SlackTokenValidationError && e.code === "invalid_app_token"
  );
  assert.throws(
    () =>
      validateSlackInputs({
        botToken: VALID.botToken,
        appToken: VALID.appToken,
        notificationChannelId: "not-a-channel",
      }),
    (e) => e instanceof SlackTokenValidationError && e.code === "invalid_channel_id"
  );
});

test("validateSlackInputs は trim 済み値を返す", () => {
  const out = validateSlackInputs({
    botToken: `  ${VALID.botToken}  `,
    appToken: ` ${VALID.appToken} `,
    notificationChannelId: `\t${VALID.notificationChannelId}\n`,
  });
  assert.equal(out.botToken, VALID.botToken);
  assert.equal(out.appToken, VALID.appToken);
  assert.equal(out.notificationChannelId, VALID.notificationChannelId);
});

test("verifyBotToken は auth.test を呼び team 情報を返す", async () => {
  const fetch = fakeFetch(
    { url: /\/auth\.test$/, tokenStartsWith: "xoxb-" },
    {
      payload: {
        ok: true,
        url: "https://example.slack.com/",
        team: "Default Workspace",
        user: "addroid_bot",
        team_id: "T012ABC",
        user_id: "U012BOT",
        bot_id: "B012BOT",
      },
    }
  );
  const out = await verifyBotToken(VALID.botToken, fetch);
  assert.equal(out.team_id, "T012ABC");
  assert.equal(out.user_id, "U012BOT");
});

test("verifyBotToken は ok=false を SlackApiError で返す", async () => {
  const fetch = fakeFetch(
    { url: /\/auth\.test$/, tokenStartsWith: "xoxb-" },
    { payload: { ok: false, error: "invalid_auth" } }
  );
  await assert.rejects(
    () => verifyBotToken(VALID.botToken, fetch),
    (e) =>
      e instanceof SlackApiError &&
      e.endpoint === "auth.test" &&
      e.slackError === "invalid_auth"
  );
});

test("verifyBotToken は HTTP エラーを SlackApiError で返す", async () => {
  const fetch: SlackFetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  });
  await assert.rejects(
    () => verifyBotToken(VALID.botToken, fetch),
    (e) => e instanceof SlackApiError && e.status === 503
  );
});

test("openSocketModeConnection は xapp トークンを Bearer で渡す", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    { payload: { ok: true, url: "wss://wss-primary.slack.com/link/?ticket=abc" } }
  );
  const out = await openSocketModeConnection(VALID.appToken, fetch);
  assert.match(out.url, /^wss:\/\//);
});

function fakeOpenerFor(
  fetchImpl: SlackFetch,
  drive: (handlers: SocketModeChannelHandlers) => void
): { fetchImpl: SlackFetch; opener: SocketModeChannelOpener; closes: number } {
  let closes = 0;
  const opener: SocketModeChannelOpener = (url, handlers) => {
    assert.match(url, /^wss:\/\//);
    // 非同期に hello / error / close をシミュレートし、現実の WebSocket と
    // 同じく caller の Promise resolution より後に到着するようにする。
    queueMicrotask(() => {
      handlers.onOpen?.();
      drive(handlers);
    });
    const channel: SocketModeChannel = {
      close() {
        closes += 1;
      },
    };
    return channel;
  };
  const out = { fetchImpl, opener, get closes() { return closes; } };
  return out as { fetchImpl: SlackFetch; opener: SocketModeChannelOpener; closes: number };
}

test("verifySocketModeConnection は hello イベント受信で成功を返す", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    {
      payload: {
        ok: true,
        url: "wss://wss-primary.slack.com/link/?ticket=abc",
      },
    }
  );
  const fake = fakeOpenerFor(fetch, (h) => {
    h.onMessage(
      JSON.stringify({
        type: "hello",
        num_connections: 1,
        connection_info: { app_id: "A012ABC" },
      })
    );
  });
  const out = await verifySocketModeConnection(VALID.appToken, {
    fetchImpl: fake.fetchImpl,
    openChannel: fake.opener,
    timeoutMs: 1000,
  });
  assert.match(out.url, /^wss:\/\//);
  assert.equal(out.helloEvent.type, "hello");
  assert.equal(out.helloEvent.num_connections, 1);
  // 検証後は WebSocket を必ず閉じる (worker が持続接続する責務に分離)。
  assert.equal(fake.closes, 1, "channel must be closed after success");
});

test("verifySocketModeConnection は hello が来ないとタイムアウトで SlackApiError を投げる", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    { payload: { ok: true, url: "wss://example.invalid/?ticket=abc" } }
  );
  const fake = fakeOpenerFor(fetch, () => {
    /* hello を送らずタイムアウトさせる */
  });
  await assert.rejects(
    () =>
      verifySocketModeConnection(VALID.appToken, {
        fetchImpl: fake.fetchImpl,
        openChannel: fake.opener,
        timeoutMs: 25,
      }),
    (e) =>
      e instanceof SlackApiError &&
      e.endpoint === "apps.connections.open" &&
      e.slackError === "socket_mode_timeout"
  );
  assert.equal(fake.closes, 1, "channel must be closed on timeout");
});

test("verifySocketModeConnection は hello より前の close で SlackApiError を投げる", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    { payload: { ok: true, url: "wss://example.invalid/?ticket=abc" } }
  );
  const fake = fakeOpenerFor(fetch, (h) => {
    h.onClose(1011, "server closed");
  });
  await assert.rejects(
    () =>
      verifySocketModeConnection(VALID.appToken, {
        fetchImpl: fake.fetchImpl,
        openChannel: fake.opener,
        timeoutMs: 1000,
      }),
    (e) =>
      e instanceof SlackApiError &&
      e.slackError === "socket_mode_closed_before_hello"
  );
});

test("verifySocketModeConnection は hello 以外を最初に受信すると SlackApiError を投げる", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    { payload: { ok: true, url: "wss://example.invalid/?ticket=abc" } }
  );
  const fake = fakeOpenerFor(fetch, (h) => {
    h.onMessage(JSON.stringify({ type: "events_api", payload: {} }));
  });
  await assert.rejects(
    () =>
      verifySocketModeConnection(VALID.appToken, {
        fetchImpl: fake.fetchImpl,
        openChannel: fake.opener,
        timeoutMs: 1000,
      }),
    (e) =>
      e instanceof SlackApiError &&
      e.slackError === "socket_mode_unexpected_event"
  );
});

test("verifySocketModeConnection は WebSocket エラーで SlackApiError を投げる", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    { payload: { ok: true, url: "wss://example.invalid/?ticket=abc" } }
  );
  const fake = fakeOpenerFor(fetch, (h) => {
    h.onError("ENETUNREACH");
  });
  await assert.rejects(
    () =>
      verifySocketModeConnection(VALID.appToken, {
        fetchImpl: fake.fetchImpl,
        openChannel: fake.opener,
        timeoutMs: 1000,
      }),
    (e) =>
      e instanceof SlackApiError &&
      e.slackError === "socket_mode_failed" &&
      /ENETUNREACH/.test(e.message)
  );
});

test("verifySocketModeConnection は apps.connections.open が ok=false なら WebSocket を開かない", async () => {
  const fetch = fakeFetch(
    { url: /\/apps\.connections\.open$/, tokenStartsWith: "xapp-" },
    { payload: { ok: false, error: "invalid_auth" } }
  );
  let openerCalled = false;
  const opener: SocketModeChannelOpener = () => {
    openerCalled = true;
    return { close: () => undefined };
  };
  await assert.rejects(
    () =>
      verifySocketModeConnection(VALID.appToken, {
        fetchImpl: fetch,
        openChannel: opener,
        timeoutMs: 1000,
      }),
    (e) => e instanceof SlackApiError && e.slackError === "invalid_auth"
  );
  assert.equal(openerCalled, false, "WebSocket must not be opened when HTTP fails");
});

test("postSlackMessage はチャンネル ID と本文を body に含める", async () => {
  const fetch = fakeFetch(
    {
      url: /\/chat\.postMessage$/,
      tokenStartsWith: "xoxb-",
      bodyIncludes: VALID.notificationChannelId,
    },
    { payload: { ok: true, channel: VALID.notificationChannelId, ts: "1.0" } }
  );
  const out = await postSlackMessage(
    VALID.botToken,
    VALID.notificationChannelId,
    "hello",
    fetch
  );
  assert.equal(out.channel, VALID.notificationChannelId);
});

test("postSlackMessage の channel_not_found は SlackApiError で返る", async () => {
  const fetch = fakeFetch(
    { url: /\/chat\.postMessage$/, tokenStartsWith: "xoxb-" },
    { payload: { ok: false, error: "channel_not_found" } }
  );
  await assert.rejects(
    () =>
      postSlackMessage(
        VALID.botToken,
        VALID.notificationChannelId,
        "hello",
        fetch
      ),
    (e) => e instanceof SlackApiError && e.slackError === "channel_not_found"
  );
});

test("buildSlackInstallationMetadata は ISO 文字列を埋める", () => {
  const socketAt = new Date("2026-05-02T12:00:00.000Z");
  const msgAt = new Date("2026-05-02T12:00:01.000Z");
  const meta = buildSlackInstallationMetadata({
    authTest: {
      ok: true,
      url: "https://example.slack.com/",
      team: "Default Workspace",
      user: "addroid_bot",
      team_id: "T012ABC",
      user_id: "U012BOT",
    },
    notificationChannelId: VALID.notificationChannelId,
    socketModeOkAt: socketAt,
    testMessageOkAt: msgAt,
  });
  assert.equal(meta.teamId, "T012ABC");
  assert.equal(meta.botUser, "addroid_bot");
  assert.equal(meta.notificationChannelId, VALID.notificationChannelId);
  assert.equal(meta.lastSocketModeTestAt, socketAt.toISOString());
  assert.equal(meta.lastTestMessageAt, msgAt.toISOString());
});

test("buildSlackInstallationMetadata は testMessageOkAt=null で lastTestMessageAt を省略する", () => {
  const meta = buildSlackInstallationMetadata({
    authTest: {
      ok: true,
      url: "https://example.slack.com/",
      team: "Default Workspace",
      user: "addroid_bot",
      team_id: "T012ABC",
      user_id: "U012BOT",
    },
    notificationChannelId: VALID.notificationChannelId,
    socketModeOkAt: new Date("2026-05-02T12:00:00.000Z"),
    testMessageOkAt: null,
  });
  assert.equal(meta.lastTestMessageAt, undefined);
});

test("redactSecretTail は末尾 4 文字以外を伏せる", () => {
  assert.equal(redactSecretTail("xoxb-1234567890-abcdef"), "[REDACTED]…cdef");
  assert.equal(redactSecretTail("short"), "[REDACTED]");
  assert.equal(redactSecretTail(""), "[REDACTED]");
});

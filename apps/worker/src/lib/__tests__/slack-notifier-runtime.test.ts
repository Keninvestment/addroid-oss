// AdDroid OSS — apps/worker Slack notifier ランタイム単体テスト (Regression fix).
//
// `createWorkerSlackNotifier` が:
//   - oauth_tokens(provider="slack") が無いとき `skipped_no_slack` を返し
//     audit_logs にも skipped_no_slack を残すこと
//   - notificationChannelId が metadata に無いとき同じく skipped_no_slack
//   - 復号失敗時に skipped_no_slack に倒れること (throw しない)
//   - 設定済み + 復号成功時に Slack chat.postMessage を 1 回呼び、
//     audit_logs に sent + slackMessageTs を残すこと
//   - HTTP 404 等で failed を返したときも throw せず audit に failed を残すこと
//
// Prisma / Slack Web API / 暗号境界はすべて in-memory fake で完結する。

import test from "node:test";
import assert from "node:assert/strict";

import type {
  CryptoBoundary,
  NotificationAuditInput,
  NotificationAuditWriter,
  SlackFetch,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";

import { createWorkerSlackNotifier } from "../slack-notifier-runtime.js";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

interface FakeOAuthTokenRow {
  provider: string;
  accessTokenCiphertext: string;
  metadata: unknown;
  connectedAt: Date;
}

function fakePrisma(rows: FakeOAuthTokenRow[]): PrismaClient {
  const fake = {
    oAuthToken: {
      findFirst: async (q: {
        where: { provider: string };
        orderBy: { connectedAt: "desc" };
        select: { accessTokenCiphertext: true; metadata: true };
      }) => {
        const matching = rows
          .filter((r) => r.provider === q.where.provider)
          .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
        const top = matching[0];
        if (!top) return null;
        return {
          accessTokenCiphertext: top.accessTokenCiphertext,
          metadata: top.metadata,
        };
      },
    },
  };
  return fake as unknown as PrismaClient;
}

function passThroughCrypto(): CryptoBoundary {
  return {
    encrypt(plaintext: string) {
      return `ct:${plaintext}`;
    },
    decrypt(ciphertext: string) {
      if (!ciphertext.startsWith("ct:")) {
        throw new Error("invalid ciphertext");
      }
      return ciphertext.slice(3);
    },
  };
}

function alwaysFailingCrypto(): CryptoBoundary {
  return {
    encrypt() {
      throw new Error("encrypt should not be called");
    },
    decrypt() {
      throw new Error("decryption boom");
    },
  };
}

function captureAudit(): {
  writer: NotificationAuditWriter;
  inputs: NotificationAuditInput[];
} {
  const inputs: NotificationAuditInput[] = [];
  return {
    writer: {
      async recordNotificationDispatch(input) {
        inputs.push(input);
      },
    },
    inputs,
  };
}

function fakeFetchOk(response: {
  ts: string;
  channel: string;
}): { fetch: SlackFetch; calls: { url: string; body: string; auth: string }[] } {
  const calls: { url: string; body: string; auth: string }[] = [];
  const fetch: SlackFetch = async (url, init) => {
    calls.push({
      url,
      body: init.body,
      auth: init.headers.Authorization ?? "",
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, ts: response.ts, channel: response.channel };
      },
      async text() {
        return JSON.stringify({
          ok: true,
          ts: response.ts,
          channel: response.channel,
        });
      },
    };
  };
  return { fetch, calls };
}

function fakeFetchHttpFailure(): {
  fetch: SlackFetch;
  calls: number;
} {
  let calls = 0;
  const fetch: SlackFetch = async () => {
    calls++;
    return {
      ok: false,
      status: 503,
      async json() {
        return {};
      },
      async text() {
        return "";
      },
    };
  };
  return {
    get calls() {
      return calls;
    },
    fetch,
  };
}

const PR_PAYLOAD = {
  kind: "pr.opened" as const,
  data: {
    prNumber: 42,
    prTitle: "AdDroid: improve cmp-1",
    prUrl: "https://github.com/acme/ops/pull/42",
    repoFullName: "acme/ops",
  },
};

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test("Slack 未設定 (oauth_tokens に slack 行なし) で skipped_no_slack を返し audit に残す", async () => {
  const audit = captureAudit();
  const notifier = createWorkerSlackNotifier({
    prisma: fakePrisma([]),
    audit: audit.writer,
    cryptoBoundary: passThroughCrypto(),
  });

  const result = await notifier.dispatch(PR_PAYLOAD);

  assert.equal(result.state, "skipped_no_slack");
  assert.equal(audit.inputs.length, 1);
  assert.equal(audit.inputs[0]!.state, "skipped_no_slack");
  assert.equal(audit.inputs[0]!.kind, "pr.opened");
});

test("notificationChannelId が metadata に無いと skipped_no_slack に倒れる", async () => {
  const audit = captureAudit();
  const notifier = createWorkerSlackNotifier({
    prisma: fakePrisma([
      {
        provider: "slack",
        accessTokenCiphertext: "ct:xoxb-123-abc",
        metadata: { teamId: "T1", botUserId: "U1" }, // no notificationChannelId
        connectedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]),
    audit: audit.writer,
    cryptoBoundary: passThroughCrypto(),
  });

  const result = await notifier.dispatch(PR_PAYLOAD);

  assert.equal(result.state, "skipped_no_slack");
  assert.equal(audit.inputs[0]!.state, "skipped_no_slack");
});

test("復号失敗時は throw せず skipped_no_slack に倒れる", async () => {
  const audit = captureAudit();
  const notifier = createWorkerSlackNotifier({
    prisma: fakePrisma([
      {
        provider: "slack",
        accessTokenCiphertext: "garbage",
        metadata: { notificationChannelId: "C0123" },
        connectedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]),
    audit: audit.writer,
    cryptoBoundary: alwaysFailingCrypto(),
  });

  const result = await notifier.dispatch(PR_PAYLOAD);

  assert.equal(result.state, "skipped_no_slack");
  assert.equal(audit.inputs[0]!.state, "skipped_no_slack");
});

test("正常パス: chat.postMessage が 1 回呼ばれ sent + audit に slackMessageTs が残る", async () => {
  const audit = captureAudit();
  const fetcher = fakeFetchOk({ ts: "1700000000.000100", channel: "C0123" });
  const notifier = createWorkerSlackNotifier({
    prisma: fakePrisma([
      {
        provider: "slack",
        accessTokenCiphertext: "ct:xoxb-token-1234",
        metadata: { notificationChannelId: "C0123" },
        connectedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]),
    audit: audit.writer,
    cryptoBoundary: passThroughCrypto(),
    slackFetch: fetcher.fetch,
  });

  const result = await notifier.dispatch(PR_PAYLOAD);

  assert.equal(result.state, "sent");
  assert.equal(result.ts, "1700000000.000100");
  assert.equal(result.channel, "C0123");
  assert.equal(fetcher.calls.length, 1);
  assert.match(fetcher.calls[0]!.url, /chat\.postMessage$/);
  assert.match(fetcher.calls[0]!.auth, /^Bearer xoxb-token-1234$/);
  assert.equal(audit.inputs.length, 1);
  assert.equal(audit.inputs[0]!.state, "sent");
  assert.equal(audit.inputs[0]!.slackMessageTs, "1700000000.000100");
  assert.equal(audit.inputs[0]!.channelId, "C0123");
});

test("Slack HTTP 失敗時は failed を返し audit にも failed が残る (throw しない)", async () => {
  const audit = captureAudit();
  const fetcher = fakeFetchHttpFailure();
  const notifier = createWorkerSlackNotifier({
    prisma: fakePrisma([
      {
        provider: "slack",
        accessTokenCiphertext: "ct:xoxb-token-aaaa",
        metadata: { notificationChannelId: "C0123" },
        connectedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]),
    audit: audit.writer,
    cryptoBoundary: passThroughCrypto(),
    slackFetch: fetcher.fetch,
  });

  const result = await notifier.dispatch(PR_PAYLOAD);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "http_503");
  assert.equal(fetcher.calls, 1);
  assert.equal(audit.inputs[0]!.state, "failed");
  assert.equal(audit.inputs[0]!.errorCode, "http_503");
});

test("payload は sanitize されてから Slack に送信される (xoxb-* / Bearer header は redact)", async () => {
  const audit = captureAudit();
  const fetcher = fakeFetchOk({ ts: "1.0", channel: "C0123" });
  const notifier = createWorkerSlackNotifier({
    prisma: fakePrisma([
      {
        provider: "slack",
        accessTokenCiphertext: "ct:xoxb-real-token-aaaa",
        metadata: { notificationChannelId: "C0123" },
        connectedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]),
    audit: audit.writer,
    cryptoBoundary: passThroughCrypto(),
    slackFetch: fetcher.fetch,
  });

  await notifier.dispatch({
    kind: "auth.revoked",
    data: {
      provider: "meta",
      accountIdentifier: "act_123",
      detail: "token leak: xoxb-stolen-token-9999 must be rotated",
      observedAt: "2026-05-02T00:00:00Z",
    },
  });

  const body = fetcher.calls[0]!.body;
  // Slack に送る Block Kit body 自体には実トークンを残さない (sanitize 済み)。
  assert.doesNotMatch(body, /xoxb-stolen-token-9999/);
  assert.match(body, /xoxb-\[REDACTED\]/);
});

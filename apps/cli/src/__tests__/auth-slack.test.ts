// `addroid auth slack` のフラグ解釈と境界エラー出力を検証する。
// DB / Slack 通信を起動しない範囲 (引数バリデーション、help、token 形式エラー、
// DATABASE_URL 未設定、ENCRYPTION_KEY 未設定) を中心に扱い、
// Slack API 側の経路はモック fetch + モック prisma で確認する。

import test from "node:test";
import assert from "node:assert/strict";

import { runAuthCommand } from "../commands/auth.js";

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture(
  fn: () => Promise<number>
): Promise<{ code: number; out: Captured }> {
  const out: Captured = { stdout: "", stderr: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    out.stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    out.stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const VALID = {
  xoxb: "xoxb-1234567890-abcdef",
  xapp: "xapp-1234567890-abcdef",
  channel: "C012ABCDEF",
};

const ENCRYPTION_KEY_B64 =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes (テスト固定値)

// Slack Socket Mode の WebSocket は実 wss:// 接続を張ってしまうため、テストでは
// `socketModeOpener` を注入して即座に hello イベントを返すフェイクを使う。
type FakeOpener = (
  url: string,
  handlers: {
    onOpen?: () => void;
    onMessage: (text: string) => void;
    onError: (reason: string) => void;
    onClose: (code: number, reason: string) => void;
  }
) => { close: () => void };

function helloOpener(): FakeOpener {
  return (_url, h) => {
    queueMicrotask(() => {
      h.onOpen?.();
      h.onMessage(
        JSON.stringify({ type: "hello", num_connections: 1 })
      );
    });
    return { close: () => undefined };
  };
}

function neverHelloOpener(): FakeOpener {
  return (_url, h) => {
    queueMicrotask(() => h.onOpen?.());
    return { close: () => undefined };
  };
}

test("auth --help は stdout に Usage を出して 0 を返す", async () => {
  const { code, out } = await capture(() => runAuthCommand(["--help"]));
  assert.equal(code, 0);
  assert.match(out.stdout, /addroid auth/);
  assert.match(out.stdout, /addroid auth slack/);
  assert.match(out.stdout, /SLACK_BOT_TOKEN/);
});

test("auth はサブコマンドなしで help を出して 0 を返す", async () => {
  const { code, out } = await capture(() => runAuthCommand([]));
  assert.equal(code, 0);
  assert.match(out.stdout, /addroid auth slack/);
});

test("auth は未対応プロバイダで 2 を返す", async () => {
  const { code, out } = await capture(() => runAuthCommand(["unknown"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /未対応のプロバイダ: unknown/);
  assert.match(out.stdout, /addroid auth slack/);
});

test("auth github は client id 未設定かつ GitHub CLI 不在で 2 を返す", async () => {
  const prismaOverride = {
    oAuthToken: {
      async upsert() {
        return {};
      },
    },
    async $disconnect() {},
  };
  const { code, out } = await withEnv(
    {
      DATABASE_URL: "postgresql://addroid:pw@localhost:5432/addroid",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      ADDROID_GITHUB_CLIENT_ID: undefined,
      ADDROID_GITHUB_OAUTH_CLIENT_ID: undefined,
      ADDROID_GITHUB_OAUTH_MOCK: undefined,
    },
    () =>
      capture(() =>
        runAuthCommand(["github", "--no-open", "--no-bootstrap"], {
          prismaOverride,
          githubGhRunner: () => ({
            status: 127,
            stdout: "",
            stderr: "gh: command not found",
          }),
        })
      )
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /GitHub CLI/);
});

test("auth github は client id 未設定なら GitHub CLI の token を暗号化保存できる", async () => {
  const calls: unknown[] = [];
  const ghCalls: string[][] = [];
  const prismaOverride = {
    oAuthToken: {
      async upsert(args: unknown) {
        calls.push(args);
        return {};
      },
    },
    async $disconnect() {},
  };
  const { code, out } = await withEnv(
    {
      DATABASE_URL: "postgresql://addroid:pw@localhost:5432/addroid",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      ADDROID_GITHUB_CLIENT_ID: undefined,
      ADDROID_GITHUB_OAUTH_CLIENT_ID: undefined,
      ADDROID_GITHUB_OAUTH_MOCK: undefined,
    },
    () =>
      capture(() =>
        runAuthCommand(["github", "--no-bootstrap", "--json"], {
          prismaOverride,
          githubGhRunner: (args) => {
            ghCalls.push(args);
            if (args.join(" ") === "--version") {
              return { status: 0, stdout: "gh version 2.0.0\n", stderr: "" };
            }
            if (args.join(" ") === "auth status --hostname github.com") {
              return { status: 0, stdout: "Logged in\n", stderr: "" };
            }
            if (args.join(" ") === "auth token --hostname github.com") {
              return { status: 0, stdout: "gho_mock_token\n", stderr: "" };
            }
            if (args.join(" ") === "api user --jq .login") {
              return { status: 0, stdout: "octocat\n", stderr: "" };
            }
            return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
          },
        })
      )
  );
  assert.equal(code, 0, out.stdout + out.stderr);
  const parsed = JSON.parse(out.stdout.slice(out.stdout.indexOf("{"))) as {
    ok: boolean;
    provider: string;
    accountIdentifier: string;
    bootstrap: { status: string; reason: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, "github");
  assert.equal(parsed.accountIdentifier, "octocat");
  assert.deepEqual(parsed.bootstrap, { status: "skipped", reason: "--no-bootstrap" });
  assert.deepEqual(ghCalls, [
    ["--version"],
    ["auth", "status", "--hostname", "github.com"],
    ["auth", "token", "--hostname", "github.com"],
    ["api", "user", "--jq", ".login"],
  ]);
  const arg = calls[0] as {
    create: { provider: string; accountIdentifier: string; accessTokenCiphertext: string };
  };
  assert.equal(arg.create.provider, "github");
  assert.equal(arg.create.accountIdentifier, "octocat");
  assert.ok(arg.create.accessTokenCiphertext.length > 20);
  assert.notEqual(arg.create.accessTokenCiphertext, "gho_mock_token");
});

test("auth github mock は token を保存し bootstrap をスキップできる", async () => {
  const calls: unknown[] = [];
  const prismaOverride = {
    oAuthToken: {
      async upsert(args: unknown) {
        calls.push(args);
        return {};
      },
    },
    async $disconnect() {},
  };
  const { code, out } = await withEnv(
    {
      DATABASE_URL: "postgresql://addroid:pw@localhost:5432/addroid",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      ADDROID_GITHUB_OAUTH_MOCK: "1",
    },
    () =>
      capture(() =>
        runAuthCommand(["github", "--no-bootstrap", "--json"], {
          prismaOverride,
        })
      )
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(out.stdout) as {
    ok: boolean;
    provider: string;
    accountIdentifier: string;
    bootstrap: { status: string; reason: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, "github");
  assert.equal(parsed.accountIdentifier, "addroid-mock-user");
  assert.deepEqual(parsed.bootstrap, { status: "skipped", reason: "--no-bootstrap" });
  assert.equal(calls.length, 1);
  const arg = calls[0] as {
    create: { provider: string; accessTokenCiphertext: string };
  };
  assert.equal(arg.create.provider, "github");
  assert.match(arg.create.accessTokenCiphertext, /^mock-encrypted::/);
});

test("auth llm は API key を暗号化して oauth_tokens に保存する", async () => {
  const calls: unknown[] = [];
  const prismaOverride = {
    oAuthToken: {
      async upsert(args: unknown) {
        calls.push(args);
        return {};
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
    async $disconnect() {},
  };
  const { code, out } = await withEnv(
    {
      DATABASE_URL: "postgresql://addroid:pw@localhost:5432/addroid",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
    },
    () =>
      capture(() =>
        runAuthCommand(
          [
            "llm",
            "--provider",
            "openai",
            "--api-key",
            "sk-test-openai-key-123456",
            "--model",
            "gpt-4.1",
          ],
          { prismaOverride }
        )
      )
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /api key\s+: encrypted/);
  assert.equal(out.stdout.includes("sk-test-openai-key"), false);
  assert.equal(calls.length, 1);
  const arg = calls[0] as {
    create: { provider: string; accessTokenCiphertext: string; metadata: Record<string, unknown> };
  };
  assert.equal(arg.create.provider, "openai");
  assert.match(arg.create.accessTokenCiphertext, /^v1\.aes256gcm\./);
  assert.equal(arg.create.accessTokenCiphertext.includes("sk-test-openai-key"), false);
  assert.deepEqual(arg.create.metadata, {
    authKind: "api_key",
    defaultModel: "gpt-4.1",
    apiBaseUrl: "https://api.openai.com/v1/chat/completions",
  });
});

test("auth llm は provider 未指定時に選択結果を使って API key を保存する", async () => {
  const calls: unknown[] = [];
  const prismaOverride = {
    oAuthToken: {
      async upsert(args: unknown) {
        calls.push(args);
        return {};
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
    async $disconnect() {},
  };
  const { code, out } = await withEnv(
    {
      DATABASE_URL: "postgresql://addroid:pw@localhost:5432/addroid",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
    },
    () =>
      capture(() =>
        runAuthCommand(["llm", "--api-key", "sk-ant-test-anthropic-key-123456"], {
          prismaOverride,
          llmSelectProvider: async () => ({
            provider: "anthropic",
            model: "claude-3-5-sonnet-latest",
          }),
        })
      )
  );
  assert.equal(code, 0);
  assert.match(out.stdout, /provider\s+: anthropic/);
  assert.equal(calls.length, 1);
  const arg = calls[0] as {
    create: { provider: string; metadata: Record<string, unknown> };
  };
  assert.equal(arg.create.provider, "anthropic");
  assert.deepEqual(arg.create.metadata, {
    authKind: "api_key",
    defaultModel: "claude-3-5-sonnet-latest",
    apiBaseUrl: "https://api.anthropic.com/v1/messages",
  });
});

test("auth llm --disconnect は provider 未指定なら失敗する", async () => {
  const { code, out } = await capture(() => runAuthCommand(["llm", "--disconnect"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /--disconnect には --provider/);
});

test("auth llm --provider codex は redirect URI 不正を分かりやすく返す", async () => {
  const prismaOverride = {
    oAuthToken: {
      async upsert() {
        return {};
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
    async $disconnect() {},
  };
  const { code, out } = await withEnv(
    {
      DATABASE_URL: "postgresql://addroid:pw@localhost:5432/addroid",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      ADDROID_CODEX_CLIENT_ID: undefined,
      ADDROID_CODEX_AUTHORIZATION_URL: undefined,
      ADDROID_CODEX_TOKEN_URL: undefined,
      ADDROID_CODEX_CHAT_COMPLETIONS_URL: undefined,
      ADDROID_CODEX_DEFAULT_MODEL: undefined,
      ADDROID_CODEX_OAUTH_REDIRECT_URI: "https://example.com/auth/callback",
    },
    () =>
      capture(() =>
        runAuthCommand(["llm", "--provider", "codex", "--no-open"], {
          prismaOverride,
        })
      )
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /localhost の redirect URI/);
});

test("auth slack はトークン未指定で 2 を返す", async () => {
  await withEnv(
    {
      SLACK_BOT_TOKEN: undefined,
      SLACK_APP_TOKEN: undefined,
      SLACK_NOTIFICATION_CHANNEL_ID: undefined,
    },
    async () => {
      const { code, out } = await capture(() => runAuthCommand(["slack"]));
      assert.equal(code, 2);
      assert.match(out.stderr, /xoxb/);
    }
  );
});

test("auth slack は不正な xoxb で 2 を返す", async () => {
  const { code, out } = await capture(() =>
    runAuthCommand([
      "slack",
      "--xoxb",
      "xoxp-not-a-bot-token",
      "--xapp",
      VALID.xapp,
      "--channel",
      VALID.channel,
    ])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /xoxb-\*/);
});

test("auth slack は --xapp に値がない場合 2 を返す", async () => {
  const { code, out } = await capture(() =>
    runAuthCommand(["slack", "--xoxb", VALID.xoxb, "--xapp"])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /--xapp に値がありません/);
});

test("auth slack は不正なチャンネル ID で 2 を返す", async () => {
  const { code, out } = await capture(() =>
    runAuthCommand([
      "slack",
      "--xoxb",
      VALID.xoxb,
      "--xapp",
      VALID.xapp,
      "--channel",
      "not-a-channel",
    ])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /チャンネル ID/);
});

test("auth slack は ENCRYPTION_KEY 未設定で 2 を返す", async () => {
  await withEnv(
    {
      ENCRYPTION_KEY: undefined,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      const { code, out } = await capture(() =>
        runAuthCommand([
          "slack",
          "--xoxb",
          VALID.xoxb,
          "--xapp",
          VALID.xapp,
          "--channel",
          VALID.channel,
        ])
      );
      assert.equal(code, 2);
      assert.match(out.stderr, /ENCRYPTION_KEY/);
    }
  );
});

test("auth slack は DATABASE_URL 未設定で 2 を返す", async () => {
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: undefined,
    },
    async () => {
      const { code, out } = await capture(() =>
        runAuthCommand([
          "slack",
          "--xoxb",
          VALID.xoxb,
          "--xapp",
          VALID.xapp,
          "--channel",
          VALID.channel,
        ])
      );
      assert.equal(code, 2);
      assert.match(out.stderr, /DATABASE_URL/);
    }
  );
});

test("auth slack は auth.test 失敗で 1 を返し oauth_tokens を書き込まない", async () => {
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      let upsertCalls = 0;
      const fakePrisma = {
        oAuthToken: {
          upsert: async () => {
            upsertCalls += 1;
            return {};
          },
        },
        $disconnect: async () => undefined,
      };
      const slackFetch = async (url: string) => {
        if (url.endsWith("/auth.test")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: false, error: "invalid_auth" }),
          };
        }
        throw new Error(`unexpected url ${url}`);
      };
      const { code, out } = await capture(() =>
        runAuthCommand(
          [
            "slack",
            "--xoxb",
            VALID.xoxb,
            "--xapp",
            VALID.xapp,
            "--channel",
            VALID.channel,
          ],
          { slackFetch, prismaOverride: fakePrisma }
        )
      );
      assert.equal(code, 1);
      assert.equal(upsertCalls, 0);
      assert.match(out.stderr, /auth\.test/);
      assert.match(out.stderr, /invalid_auth/);
    }
  );
});

test("auth slack は 3 つすべて成功で oauth_tokens に upsert し 0 を返す", async () => {
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      const upsertArgs: Array<Record<string, unknown>> = [];
      const fakePrisma = {
        oAuthToken: {
          upsert: async (args: Record<string, unknown>) => {
            upsertArgs.push(args);
            return {};
          },
        },
        $disconnect: async () => undefined,
      };
      const slackFetch = async (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string }
      ) => {
        if (url.endsWith("/auth.test")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              url: "https://example.slack.com/",
              team: "Default Workspace",
              user: "addroid_bot",
              team_id: "T012ABC",
              user_id: "U012BOT",
            }),
          };
        }
        if (url.endsWith("/apps.connections.open")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              url: "wss://wss-primary.slack.com/link/?ticket=abc",
            }),
          };
        }
        if (url.endsWith("/chat.postMessage")) {
          assert.match(init.body, new RegExp(VALID.channel));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              channel: VALID.channel,
              ts: "1.0",
            }),
          };
        }
        throw new Error(`unexpected url ${url}`);
      };
      const fixedNow = new Date("2026-05-02T12:00:00.000Z");
      const { code, out } = await capture(() =>
        runAuthCommand(
          [
            "slack",
            "--xoxb",
            VALID.xoxb,
            "--xapp",
            VALID.xapp,
            "--channel",
            VALID.channel,
            "--json",
          ],
          {
            slackFetch,
            socketModeOpener: helloOpener(),
            prismaOverride: fakePrisma,
            now: () => fixedNow,
          }
        )
      );
      assert.equal(code, 0, out.stderr);
      assert.equal(upsertArgs.length, 1);
      const args = upsertArgs[0]! as {
        where: { provider_accountIdentifier: { provider: string; accountIdentifier: string } };
        update: {
          accessTokenCiphertext: string;
          refreshTokenCiphertext: string;
          metadata: Record<string, unknown>;
        };
        create: {
          accessTokenCiphertext: string;
          refreshTokenCiphertext: string;
          metadata: Record<string, unknown>;
        };
      };
      assert.equal(args.where.provider_accountIdentifier.provider, "slack");
      assert.equal(args.where.provider_accountIdentifier.accountIdentifier, "T012ABC");
      // 平文トークンは ciphertext として保存されている (= 平文一致しない)。
      assert.notEqual(args.create.accessTokenCiphertext, VALID.xoxb);
      assert.notEqual(args.create.refreshTokenCiphertext, VALID.xapp);
      // ciphertext は v1 形式プレフィクスを持つ。
      assert.match(args.create.accessTokenCiphertext, /^v1\.aes256gcm\./);
      assert.match(args.create.refreshTokenCiphertext, /^v1\.aes256gcm\./);
      // metadata に team / channel / 直近 socket mode 時刻が入る。
      assert.equal(args.create.metadata["teamId"], "T012ABC");
      assert.equal(
        args.create.metadata["notificationChannelId"],
        VALID.channel
      );
      assert.equal(
        args.create.metadata["lastSocketModeTestAt"],
        fixedNow.toISOString()
      );
      // JSON 出力に平文トークンが漏れていない。
      assert.ok(!out.stdout.includes(VALID.xoxb));
      assert.ok(!out.stdout.includes(VALID.xapp));
      // JSON が parse 可能で ok:true を返している。
      const parsed = JSON.parse(out.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.teamId, "T012ABC");
      assert.ok(parsed.testMessageOkAt);
      assert.equal(parsed.testMessageSkipped, undefined);
    }
  );
});

test("auth slack --no-test は受け付けず exit 2 を返し oauth_tokens を書かない", async () => {
  // contract D の acceptance: テストメッセージ送信が成功するまで oauth_tokens は永続化しない。
  // `--no-test` パスは削除済みなので、未知オプションとして fail-closed で拒否する。
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      let upsertCalls = 0;
      let slackCalls = 0;
      const fakePrisma = {
        oAuthToken: {
          upsert: async () => {
            upsertCalls += 1;
            return {};
          },
        },
        $disconnect: async () => undefined,
      };
      const slackFetch = async () => {
        slackCalls += 1;
        throw new Error("slack should not be called for rejected option");
      };
      const { code, out } = await capture(() =>
        runAuthCommand(
          [
            "slack",
            "--xoxb",
            VALID.xoxb,
            "--xapp",
            VALID.xapp,
            "--channel",
            VALID.channel,
            "--no-test",
          ],
          { slackFetch, prismaOverride: fakePrisma }
        )
      );
      assert.equal(code, 2);
      assert.equal(upsertCalls, 0);
      assert.equal(slackCalls, 0);
      assert.match(out.stderr, /未知のオプション: --no-test/);
    }
  );
});

test("auth slack は chat.postMessage 失敗時に oauth_tokens を書かず exit 1 を返す", async () => {
  // fail-closed: テストメッセージが届かない限りトークンは永続化されない。
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      let upsertCalls = 0;
      const fakePrisma = {
        oAuthToken: {
          upsert: async () => {
            upsertCalls += 1;
            return {};
          },
        },
        $disconnect: async () => undefined,
      };
      const slackFetch = async (url: string) => {
        if (url.endsWith("/auth.test")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              url: "https://example.slack.com/",
              team: "Default Workspace",
              user: "addroid_bot",
              team_id: "T012ABC",
              user_id: "U012BOT",
            }),
          };
        }
        if (url.endsWith("/apps.connections.open")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, url: "wss://x" }),
          };
        }
        if (url.endsWith("/chat.postMessage")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: false, error: "channel_not_found" }),
          };
        }
        throw new Error(`unexpected url ${url}`);
      };
      const { code, out } = await capture(() =>
        runAuthCommand(
          [
            "slack",
            "--xoxb",
            VALID.xoxb,
            "--xapp",
            VALID.xapp,
            "--channel",
            VALID.channel,
          ],
          {
            slackFetch,
            socketModeOpener: helloOpener(),
            prismaOverride: fakePrisma,
          }
        )
      );
      assert.equal(code, 1);
      assert.equal(upsertCalls, 0);
      assert.match(out.stderr, /chat\.postMessage/);
      assert.match(out.stderr, /channel_not_found/);
    }
  );
});

test("auth slack は Socket Mode WebSocket が hello を返さなければ 1 を返し oauth_tokens を書かない", async () => {
  // regression fix の主回帰: the current implementation は HTTP の apps.connections.open で
  // wss URL が取れただけでは不十分で、実 WebSocket ハンドシェイクを通って
  // Slack の hello イベントを受信したことをもって Socket Mode 接続成立と
  // 判定しなければならない。hello が来ない場合は永続化しない (fail-closed)。
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      let upsertCalls = 0;
      let postMessageCalls = 0;
      const fakePrisma = {
        oAuthToken: {
          upsert: async () => {
            upsertCalls += 1;
            return {};
          },
        },
        $disconnect: async () => undefined,
      };
      const slackFetch = async (url: string) => {
        if (url.endsWith("/auth.test")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              url: "https://example.slack.com/",
              team: "Default Workspace",
              user: "addroid_bot",
              team_id: "T012ABC",
              user_id: "U012BOT",
            }),
          };
        }
        if (url.endsWith("/apps.connections.open")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, url: "wss://example.invalid/?ticket=abc" }),
          };
        }
        if (url.endsWith("/chat.postMessage")) {
          postMessageCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, channel: VALID.channel, ts: "1.0" }),
          };
        }
        throw new Error(`unexpected url ${url}`);
      };
      const { code, out } = await capture(() =>
        runAuthCommand(
          [
            "slack",
            "--xoxb",
            VALID.xoxb,
            "--xapp",
            VALID.xapp,
            "--channel",
            VALID.channel,
          ],
          {
            slackFetch,
            socketModeOpener: neverHelloOpener(),
            socketModeTimeoutMs: 25,
            prismaOverride: fakePrisma,
          }
        )
      );
      assert.equal(code, 1);
      assert.equal(upsertCalls, 0, "oauth_tokens must not be persisted on socket failure");
      assert.equal(
        postMessageCalls,
        0,
        "chat.postMessage must not run before Socket Mode is verified"
      );
      assert.match(out.stderr, /apps\.connections\.open/);
      assert.match(out.stderr, /socket_mode_timeout|hello/);
    }
  );
});

test("auth slack は Socket Mode WebSocket が hello より前に close すると 1 を返す", async () => {
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
    },
    async () => {
      let upsertCalls = 0;
      const fakePrisma = {
        oAuthToken: {
          upsert: async () => {
            upsertCalls += 1;
            return {};
          },
        },
        $disconnect: async () => undefined,
      };
      const slackFetch = async (url: string) => {
        if (url.endsWith("/auth.test")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              url: "https://example.slack.com/",
              team: "Default Workspace",
              user: "addroid_bot",
              team_id: "T012ABC",
              user_id: "U012BOT",
            }),
          };
        }
        if (url.endsWith("/apps.connections.open")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, url: "wss://example.invalid/?ticket=abc" }),
          };
        }
        throw new Error(`unexpected url ${url}`);
      };
      const closingOpener: FakeOpener = (_url, h) => {
        queueMicrotask(() => {
          h.onOpen?.();
          h.onClose(1011, "internal error");
        });
        return { close: () => undefined };
      };
      const { code, out } = await capture(() =>
        runAuthCommand(
          [
            "slack",
            "--xoxb",
            VALID.xoxb,
            "--xapp",
            VALID.xapp,
            "--channel",
            VALID.channel,
          ],
          {
            slackFetch,
            socketModeOpener: closingOpener,
            socketModeTimeoutMs: 1000,
            prismaOverride: fakePrisma,
          }
        )
      );
      assert.equal(code, 1);
      assert.equal(upsertCalls, 0);
      assert.match(out.stderr, /apps\.connections\.open/);
      assert.match(out.stderr, /closed_before_hello|hello/);
    }
  );
});

test("auth slack は環境変数フォールバックでも動作する", async () => {
  await withEnv(
    {
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
      DATABASE_URL: "postgres://localhost/x",
      SLACK_BOT_TOKEN: VALID.xoxb,
      SLACK_APP_TOKEN: VALID.xapp,
      SLACK_NOTIFICATION_CHANNEL_ID: VALID.channel,
    },
    async () => {
      const fakePrisma = {
        oAuthToken: { upsert: async () => ({}) },
        $disconnect: async () => undefined,
      };
      const slackFetch = async (url: string) => {
        if (url.endsWith("/auth.test")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              url: "https://example.slack.com/",
              team: "Default Workspace",
              user: "addroid_bot",
              team_id: "T012ABC",
              user_id: "U012BOT",
            }),
          };
        }
        if (url.endsWith("/apps.connections.open")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, url: "wss://x" }),
          };
        }
        if (url.endsWith("/chat.postMessage")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, channel: "x", ts: "1.0" }),
          };
        }
        throw new Error(`unexpected url ${url}`);
      };
      const { code } = await capture(() =>
        runAuthCommand(["slack"], {
          slackFetch,
          socketModeOpener: helloOpener(),
          prismaOverride: fakePrisma,
        })
      );
      assert.equal(code, 0);
    }
  );
});

// AdDroid OSS — Slack Socket Mode `/adops` receiver unit tests
// (Regression fix).
//
// pg-boss / Prisma / Slack を一切起動せず、`slack-socket-receiver.ts` の
// オーケストレーションだけを in-memory fake で検証する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  SLACK_COMMAND_JOB_NAME,
  startSlackSocketReceiver,
  type SlackCommandBoss,
  type SlackCommandJobPayload,
  type SlackCommandSendOptions,
  type SlackInstallation,
  type SlackResponseFetch,
  type SocketModeReceiverChannel,
  type SocketModeReceiverChannelOpener,
  type SocketModeReceiverHandlers,
  type SocketModeUrlOpener,
} from "../index.js";

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

class CapturingBoss implements SlackCommandBoss {
  sent: { name: string; data: unknown; options?: SlackCommandSendOptions }[] = [];
  defaultJobId: string | null = "pgboss-1";
  rejectDuplicateSingletons = false;
  shouldThrow = false;
  async send(
    name: string,
    data: unknown,
    options?: SlackCommandSendOptions
  ): Promise<string | null> {
    if (this.shouldThrow) throw new Error("boss exploded");
    if (
      this.rejectDuplicateSingletons &&
      options?.singletonKey &&
      this.sent.some((s) => s.options?.singletonKey === options.singletonKey)
    ) {
      this.sent.push({ name, data, ...(options ? { options } : {}) });
      return null;
    }
    this.sent.push({ name, data, ...(options ? { options } : {}) });
    return this.defaultJobId;
  }
}

interface FakeChannel extends SocketModeReceiverChannel {
  /** caller (= receiver) が send で書き出した envelope ack 文字列。 */
  sentMessages: string[];
  /** 直前に開いた WebSocket の wss URL。 */
  url: string;
  /** receiver の onOpen / onMessage / onError / onClose を Slack 側から手動で叩く。 */
  fire: SocketModeReceiverHandlers;
  /** close() が呼ばれた回数。 */
  closeCount: number;
}

function makeFakeOpener(): {
  opener: SocketModeReceiverChannelOpener;
  channels: FakeChannel[];
} {
  const channels: FakeChannel[] = [];
  const opener: SocketModeReceiverChannelOpener = (url, handlers) => {
    const sent: string[] = [];
    let closeCount = 0;
    const channel: FakeChannel = {
      url,
      sentMessages: sent,
      closeCount: 0,
      send(text: string) {
        sent.push(text);
      },
      close() {
        closeCount += 1;
        channel.closeCount = closeCount;
      },
      fire: handlers,
    };
    channels.push(channel);
    return channel;
  };
  return { opener, channels };
}

function makeUrlOpener(
  url = "wss://wss-primary.slack.com/link?ticket=abc"
): SocketModeUrlOpener {
  return async () => ({ url });
}

function VALID_INSTALLATION(): SlackInstallation {
  return {
    botToken: "xoxb-1234567890-abcdefghij",
    appToken: "xapp-1234567890-abcdefghij",
    teamId: "T012ABC",
    teamName: "AdDroid Workspace",
    notificationChannelId: "C012ABC",
    botUserId: "U0BOT",
  };
}

function helloEnvelope(): string {
  return JSON.stringify({
    type: "hello",
    num_connections: 1,
    debug_info: { host: "applink-test" },
  });
}

function slashEnvelope(opts: {
  envelopeId: string;
  text?: string;
  command?: string;
  userId?: string;
  channelId?: string;
  responseUrl?: string;
  teamId?: string;
}): string {
  return JSON.stringify({
    envelope_id: opts.envelopeId,
    type: "slash_commands",
    accepts_response_payload: true,
    payload: {
      command: opts.command ?? "/adops",
      text: opts.text ?? "report",
      user_id: opts.userId ?? "U012ABC",
      user_name: "alice",
      channel_id: opts.channelId ?? "C012ABC",
      team_id: opts.teamId ?? "T012ABC",
      response_url:
        opts.responseUrl ?? "https://hooks.slack.com/commands/T1/2/abc",
      trigger_id: "trig",
    },
  });
}

/** 1 tick await して microtask キューを排出する。 */
const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

interface CapturedSlackResponsePost {
  url: string;
  body: string;
}

/**
 * `response_url` に対する follow-up POST を観測する fake。
 * `postSlackResponse` のシグネチャをそのまま満たす。
 */
function makeCapturingResponseFetch(opts?: {
  ok?: boolean;
  status?: number;
}): { fetchImpl: SlackResponseFetch; calls: CapturedSlackResponsePost[] } {
  const calls: CapturedSlackResponsePost[] = [];
  const fetchImpl: SlackResponseFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: opts?.ok ?? true, status: opts?.status ?? 200 };
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------
// 0) optional integration: skip cleanly when unconfigured
// ---------------------------------------------------------------------

test("startSlackSocketReceiver: installationLoader が null を返したら state=unconfigured で起動 skip", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const urlOpener = makeUrlOpener();
  let urlCalled = 0;
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => null,
    urlOpener: async (token) => {
      urlCalled += 1;
      return urlOpener(token);
    },
    channelOpener: opener,
    boss,
  });
  assert.equal(handle.getState(), "unconfigured");
  assert.equal(urlCalled, 0, "Slack 未設定のとき Slack API は叩かない");
  assert.equal(channels.length, 0, "Slack 未設定のとき WebSocket を開かない");
  assert.equal(boss.sent.length, 0);
  await handle.stop();
  assert.equal(handle.getState(), "stopped");
});

test("startSlackSocketReceiver: installationLoader が throw しても worker は落とさず state=failed", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => {
      throw new Error("DB exploded");
    },
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  assert.equal(handle.getState(), "failed");
  assert.equal(channels.length, 0);
  await handle.stop();
});

// ---------------------------------------------------------------------
// 1) connect happy path
// ---------------------------------------------------------------------

test("startSlackSocketReceiver: 起動時に apps.connections.open → wss → hello 受信で connected", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  let urlOpenerCalls = 0;
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: async (token) => {
      urlOpenerCalls += 1;
      assert.equal(token, "xapp-1234567890-abcdefghij");
      return { url: "wss://wss-primary.slack.com/link?ticket=abc" };
    },
    channelOpener: opener,
    boss,
  });
  // urlOpener は async だが connectOnce は fire-and-forget なので flush で待つ。
  await flush();
  assert.equal(urlOpenerCalls, 1);
  assert.equal(channels.length, 1);
  assert.match(channels[0]!.url, /^wss:\/\//);

  channels[0]!.fire.onMessage(helloEnvelope());
  assert.equal(handle.getState(), "connected");
  await handle.stop();
  assert.equal(channels[0]!.closeCount, 1, "stop() で WebSocket を閉じる");
});

// ---------------------------------------------------------------------
// 2) slash_commands envelope: parse → ack within 3s → enqueue
// ---------------------------------------------------------------------

test("startSlackSocketReceiver: slash_commands envelope を即時 ack して pg-boss に enqueue する", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  // /adops report を 1 件流す。
  const start = Date.now();
  ch.fire.onMessage(
    slashEnvelope({ envelopeId: "env-001", text: "report" })
  );
  // enqueue は async だが ack は同期で send される (3 秒以内 ack 契約)。
  await flush();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `ack が遅すぎます: ${elapsed}ms`);

  // 1 通の ack envelope (envelope_id 同梱) が WebSocket に書き出されている。
  assert.equal(ch.sentMessages.length, 1, "ack を 1 通だけ送るべき");
  const ack = JSON.parse(ch.sentMessages[0]!);
  assert.equal(ack.envelope_id, "env-001");
  assert.equal(ack.payload?.response_type, "ephemeral");
  assert.match(ack.payload?.text ?? "", /\/adops report/);
  assert.match(ack.payload?.text ?? "", /受け付けました/);

  // pg-boss に 1 件 enqueue された。
  assert.equal(boss.sent.length, 1);
  assert.equal(boss.sent[0]!.name, SLACK_COMMAND_JOB_NAME);
  const payload = boss.sent[0]!.data as SlackCommandJobPayload;
  assert.equal(payload.subcommand, "report");
  assert.equal(payload.slackUserId, "U012ABC");
  assert.equal(payload.slackChannelId, "C012ABC");
  assert.equal(
    payload.responseUrl,
    "https://hooks.slack.com/commands/T1/2/abc"
  );

  await handle.stop();
});

test("startSlackSocketReceiver: ack は pg-boss enqueue I/O を待たずに先に WebSocket に書き出される", async () => {
  // boss.send を解決させない (= enqueue が無限に保留) ことで、ack が enqueue
  // 完了に依存していたら検出される — ack が同期で先に出ているはず。
  const pendingResolvers: ((id: string | null) => void)[] = [];
  const blockingBoss: SlackCommandBoss = {
    async send() {
      return await new Promise<string | null>((resolve) => {
        pendingResolvers.push(resolve);
      });
    },
  };
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss: blockingBoss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(
    slashEnvelope({ envelopeId: "env-ack-first", text: "report" })
  );
  // enqueue は未解決 (resolveSend を呼んでいない) 状態だが、ack は同期で
  // WebSocket に書き出されている必要がある。
  assert.equal(
    ch.sentMessages.length,
    1,
    "ack は enqueue 解決を待たずに送信される"
  );
  const ack = JSON.parse(ch.sentMessages[0]!);
  assert.equal(ack.envelope_id, "env-ack-first");
  assert.match(ack.payload?.text ?? "", /受け付けました/);

  // 後始末: handle.stop() が enqueue の保留 Promise に巻き込まれないよう
  // 手動で resolve しておく。
  for (const r of pendingResolvers) r("late-job-id");
  await flush();
  await handle.stop();
});

test("startSlackSocketReceiver: parse 失敗時は ack に usage を埋め込み enqueue を skip", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(
    slashEnvelope({ envelopeId: "env-002", text: "delete-everything" })
  );
  await flush();

  assert.equal(boss.sent.length, 0, "parse 失敗時は enqueue しない");
  assert.equal(ch.sentMessages.length, 1);
  const ack = JSON.parse(ch.sentMessages[0]!);
  assert.equal(ack.envelope_id, "env-002");
  assert.match(ack.payload?.text ?? "", /未対応/);

  await handle.stop();
});

test("startSlackSocketReceiver: activate に target が無い場合は ack に usage を返し enqueue を skip", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(
    slashEnvelope({ envelopeId: "env-003", text: "activate" })
  );
  await flush();

  assert.equal(boss.sent.length, 0);
  assert.equal(ch.sentMessages.length, 1);
  const ack = JSON.parse(ch.sentMessages[0]!);
  assert.match(ack.payload?.text ?? "", /activate <ads_hierarchy_id>/);

  await handle.stop();
});

test("startSlackSocketReceiver: 重複 envelope_id は 2 回目以降 ack のみで enqueue を抑止 (Slack 再送対策)", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(slashEnvelope({ envelopeId: "env-dup", text: "report" }));
  await flush();
  ch.fire.onMessage(slashEnvelope({ envelopeId: "env-dup", text: "report" }));
  await flush();

  assert.equal(boss.sent.length, 1, "同じ envelope_id は 1 回しか enqueue しない");
  assert.equal(ch.sentMessages.length, 2, "両方の envelope に ack は返す");

  await handle.stop();
});

test("startSlackSocketReceiver: enqueue 失敗 (boss.send が throw) でも ack は標準テキストで先に返し、失敗は response_url で追補する", async () => {
  const boss = new CapturingBoss();
  boss.shouldThrow = true;
  const { opener, channels } = makeFakeOpener();
  const { fetchImpl, calls } = makeCapturingResponseFetch();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
    responseFetch: fetchImpl,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(slashEnvelope({ envelopeId: "env-fail", text: "report" }));
  // ack は enqueue 失敗を待たず同期で送られるはず — まずそれを確認。
  assert.equal(
    ch.sentMessages.length,
    1,
    "ack は enqueue I/O を待たずに同期で送られる"
  );
  const ack = JSON.parse(ch.sentMessages[0]!);
  assert.equal(ack.envelope_id, "env-fail");
  assert.match(
    ack.payload?.text ?? "",
    /受け付けました/,
    "ack は enqueue 失敗を待たない以上、標準の '受け付けました' テキスト"
  );

  // enqueue 失敗の通知は response_url の follow-up に乗って届く。
  await flush(10);
  assert.equal(calls.length, 1, "失敗時は response_url に 1 回 POST する");
  const followUp = JSON.parse(calls[0]!.body);
  assert.match(
    followUp.text ?? "",
    /キューへの登録に失敗|GitOps polling \/ Apply \/ Cron は通常通り稼働/
  );

  // ack 後に new envelope は来ていないはず (Slack 側の再送は ack で止まる)。
  assert.equal(ch.sentMessages.length, 1, "ack は 1 通のまま");

  await handle.stop();
});

test("startSlackSocketReceiver: singletonKey で reject (重複連打) されたら ack は標準で先に返し、重複の通知は response_url で追補する", async () => {
  const boss = new CapturingBoss();
  boss.rejectDuplicateSingletons = true;
  const { opener, channels } = makeFakeOpener();
  const { fetchImpl, calls } = makeCapturingResponseFetch();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
    responseFetch: fetchImpl,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(slashEnvelope({ envelopeId: "env-A", text: "report" }));
  ch.fire.onMessage(slashEnvelope({ envelopeId: "env-B", text: "report" }));
  await flush(10);

  assert.equal(boss.sent.length, 2, "boss.send は両方とも呼ばれる (singletonKey 判定は boss 側責務)");
  assert.equal(ch.sentMessages.length, 2);
  // ack は両方とも標準の "受け付けました" テキストになる (3 秒以内 ack 契約)。
  const ack2 = JSON.parse(ch.sentMessages[1]!);
  assert.match(ack2.payload?.text ?? "", /受け付けました/);

  // 2 件目のみ singletonKey で reject されたので response_url に 1 回だけ追補される。
  assert.equal(calls.length, 1, "重複検知時のみ response_url に follow-up を送る");
  const followUp = JSON.parse(calls[0]!.body);
  assert.match(followUp.text ?? "", /まだ実行中|完了後に再実行/);

  await handle.stop();
});

// ---------------------------------------------------------------------
// 3) other envelope types
// ---------------------------------------------------------------------

test("startSlackSocketReceiver: 未対応 type (events_api 等) の envelope は ack のみで握り潰す", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(
    JSON.stringify({
      envelope_id: "env-evt",
      type: "events_api",
      payload: { event: { type: "message", text: "hi" } },
    })
  );

  assert.equal(boss.sent.length, 0);
  assert.equal(ch.sentMessages.length, 1);
  const ack = JSON.parse(ch.sentMessages[0]!);
  assert.equal(ack.envelope_id, "env-evt");
  assert.equal(ack.payload, undefined, "未対応 type は payload 無し ack");

  await handle.stop();
});

test("startSlackSocketReceiver: 非 JSON / JSON だが object でない値は無視 (throw しない)", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage("not-json");
  ch.fire.onMessage("123");
  ch.fire.onMessage('"a string"');

  assert.equal(boss.sent.length, 0);
  assert.equal(ch.sentMessages.length, 0, "JSON object でない場合は ack しない");

  await handle.stop();
});

// ---------------------------------------------------------------------
// 4) reconnect / lifecycle
// ---------------------------------------------------------------------

test("startSlackSocketReceiver: WebSocket close で reconnect が schedule される", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const timers: { cb: () => void; ms: number }[] = [];
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
    setTimeoutImpl: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimeoutImpl: () => undefined,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());
  // hello 受信時の helloTimer は connecting 段階で 1 件登録されている。
  assert.ok(timers.length >= 1);

  // Slack 側から close されたら reconnect timer が積まれる。
  const beforeReconnectTimers = timers.length;
  ch.fire.onClose(1006, "abnormal");
  assert.ok(timers.length > beforeReconnectTimers, "reconnect timer がスケジュールされる");
  assert.equal(handle.getState(), "reconnecting");

  // 再接続 cb を発火 → 2 本目の WebSocket が開く。
  const reconnectTimer = timers[timers.length - 1]!;
  reconnectTimer.cb();
  await flush();
  assert.equal(channels.length, 2, "再接続で 2 本目の WebSocket を開く");

  channels[1]!.fire.onMessage(helloEnvelope());
  assert.equal(handle.getState(), "connected");

  await handle.stop();
});

test("startSlackSocketReceiver: Slack 計画切断 (type=disconnect) も reconnect を起こす", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const timers: { cb: () => void; ms: number }[] = [];
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
    setTimeoutImpl: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimeoutImpl: () => undefined,
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  ch.fire.onMessage(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
  assert.equal(handle.getState(), "reconnecting");

  // 直近 timer (= reconnect) 発火で 2 本目を開く。
  const reconnectTimer = timers[timers.length - 1]!;
  reconnectTimer.cb();
  await flush();
  assert.equal(channels.length, 2);

  await handle.stop();
});

test("startSlackSocketReceiver: stop() は reconnect timer を解除し close を 1 回だけ呼ぶ (idempotent)", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  let cleared = 0;
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: makeUrlOpener(),
    channelOpener: opener,
    boss,
    setTimeoutImpl: () => "T",
    clearTimeoutImpl: () => {
      cleared += 1;
    },
  });
  await flush();
  const ch = channels[0]!;
  ch.fire.onMessage(helloEnvelope());

  await handle.stop();
  await handle.stop();
  assert.equal(handle.getState(), "stopped");
  assert.equal(ch.closeCount, 1, "WebSocket は 1 回だけ close する");
  assert.ok(cleared >= 1, "保留中の timer は解除する");
});

test("startSlackSocketReceiver: urlOpener が throw しても reconnect が schedule され、worker は停止しない", async () => {
  const boss = new CapturingBoss();
  const { opener, channels } = makeFakeOpener();
  const timers: { cb: () => void; ms: number }[] = [];
  let urlOpenerCalls = 0;
  const handle = await startSlackSocketReceiver({
    installationLoader: async () => VALID_INSTALLATION(),
    urlOpener: async () => {
      urlOpenerCalls += 1;
      throw new Error("apps.connections.open boom");
    },
    channelOpener: opener,
    boss,
    setTimeoutImpl: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimeoutImpl: () => undefined,
  });
  await flush();
  assert.equal(urlOpenerCalls, 1);
  assert.equal(channels.length, 0);
  assert.equal(handle.getState(), "reconnecting");
  assert.ok(timers.length >= 1, "reconnect timer がスケジュールされる");

  await handle.stop();
});

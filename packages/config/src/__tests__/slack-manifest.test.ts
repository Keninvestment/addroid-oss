// AdDroid OSS — Slack App Manifest unit test.
//
// 本テストは Slack App Manifest テンプレートが the current implementation の不変条件を満たすことを
// 回帰テストで固定する。すなわち:
//   - Socket Mode が有効化されていること (public な request URL を持たない)
//   - /adops slash command が登録され、the current implementation の 6 サブコマンドが usage_hint に
//     列挙されていること
//   - 必須 bot scopes (chat:write, commands, channels:read, users:read) が宣言されて
//     いること
//   - interactivity が有効化されていること (request_url を伴わない)
//   - workspace display name のプレースホルダがレンダリング後に消えていること
//   - YAML / JSON 双方の表現を返すこと

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  SLACK_APP_MANIFEST_TEMPLATE_PATH,
  SLACK_BOT_SCOPES,
  SLACK_SLASH_COMMAND,
  SLACK_SLASH_SUBCOMMANDS,
  buildSlackAppManifest,
} from "../slack-manifest.js";

const SAMPLE_INPUT = {
  workspaceDisplayName: "Default Workspace",
};

test("Slack manifest テンプレートファイルが templates/ 直下に存在する", () => {
  assert.equal(
    fs.existsSync(SLACK_APP_MANIFEST_TEMPLATE_PATH),
    true,
    `expected slack manifest template at ${SLACK_APP_MANIFEST_TEMPLATE_PATH}`
  );
  assert.match(
    SLACK_APP_MANIFEST_TEMPLATE_PATH,
    /templates[\\/]slack-app-manifest\.yaml$/
  );
});

test("Slack manifest は Socket Mode を有効化している", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  assert.equal(built.manifest.settings.socket_mode_enabled, true);
});

test("Slack manifest は public な request URL を一切含まない (Socket Mode only)", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  assert.equal(
    built.manifest.settings.interactivity?.request_url,
    undefined,
    "interactivity.request_url must be absent"
  );
  assert.equal(
    built.manifest.settings.event_subscriptions?.request_url,
    undefined,
    "event_subscriptions.request_url must be absent"
  );
  // YAML キーとしての `request_url:` (コメント以外の任意位置) が出現しないこと。
  // 行頭が `#` のコメント行は除外したうえで `request_url` キーを検索する。
  const nonCommentYaml = built.yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.equal(
    /request_url\s*:/.test(nonCommentYaml),
    false,
    "rendered manifest must not declare request_url as a YAML key"
  );
});

test("Slack manifest は /adops slash command を public URL なしで登録している", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  const cmds = built.manifest.features.slash_commands ?? [];
  const adops = cmds.find((c) => c.command === SLACK_SLASH_COMMAND);
  assert.ok(adops, `slash command ${SLACK_SLASH_COMMAND} must be present`);
  assert.equal(
    adops!.url,
    undefined,
    `slash command ${SLACK_SLASH_COMMAND} must not expose a public url`
  );
});

test("Slack manifest の /adops usage_hint に the current implementation サブコマンドが網羅されている", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  const adops = (built.manifest.features.slash_commands ?? []).find(
    (c) => c.command === SLACK_SLASH_COMMAND
  );
  assert.ok(adops);
  for (const sub of SLACK_SLASH_SUBCOMMANDS) {
    assert.match(
      adops!.usage_hint ?? "",
      new RegExp(`\\b${sub}\\b`),
      `usage_hint should mention subcommand ${sub}`
    );
  }
});

test("Slack manifest は the current implementation 必須の bot scopes をすべて宣言している", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  const scopes = built.manifest.oauth_config.scopes.bot ?? [];
  for (const required of SLACK_BOT_SCOPES) {
    assert.ok(
      scopes.includes(required),
      `bot scope ${required} should be declared`
    );
  }
});

test("Slack manifest は interactivity を有効化している (request URL を伴わない)", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  assert.equal(built.manifest.settings.interactivity?.is_enabled, true);
  assert.equal(built.manifest.settings.interactivity?.request_url, undefined);
});

test("Slack manifest はワークスペース名プレースホルダを差し込み残置しない", () => {
  const built = buildSlackAppManifest({
    workspaceDisplayName: "Acme Marketing",
  });
  assert.match(
    built.manifest.display_information.description ?? "",
    /Acme Marketing/
  );
  assert.equal(
    built.yaml.includes("{{"),
    false,
    "rendered YAML should not retain any unresolved placeholder"
  );
});

test("Slack manifest は YAML / JSON 双方の表現を返し、JSON は再パース可能", () => {
  const built = buildSlackAppManifest(SAMPLE_INPUT);
  assert.ok(built.yaml.length > 0);
  assert.ok(built.json.length > 0);
  const reparsed = JSON.parse(built.json);
  assert.equal(reparsed.settings.socket_mode_enabled, true);
});

test("SLACK_SLASH_SUBCOMMANDS は the current implementation で要求された 6 サブコマンドを列挙する", () => {
  // report / budget / improve / status / accounts / activate
  assert.deepEqual(
    [...SLACK_SLASH_SUBCOMMANDS].sort(),
    ["accounts", "activate", "budget", "improve", "report", "status"]
  );
});

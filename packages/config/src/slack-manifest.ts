// AdDroid OSS — Slack App Manifest builder (the current implementation, optional integration).
//
// 本モジュールは `templates/slack-app-manifest.yaml` を読み込み、ワークスペース
// 固有の値 (display name など) を差し込んで返す純粋なローダです。Slack 連携は
// 完全に任意 (Slack 未設定でも AdDroid は通常通り稼働) であり、ここで返す
// マニフェストは Socket Mode 専用 — public な request URL / 公開ドメインを
// 一切含みません。
//
// 実 Slack トークン (xoxb-* / xapp-* / signing_secret) は本モジュールでは扱わず、
// 別パスで `oauth_tokens.accessTokenCiphertext` 等に暗号化保存されます。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/**
 * AdDroid Slack app に必要な bot scopes (the current implementation)。
 *  - chat:write     : 通知メッセージを送信
 *  - commands       : /adops slash command の登録
 *  - channels:read  : 通知先チャンネル名解決
 *  - users:read     : actor 表示用に Slack user 情報を解決
 */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "commands",
  "channels:read",
  "users:read",
] as const;

export type SlackBotScope = (typeof SLACK_BOT_SCOPES)[number];

/** AdDroid が登録する単一 root slash command。 */
export const SLACK_SLASH_COMMAND = "/adops" as const;

/**
 * `/adops` 配下のサブコマンド (the current implementation)。すべて 3 秒以内 ack →
 * pg-boss enqueue → response_url で結果返却の契約に従う。`activate` のみ
 * PR 承認とは別の audited 操作として Slack 起点を許容する。
 */
export const SLACK_SLASH_SUBCOMMANDS = [
  "report",
  "budget",
  "improve",
  "status",
  "accounts",
  "activate",
] as const;

export type SlackSlashSubcommand = (typeof SLACK_SLASH_SUBCOMMANDS)[number];

const TEMPLATE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates/slack-app-manifest.yaml"
);

/** マニフェストテンプレートの絶対パス (テスト・doctor からの存在確認用)。 */
export const SLACK_APP_MANIFEST_TEMPLATE_PATH = TEMPLATE_FILE;

export interface SlackAppManifestInput {
  /**
   * 表示用ワークスペース名 (UI 上の人読み名)。例: "Default Workspace"。
   * `addroid init` が生成する `~/.addroid/config.yaml > workspace.displayName`
   * と同じ値を渡す想定。
   */
  workspaceDisplayName: string;
}

export interface SlackAppManifest {
  display_information: {
    name: string;
    description?: string;
    long_description?: string;
    background_color?: string;
  };
  features: {
    bot_user?: { display_name: string; always_online?: boolean };
    slash_commands?: Array<{
      command: string;
      description?: string;
      usage_hint?: string;
      should_escape?: boolean;
      url?: string;
    }>;
  };
  oauth_config: {
    scopes: { bot?: string[]; user?: string[] };
  };
  settings: {
    socket_mode_enabled: boolean;
    interactivity?: { is_enabled: boolean; request_url?: string };
    event_subscriptions?: { request_url?: string };
    org_deploy_enabled?: boolean;
    token_rotation_enabled?: boolean;
  };
}

export interface BuiltSlackAppManifest {
  /** YAML 表現。Slack の "From an app manifest" にそのまま貼り付け可能。 */
  yaml: string;
  /** JSON 表現。UI 表示や JSON 派遣エンドポイント向け。 */
  json: string;
  /** 構造化済みオブジェクト。テスト・UI レンダリングから読みやすい。 */
  manifest: SlackAppManifest;
}

/**
 * ワークスペース固有値を差し込んだ Slack App Manifest を返す。
 *
 * Socket Mode 専用の不変条件 (request URL を持たないこと、必須 bot scopes が
 * 揃っていること) を内部で検証し、不正なテンプレート編集が行われた場合は
 * 早期に throw する。
 */
export function buildSlackAppManifest(
  input: SlackAppManifestInput
): BuiltSlackAppManifest {
  const raw = fs.readFileSync(TEMPLATE_FILE, "utf8");
  const yamlText = substituteContent(raw, {
    workspaceDisplayName: input.workspaceDisplayName,
  });
  const parsed = YAML.parse(yamlText) as unknown;
  const manifest = ensureValidManifestShape(parsed);
  return {
    yaml: yamlText,
    json: JSON.stringify(manifest, null, 2) + "\n",
    manifest,
  };
}

function substituteContent(
  source: string,
  values: Record<string, string>
): string {
  return source.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g,
    (_match, key: string) => {
      const v = values[key];
      if (v === undefined) {
        throw new Error(`Unknown slack manifest placeholder: {{${key}}}`);
      }
      return v;
    }
  );
}

function ensureValidManifestShape(parsed: unknown): SlackAppManifest {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Slack manifest template did not parse to an object");
  }
  const m = parsed as SlackAppManifest;
  if (!m.settings || m.settings.socket_mode_enabled !== true) {
    throw new Error(
      "Slack manifest must enable Socket Mode (settings.socket_mode_enabled: true)"
    );
  }
  if (m.settings.interactivity?.request_url !== undefined) {
    throw new Error(
      "Slack manifest must not contain settings.interactivity.request_url (Socket Mode only)"
    );
  }
  if (m.settings.event_subscriptions?.request_url !== undefined) {
    throw new Error(
      "Slack manifest must not contain settings.event_subscriptions.request_url (Socket Mode only)"
    );
  }
  for (const cmd of m.features?.slash_commands ?? []) {
    if (cmd.url !== undefined) {
      throw new Error(
        `Slack slash command '${cmd.command}' must not contain a public 'url' (Socket Mode only)`
      );
    }
  }
  const scopes = m.oauth_config?.scopes?.bot ?? [];
  for (const required of SLACK_BOT_SCOPES) {
    if (!scopes.includes(required)) {
      throw new Error(
        `Slack manifest is missing required bot scope: ${required}`
      );
    }
  }
  return m;
}

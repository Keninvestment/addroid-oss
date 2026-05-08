export type AgentSurface = "cli-chat" | "web-chat" | "scheduled-agent";

export type AgentToolEffect =
  | "read"
  | "local-write"
  | "queue"
  | "gitops-pr"
  | "audited-meta-activate";

export interface AgentToolDefinition {
  name: string;
  description: string;
  args: string;
  effects: AgentToolEffect[];
  allowedSurfaces: AgentSurface[];
  guidance?: string;
}

export const AGENT_TOOL_MANIFEST = [
  {
    name: "diagnose",
    description: "AdDroid の詳細診断を実行する。",
    args: "{}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "scheduled-agent"],
  },
  {
    name: "check_status",
    description: "接続、DB、worker、GitHub などの状態を確認する。",
    args: "{}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "scheduled-agent"],
  },
  {
    name: "list_ad_accounts",
    description: "登録済みの Meta 広告アカウントを確認する。",
    args: "{json?: boolean}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "scheduled-agent"],
  },
  {
    name: "sync_ad_accounts",
    description: "Meta から広告アカウントを同期する。",
    args: "{selectDefault?: boolean,json?: boolean}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat"],
  },
  {
    name: "select_ad_account",
    description: "デフォルト広告アカウントを選択する。",
    args: "{adAccountId?: string,key?: string,json?: boolean}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat"],
  },
  {
    name: "connect_service",
    description: "Meta / GitHub / AI / Slack の接続フローを開始または案内する。",
    args: "{service:'meta'|'github'|'ai'|'slack', aiProvider?:'codex'|'openai'|'anthropic'}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat"],
  },
  {
    name: "get_report",
    description: "日次レポート、予算チェック、改善提案を今すぐ実行する。",
    args: "{kind?:'daily'|'budget'|'improvement', metricDate?:'YYYY-MM-DD', metricDateRelative?:'today'|'yesterday'}",
    effects: ["queue"],
    allowedSurfaces: ["cli-chat", "web-chat", "scheduled-agent"],
    guidance:
      "Use metricDateRelative for relative dates, especially in scheduled-agent tasks. For '前日' or '昨日', use metricDateRelative:'yesterday'.",
  },
  {
    name: "check_submission",
    description: "ops repo の入稿内容を validate し、dry-run の変更予定を表示する。Meta には反映しない。",
    args: "{root?: string,base?: string,account?: string,save?: boolean}",
    effects: ["read", "local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "scheduled-agent"],
  },
  {
    name: "create_scheduled_agent_task",
    description:
      "自然言語の定期タスクを保存し、有効化する。定期レポートや継続チェックの依頼は preset schedule ではなく通常この tool を使う。",
    args: "{prompt:string, cron:string, title?:string, runNow?:boolean}",
    effects: ["local-write", "queue"],
    allowedSurfaces: ["cli-chat", "web-chat"],
    guidance:
      "For '毎朝9時に前日のレポート', save a prompt that still says '前日分の日次レポートを作成して要約する' and cron '0 9 * * *'.",
  },
  {
    name: "set_schedule_enabled",
    description:
      "既存の pg-boss preset schedule を cron と enabled 状態込みで更新する。preset 自体の ON/OFF が明示された場合に使う。",
    args: "{preset:'daily'|'budget'|'improvement'|'github'|'retention'|'agent_tasks', cron?: string, enabled:boolean}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat"],
    guidance:
      "If the user asks to schedule a business task in natural language, prefer create_scheduled_agent_task. Use this only when they refer to an existing preset schedule.",
  },
  {
    name: "manage_schedule",
    description: "既存 preset schedule の一覧、履歴、または単発実行を扱う。",
    args: "{action:'list'|'run'|'logs', preset?:'daily'|'budget'|'improvement'|'github'|'retention'|'agent_tasks', limit?: number}",
    effects: ["read", "queue"],
    allowedSurfaces: ["cli-chat", "web-chat", "scheduled-agent"],
  },
  {
    name: "show_logs",
    description: "AdDroid の運用ログを表示する。",
    args: "{target?:'up'|'web'|'worker'|'all', lines?: number}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat"],
  },
  {
    name: "stop_services",
    description: "ローカル AdDroid プロセスを停止する。",
    args: "{}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat"],
  },
  {
    name: "start_delivery",
    description: "既存 PAUSED Meta オブジェクトを audited activate path で有効化する。",
    args: "{hierarchyId:string,note?:string,json?:boolean}",
    effects: ["audited-meta-activate"],
    allowedSurfaces: ["cli-chat"],
  },
  {
    name: "backup_data",
    description: "AdDroid データベースのバックアップを作成する。",
    args: "{}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat"],
  },
  {
    name: "open_web_ui",
    description: "ローカル Web UI の URL を表示する。",
    args: "{}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat"],
  },
  {
    name: "query_meta_ads",
    description: "Meta Ads CLI の read-only query を実行する。",
    args: "{resource:'insights'|'adaccount'|'campaign'|'adset'|'ad'|'creative'|'catalog'|'dataset'|'page'|'product_feed'|'product_item'|'product_set', action?:'get'|'list'|'current', accountKey?:string, businessId?:string, catalogId?:string, since?:'YYYY-MM-DD', until?:'YYYY-MM-DD', datePreset?:'today'|'yesterday'|'last_3d'|'last_7d'|'last_14d'|'last_30d'|'last_90d'|'this_month'|'last_month', timeIncrement?:'daily'|'weekly'|'monthly'|'all_days', breakdowns?:string[], fields?:string[], campaignId?:string, adsetId?:string, adId?:string, id?:string, limit?:number}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat"],
  },
] as const satisfies readonly AgentToolDefinition[];

export type AgentToolName = (typeof AGENT_TOOL_MANIFEST)[number]["name"];

export function getAgentToolsForSurface(
  surface: AgentSurface
): readonly AgentToolDefinition[] {
  return AGENT_TOOL_MANIFEST.filter((tool) =>
    (tool.allowedSurfaces as readonly AgentSurface[]).includes(surface)
  );
}

export function renderToolManifestForPrompt(surface: AgentSurface): string {
  return getAgentToolsForSurface(surface)
    .map((tool) => {
      const guidance = tool.guidance ? ` ${tool.guidance}` : "";
      return `- ${tool.name}: ${tool.description} args ${tool.args}.${guidance}`;
    })
    .join("\n");
}

export function isToolAllowedOnSurface(
  toolName: string,
  surface: AgentSurface
): boolean {
  const normalized = toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return getAgentToolsForSurface(surface).some((tool) => tool.name === normalized);
}

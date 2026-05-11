// AdDroid OSS — AI Workflows landing (the current implementation browser regression fix)。
//
// Browser test scenario `ai-provider-runs` は `/ai` に直接アクセスし、
// 「Codex/LLM provider の接続状態または setup 状態」と「ai_runs の履歴または
// 空状態」「provider/model メタの表示」が見えることを期待している。
// このページは UI 設計のサブルート (`/ai/providers`, `/ai/runs`) を 1 画面に
// 集約した minimal landing。データソースは `oauth_tokens` と `ai_runs`、
// および `ADDROID_LLM_MOCK` / Codex app-server 状態を集約する。

import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { StatusDot, type StatusState } from "../../components/ui/StatusDot";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { EmptyState } from "../../components/ui/EmptyState";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { DataTable, type DataTableColumn } from "../../components/ui/DataTable";
import { CodeBlock, InlineCode } from "../../components/ui/CodeBlock";
import { PageHeader } from "../../components/ui/PageHeader";
import { getActiveCodexProviderSelection } from "../../lib/codex-runtime";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";
import { AiProviderForm } from "./AiProviderForm";

export const dynamic = "force-dynamic";

const LLM_PROVIDER_KEYS = ["codex", "openai", "anthropic", "mock"] as const;

interface ProviderRow {
  provider: string;
  accountIdentifier: string;
  scopes: string[];
  connectedAt: Date;
  expiresAt: Date | null;
  defaultModel: string | null;
  authKind: string | null;
  apiBaseUrl: string | null;
}

interface AiRunRow {
  id: string;
  agent: string;
  workflow: string;
  provider: string;
  model: string;
  status: string;
  decision: string | null;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
}

function readDefaultModel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)["defaultModel"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function aiRunStatusState(status: string): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "queued":
    default:
      return "idle";
  }
}

function confidenceBand(value: number): "low" | "medium" | "high" {
  if (value >= 0.8) return "high";
  if (value >= 0.5) return "medium";
  return "low";
}

function confidenceState(value: number): StatusState {
  const band = confidenceBand(value);
  if (band === "high") return "ok";
  if (band === "medium") return "info";
  return "idle";
}

export default async function AiPage() {
  let providers: ProviderRow[] = [];
  let runs: AiRunRow[] = [];
  let dbReady = true;
  try {
    const workspace = await ensureWebWorkspace();
    const [tokenRows, runRows] = await Promise.all([
      prisma.oAuthToken.findMany({
        where: { provider: { in: [...LLM_PROVIDER_KEYS] } },
        select: {
          provider: true,
          accountIdentifier: true,
          scopes: true,
          connectedAt: true,
          expiresAt: true,
          metadata: true,
        },
        orderBy: { connectedAt: "desc" },
      }),
      prisma.aiRun.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          agent: true,
          workflow: true,
          provider: true,
          model: true,
          status: true,
          decision: true,
          confidence: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
        },
      }),
    ]);
    providers = tokenRows.map((row) => ({
      provider: row.provider,
      accountIdentifier: row.accountIdentifier,
      scopes: row.scopes,
      connectedAt: row.connectedAt,
      expiresAt: row.expiresAt,
      defaultModel: readDefaultModel(row.metadata),
      authKind: readMetadataString(row.metadata, "authKind"),
      apiBaseUrl: readMetadataString(row.metadata, "apiBaseUrl"),
    }));
    runs = runRows;
  } catch {
    dbReady = false;
  }

  const env = process.env;
  const llmMockEnabled = env.ADDROID_LLM_MOCK === "1";
  const codexRuntimeConfigured = true;
  const codexConnection = await getActiveCodexProviderSelection()
    .provider.getConnection()
    .catch(() => null);
  const encryptionKeySet = Boolean((env.ENCRYPTION_KEY ?? "").trim());
  const pageDisplayTimeZone = resolveDisplayTimeZone();

  const apiKeyConnected = providers.some(
    (p) => (p.provider === "openai" || p.provider === "anthropic") && p.authKind === "api_key"
  );
  const activeChoice: "mock" | "codex" | "api_key" | "stub" = llmMockEnabled
    ? "mock"
    : apiKeyConnected
      ? "api_key"
    : codexRuntimeConfigured
      ? "codex"
      : "stub";

  const codexConnected = Boolean(codexConnection);
  const providerState: StatusState = !dbReady
    ? "warn"
    : activeChoice === "stub" && !codexConnected && !apiKeyConnected
      ? "warn"
      : codexConnected || apiKeyConnected || activeChoice === "mock"
        ? "ok"
        : "warn";

  const providerMessage = !dbReady
    ? "Prisma スキーマが未反映です。npm run db:push を実行してください。"
    : activeChoice === "mock"
      ? "ADDROID_LLM_MOCK=1 が設定されています。mock LLM provider が有効です (開発用)。"
      : activeChoice === "api_key"
        ? "LLM API key が暗号化保存されています。worker は保存済み provider を使用します。"
      : activeChoice === "codex" && codexConnected
        ? `Codex app-server 接続済み (${codexConnection?.accountIdentifier})。`
        : activeChoice === "codex"
          ? "Codex app-server は利用できますが、Codex CLI / ChatGPT にまだログインしていません。"
          : "LLM provider 未設定。ADDROID_LLM_MOCK=1、Codex app-server、または API key を設定してください。";

  const setupItems = [
    { label: "Active provider choice", value: <InlineCode>{activeChoice}</InlineCode> },
    {
      label: "ADDROID_LLM_MOCK",
      value: llmMockEnabled ? "1 (mock 有効)" : "未設定",
    },
    {
      label: "Codex app-server",
      value: codexConnected ? `接続済み (${codexConnection?.accountIdentifier})` : "未ログイン",
    },
    {
      label: "API key credential",
      value: apiKeyConnected ? "暗号化保存済み" : "未登録",
    },
    {
      label: "ENCRYPTION_KEY",
      value: encryptionKeySet ? "設定済み" : "未設定",
    },
  ];

  const providerColumns: DataTableColumn<ProviderRow>[] = [
    {
      header: "Provider",
      cell: (row) => <InlineCode>{row.provider}</InlineCode>,
    },
    {
      header: "Account",
      cell: (row) => <InlineCode>{row.accountIdentifier}</InlineCode>,
    },
    {
      header: "Default model",
      cell: (row) =>
        row.defaultModel ? <InlineCode>{row.defaultModel}</InlineCode> : <span>—</span>,
    },
    {
      header: "Auth",
      cell: (row) => <InlineCode>{row.authKind ?? (row.provider === "codex" ? "app_server" : "unknown")}</InlineCode>,
    },
    {
      header: "Scopes",
      cell: (row) =>
        row.scopes.length === 0 ? (
          <span>—</span>
        ) : (
          <span style={{ fontFamily: "var(--font-mono)" }}>{row.scopes.join(", ")}</span>
        ),
    },
    {
      header: "Connected",
      cell: (row) => formatDateTime(row.connectedAt, { timeZone: pageDisplayTimeZone }),
      className: "tabular-nums",
    },
    {
      header: "Expires",
      cell: (row) =>
        row.expiresAt ? formatDateTime(row.expiresAt, { timeZone: pageDisplayTimeZone }) : <span>—</span>,
      className: "tabular-nums",
    },
  ];

  const runColumns: DataTableColumn<AiRunRow>[] = [
    {
      header: "Created",
      cell: (row) => formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
      className: "tabular-nums",
    },
    {
      header: "Workflow",
      cell: (row) => <InlineCode>{row.workflow}</InlineCode>,
    },
    {
      header: "Agent",
      cell: (row) => <InlineCode>{row.agent}</InlineCode>,
    },
    {
      header: "Provider / model",
      cell: (row) => (
        <InlineCode>
          {row.provider}/{row.model}
        </InlineCode>
      ),
    },
    {
      header: "Status",
      cell: (row) => (
        <StatusBadge state={aiRunStatusState(row.status)}>{row.status}</StatusBadge>
      ),
    },
    {
      header: "Decision",
      cell: (row) =>
        row.decision ? <InlineCode>{row.decision}</InlineCode> : <span>—</span>,
    },
    {
      header: "Confidence",
      cell: (row) =>
        row.confidence === null ? (
          <span>—</span>
        ) : (
          <StatusDot state={confidenceState(row.confidence)}>
            <span className="tabular-nums">{row.confidence.toFixed(2)}</span>
            <span style={{ marginLeft: "0.4em" }}>{confidenceBand(row.confidence)}</span>
          </StatusDot>
        ),
      className: "tabular-nums",
    },
    {
      header: "Tokens (in/out)",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
        </span>
      ),
      className: "tabular-nums",
    },
  ];

  return (
    <>
      <PageHeader
        title="AI Workflows"
        subtitle={
          <>
            Codex / LLM Provider 接続状態と <InlineCode>ai_runs</InlineCode> 実行履歴。
            AI は Meta を直接変更せず、改善案は GitHub PR を経由する。
          </>
        }
      />

      <div className="page-body">
        <div className="col-span-12">
          <Panel
            title="LLM Provider"
            subtitle="Codex app-server / OpenAI / Anthropic / Mock の接続と setup 状態"
            status={<StatusDot state={providerState}>{providerState}</StatusDot>}
          >
            <div style={{ display: "grid", gap: "1rem" }}>
              <p>{providerMessage}</p>
              <AiProviderForm />
              <KeyValueList items={setupItems} />
              {providers.length === 0 ? (
                <EmptyState
                  title="LLM Provider 未連携"
                  description={
                    activeChoice === "mock"
                      ? "ADDROID_LLM_MOCK=1 のため mock provider が選択されています。実 OAuth 連携は不要ですが、本番では Codex を接続してください。"
                      : "Codex app-server にログインするか、OpenAI / Anthropic API key を CLI で暗号化保存してください。"
                  }
                />
              ) : (
                <DataTable
                  columns={providerColumns}
                  rows={providers}
                  rowKey={(row) => `${row.provider}:${row.accountIdentifier}`}
                  empty={null}
                />
              )}
              <CodeBlock>
                {`addroid connect ai --provider openai
addroid connect ai --provider anthropic
addroid connect ai --provider codex`}
              </CodeBlock>
            </div>
          </Panel>
        </div>

        <div className="col-span-12">
          <Panel
            title="AI Runs"
            subtitle="ai_runs 直近 50 件 (provider / model / status / tokens を含む)"
            status={
              <StatusDot state={!dbReady ? "warn" : runs.length === 0 ? "idle" : "ok"}>
                {!dbReady ? "warn" : runs.length === 0 ? "idle" : `${runs.length} runs`}
              </StatusDot>
            }
          >
            {!dbReady ? (
              <EmptyState
                title="AI run history を読み出せません"
                description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
              />
            ) : (
              <DataTable
                columns={runColumns}
                rows={runs}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState
                    title="AI run はまだ実行されていません"
                    description="/cron から daily_report / today_report / improvement_pr を有効化するか、各ワークフローを Adhoc 起動すると、ここに provider / model / decision / confidence / tokens が記録されます。"
                  />
                }
              />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

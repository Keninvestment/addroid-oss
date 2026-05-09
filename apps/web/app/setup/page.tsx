import fs from "node:fs";
import path from "node:path";
import {
  homeAnchorPath,
  resolveAddroidPaths,
  resolveWebBinding,
  type SlackInstallationMetadata,
} from "@addroid/config";
import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { StatusDot, type StatusState } from "../../components/ui/StatusDot";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { CodeBlock, InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";

export const dynamic = "force-dynamic";

interface DoctorCheck {
  name: string;
  state: StatusState;
  message: string;
  hint?: string;
}

export default async function SetupPage() {
  const paths = resolveAddroidPaths();
  const binding = (() => {
    try {
      return resolveWebBinding();
    } catch {
      return { hostname: "127.0.0.1", port: 3000 };
    }
  })();

  // 直近 doctor 結果を表示。`addroid doctor` は実行のたびに doctor_results に
  // 1 行追記するので、最新行を取り出して状態と詳細を提示する。未実行 (DB 行なし) の
  // ケースは EmptyState で「まだ実行していない」ことを honest に示す。
  let lastDoctor: { ranAt: Date; overall: string; checks: DoctorCheck[] } | null = null;
  let dbReady = true;
  try {
    const row = await prisma.doctorResult.findFirst({ orderBy: { ranAt: "desc" } });
    if (row) {
      lastDoctor = {
        ranAt: row.ranAt,
        overall: row.overall,
        checks: Array.isArray(row.checks) ? (row.checks as unknown as DoctorCheck[]) : [],
      };
    }
  } catch {
    dbReady = false;
  }

  // Slack OAuth/Socket Mode 状態を `oauth_tokens(provider='slack')` から読む。
  // Slack は任意統合なので、行が無いケースは error / warn ではなく benign idle として
  // 扱い、UI とセキュリティチェックの双方で「Slack 未設定 (任意)」を info で示す。
  // 行が DB から取れなかった (DB 接続自体が落ちている) 場合は、別経路の dbReady で
  // Doctor 結果側がエラーを伝えるため、ここでは `null` を返す。
  let slackInstallation: {
    accountIdentifier: string;
    scopes: string[];
    hasBotToken: boolean;
    hasAppToken: boolean;
    connectedAt: Date;
    updatedAt: Date;
    metadata: Partial<SlackInstallationMetadata> | null;
  } | null = null;
  try {
    const row = await prisma.oAuthToken.findFirst({
      where: { provider: "slack" },
      orderBy: { connectedAt: "desc" },
    });
    if (row) {
      const meta =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Partial<SlackInstallationMetadata>)
          : null;
      slackInstallation = {
        accountIdentifier: row.accountIdentifier,
        scopes: row.scopes ?? [],
        hasBotToken: typeof row.accessTokenCiphertext === "string" && row.accessTokenCiphertext.length > 0,
        hasAppToken:
          typeof row.refreshTokenCiphertext === "string" && row.refreshTokenCiphertext.length > 0,
        connectedAt: row.connectedAt,
        updatedAt: row.updatedAt,
        metadata: meta,
      };
    }
  } catch {
    // DB 接続不可は doctor / dbReady 側で別途警告される。Slack 任意統合自体は
    // 失敗を伝播させない。
    slackInstallation = null;
  }

  // Setup ページのセキュリティチェック / 専用 Panel で再利用する Slack 状態サマリ。
  const slackStatus: { state: StatusState; label: string; detail: string } = (() => {
    if (!slackInstallation) {
      return {
        state: "info",
        label: "Slack 未設定 (任意)",
        detail:
          "AdDroid は Slack なしでも動作します。Slack 通知や /adops を使う場合のみ、addroid connect slack で接続してください。",
      };
    }
    if (!slackInstallation.hasAppToken) {
      return {
        state: "warn",
        label: "Slack 接続済み (Socket Mode 用 app token なし)",
        detail:
          "xoxb- bot token は登録されていますが、xapp- app-level token が未登録のため Socket Mode が使えません。addroid connect slack を再実行して app token を登録してください。",
      };
    }
    const teamName = slackInstallation.metadata?.teamName ?? slackInstallation.accountIdentifier;
    const channelId = slackInstallation.metadata?.notificationChannelId;
    return {
      state: "ok",
      label: `Slack 接続済み: ${teamName}${channelId ? ` (channel ${channelId})` : ""}`,
      detail:
        "通知チャンネルが保存されています。Slack に障害があっても、承認済み変更の確認や自動実行は通常通り稼働します。",
    };
  })();

  // OSS リリース衛生チェック (UI 内で読み取り可能なものだけ判定する)
  const repoRoot = process.cwd().includes("/apps/web")
    ? path.resolve(process.cwd(), "../..")
    : process.cwd();
  const securityChecks: DoctorCheck[] = [
    {
      name: "この端末だけで開ける",
      state: binding.hostname === "127.0.0.1" || binding.hostname === "localhost" ? "ok" : "error",
      message: `bind=${binding.hostname}:${binding.port}`,
      hint:
        binding.hostname === "127.0.0.1" || binding.hostname === "localhost"
          ? undefined
          : "ADDROID_WEB_HOSTNAME を 127.0.0.1 に戻してください。",
    },
    {
      name: ".gitignore が secrets を除外",
      ...(() => {
        const gitignorePath = path.join(repoRoot, ".gitignore");
        try {
          const content = fs.readFileSync(gitignorePath, "utf8");
          const required = [".env", "secrets.local.yaml"];
          const missing = required.filter((token) => !content.includes(token));
          if (missing.length === 0) {
            return {
              state: "ok" as StatusState,
            message: "接続情報ファイルは共有対象から除外されています。",
            };
          }
          return {
            state: "error" as StatusState,
            message: `.gitignore に不足: ${missing.join(", ")}`,
          };
        } catch (err) {
          return {
            state: "warn" as StatusState,
            message: `.gitignore を読めません: ${(err as Error).message}`,
          };
        }
      })(),
    },
    {
      name: "接続情報の暗号化",
      ...(() => {
        const key = process.env.ENCRYPTION_KEY ?? "";
        if (!key) {
          return {
            state: "error" as StatusState,
            message: "暗号化キーが未設定です。",
            hint: "初期設定をやり直してください。",
          };
        }
        if (key.length < 16) {
          return {
            state: "warn" as StatusState,
            message: "暗号化キーが短すぎます (16 文字以上推奨)。",
          };
        }
        return {
          state: "ok" as StatusState,
          message: "暗号化キーが設定されています。",
        };
      })(),
    },
    {
      name: "外部からの着信を使わない",
      state: "ok",
      message:
        "AdDroid は公開URLを要求しません。承認済み変更は定期確認で検出します。",
    },
    {
      name: "Slack 連携 (任意)",
      state: slackStatus.state,
      message: slackStatus.label,
      hint: slackStatus.detail,
    },
  ];

  return (
    <>
      <PageHeader
        title="接続と健康状態"
        subtitle="AdDroid が使える状態か、必要な接続ができているかを確認します。"
      />

      <div className="page-body page-body--single">
        <Panel title="初期設定メモ" subtitle="通常は初回セットアップ時だけ確認します">
          <KeyValueList
            items={[
              { label: "アプリの準備", value: <CodeBlock>npm install</CodeBlock> },
              {
                label: "保存先の準備",
                value: (
                  <CodeBlock>
                    {`pg_isready -h localhost -p 5432
# addroid ロールを先に作成し、addroid 所有で DB を作成する
# (createdb 単独だと OS ユーザーが public スキーマを所有し、Prisma db push と pg-boss が失敗する)
# PASSWORD には 'addroid' のような既知の弱い値ではなく自前の強いパスワードを入れる
# (例: DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"))
psql -d postgres -c "CREATE ROLE addroid WITH LOGIN PASSWORD '<choose-a-strong-password>' CREATEDB;" 2>/dev/null || true
createdb -O addroid addroid 2>/dev/null || true
psql -d addroid -c "ALTER SCHEMA public OWNER TO addroid;" 2>/dev/null || true
psql -d addroid -c "GRANT ALL ON SCHEMA public TO addroid;" 2>/dev/null || true
# 上で決めたパスワードを .env / .env.local の DATABASE_URL に反映する
#   DATABASE_URL=postgresql://addroid:<password>@localhost:5432/addroid
npm run db:push`}
                  </CodeBlock>
                ),
              },
              {
                label: "初期化と起動 (推奨)",
                value: (
                  <CodeBlock>
                    {`addroid init      # 初期設定と接続を対話で完了
addroid status    # 接続・起動状態を確認
addroid start     # Web UI (127.0.0.1:3000) + worker を起動`}
                  </CodeBlock>
                ),
              },
              {
                label: "個別起動 (必要な時だけ)",
                value: (
                  <CodeBlock>
                    {`npm run dev          # apps/web 単独 (127.0.0.1:3000)
npm run dev:worker   # apps/worker (pg-boss) 単独`}
                  </CodeBlock>
                ),
              },
            ]}
          />
        </Panel>

        <Panel
          title="診断結果"
          subtitle="直近の接続・起動チェック"
          status={
            lastDoctor ? (
              <StatusDot state={lastDoctor.overall as StatusState}>{lastDoctor.overall}</StatusDot>
            ) : (
              <StatusDot state="idle">未実行</StatusDot>
            )
          }
        >
          {!dbReady ? (
            <EmptyState
              title="保存先の準備が未完了です"
              description="初期設定メモを確認した後、状態確認を実行すると検査結果がここに表示されます。"
            />
          ) : !lastDoctor ? (
            <EmptyState
              title="診断履歴はまだありません。"
              description="状態確認を実行すると、最新の検査結果がここに表示されます。"
            />
          ) : (
            <KeyValueList
              items={[
                { label: "実行時刻", value: lastDoctor.ranAt.toISOString(), mono: true },
                { label: "総合", value: lastDoctor.overall },
                {
                  label: "詳細",
                  value: (
                    <ul style={{ margin: 0, paddingLeft: "1rem" }}>
                      {lastDoctor.checks.map((c, idx) => (
                        <li key={idx}>
                          <strong>{c.name}:</strong> {c.message}
                          {c.hint ? <> — <em>{c.hint}</em></> : null}
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="安全設定" subtitle="ローカル運用で守る条件">
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "var(--space-3)" }}>
            {securityChecks.map((check) => (
              <li
                key={check.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content 1fr",
                  columnGap: "var(--space-3)",
                  alignItems: "start",
                }}
              >
                <StatusDot state={check.state}>{check.state}</StatusDot>
                <div>
                  <div style={{ fontWeight: "var(--weight-medium)" }}>{check.name}</div>
                  <div style={{ color: "var(--color-text-secondary)", fontSize: "var(--size-sm)" }}>
                    {check.message}
                  </div>
                  {check.hint ? (
                    <div style={{ color: "var(--color-text-tertiary)", fontSize: "var(--size-xs)" }}>
                      {check.hint}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Slack 連携 (任意)"
          subtitle="Slack 通知や /adops を使う場合だけ設定します"
          status={
            <span style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
              <StatusBadge state="idle">OPTIONAL</StatusBadge>
              <StatusDot state={slackStatus.state}>{slackStatus.label}</StatusDot>
            </span>
          }
        >
          {!slackInstallation ? (
            <EmptyState
              title="Slack は任意です。AdDroid は Slack なしでも動作します。"
              description="Slack 通知や /adops を有効にしたい場合のみ接続してください。公開 URL は必要ありません。"
            />
          ) : (
            <KeyValueList
              items={[
                {
                  label: "状態",
                  value: <StatusDot state={slackStatus.state}>{slackStatus.label}</StatusDot>,
                },
                {
                  label: "Team",
                  value: slackInstallation.metadata?.teamName
                    ? `${slackInstallation.metadata.teamName} (${slackInstallation.metadata.teamId ?? slackInstallation.accountIdentifier})`
                    : slackInstallation.accountIdentifier,
                  mono: true,
                },
                {
                  label: "Bot user",
                  value: slackInstallation.metadata?.botUser
                    ? `@${slackInstallation.metadata.botUser}${
                        slackInstallation.metadata.botUserId
                          ? ` (${slackInstallation.metadata.botUserId})`
                          : ""
                      }`
                    : "—",
                  mono: true,
                },
                {
                  label: "通知チャンネル",
                  value: slackInstallation.metadata?.notificationChannelId ?? "—",
                  mono: true,
                },
                {
                  label: "Bot token (xoxb-)",
                  value: (
                    <StatusDot state={slackInstallation.hasBotToken ? "ok" : "warn"}>
                      {slackInstallation.hasBotToken
                        ? "保存済み"
                        : "未登録"}
                    </StatusDot>
                  ),
                },
                {
                  label: "Slack アプリ接続",
                  value: (
                    <StatusDot state={slackInstallation.hasAppToken ? "ok" : "warn"}>
                      {slackInstallation.hasAppToken
                        ? "保存済み"
                        : "未登録"}
                    </StatusDot>
                  ),
                },
                {
                  label: "許可された範囲",
                  value:
                    slackInstallation.scopes.length > 0 ? (
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {slackInstallation.scopes.join(", ")}
                      </span>
                    ) : (
                      "—"
                    ),
                },
                {
                  label: "直近 Socket Mode 接続テスト",
                  value: slackInstallation.metadata?.lastSocketModeTestAt ?? "未テスト",
                  mono: true,
                },
                {
                  label: "直近テストメッセージ送信",
                  value: slackInstallation.metadata?.lastTestMessageAt ?? "未送信",
                  mono: true,
                },
                {
                  label: "接続日時",
                  value: slackInstallation.connectedAt.toISOString(),
                  mono: true,
                },
                {
                  label: "更新日時",
                  value: slackInstallation.updatedAt.toISOString(),
                  mono: true,
                },
                {
                  label: "再接続 / 切断",
                  value: (
                    <CodeBlock>
                      {`addroid connect slack              # トークン更新 + Socket Mode 接続テスト
addroid connect slack --disconnect # トークン削除 (任意)`}
                    </CodeBlock>
                  ),
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="Documentation" subtitle="リポジトリ内の参照ドキュメント">
          <KeyValueList
            items={[
              { label: "README", value: <InlineCode>README.md</InlineCode> },
              { label: "Setup ガイド", value: <InlineCode>docs/SETUP.md</InlineCode> },
              { label: "Security 文書", value: <InlineCode>docs/SECURITY.md</InlineCode> },
              { label: "Architecture", value: <InlineCode>docs/ARCHITECTURE.md</InlineCode> },
              { label: "AdDroid home", value: homeAnchorPath(paths.home), mono: true },
              { label: "Config file", value: homeAnchorPath(paths.configFile), mono: true },
              {
                label: "Secrets file (gitignored)",
                value: homeAnchorPath(paths.secretsFile),
                mono: true,
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}

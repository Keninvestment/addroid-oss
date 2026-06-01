// AdDroid OSS — submission guards page.

import { PageHeader } from "../../components/ui/PageHeader";
import { Panel } from "../../components/ui/Panel";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { ensureWebWorkspace } from "../../lib/github-runtime";
import { prisma } from "../../lib/prisma";
import { loadSubmissionGuardPolicyConfig } from "../../../worker/src/lib/submission-guard-policy-config";
import { DashboardChatPanel } from "../DashboardChatPanel";

export const dynamic = "force-dynamic";

export default async function GuardsPage() {
  const workspace = await ensureWebWorkspace();
  const config = await loadSubmissionGuardPolicyConfig({
    prisma,
    workspaceId: workspace.id,
  }).catch((err) => ({
    rootDir: null,
    yamlPath: null,
    exists: false,
    policy: {
      version: 1 as const,
      guards: { budgetIncrease: { warnOverRatio: 2, blockOverRatio: 5 } },
    },
    error: (err as Error).message,
  }));
  const budget = config.policy.guards.budgetIncrease;
  return (
    <>
      <PageHeader
        title="安全ガード"
        subtitle="入稿・変更PRの内容を事前に検査し、危険な変更を警告またはブロックします。"
      />

      <div className="page-body">
        <div className="col-span-5">
          <Panel
            title="適用中のガード"
            subtitle="CI / submit / plan で使われる現在のルール"
            status={
              <StatusBadge state={config.exists ? "ok" : "warn"}>
                {config.exists ? "設定済み" : "初期値"}
              </StatusBadge>
            }
          >
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList
                items={[
                  {
                    label: "予算増加",
                    value: `${budget.warnOverRatio}倍以上で警告`,
                  },
                  {
                    label: "ブロック",
                    value: `${budget.blockOverRatio}倍以上でNG`,
                  },
                  {
                    label: "対象",
                    value: "campaign / adset の予算変更",
                  },
                  {
                    label: "設定ファイル",
                    value: (
                    <InlineCode>{config.yamlPath ?? "workflows/guards.yaml"}</InlineCode>
                    ),
                  },
                ]}
              />
              {"error" in config && config.error ? (
                <p style={{ color: "var(--color-danger)" }}>{config.error}</p>
              ) : null}
              {!config.rootDir ? (
                <p style={{ color: "var(--color-text-secondary)" }}>
                  ops repo のローカル checkout が見つからないため、この画面からは変更できません。
                </p>
              ) : null}
            </div>
          </Panel>
        </div>
        <div className="col-span-7">
          <DashboardChatPanel
            surface="guards"
            title="ガード設定チャット"
            description="予算増加ガードの警告ラインとブロックラインを会話で変更できます。"
            emptyText="例のように「3倍で警告、6倍でブロック」などと入力してください。保存後、左の一覧に反映されます。"
            badge="CIガード"
            examples={[
              "予算増加は2倍で警告、5倍でブロックにして",
              "警告を3倍、ブロックを6倍に変更して",
              "今より厳しく、1.5倍で警告、3倍でNGにして",
            ]}
            placeholder="例: 予算増加は3倍で警告、6倍でブロックにして"
            contextPrefix={[
              "この画面は入稿前の安全ガード設定専用です。",
              "ユーザーが予算増加ガード、警告倍率、ブロック倍率、CIガード、submit/planでの安全判定を変更したい場合は configure_submission_guards を使ってください。",
              "configure_budget_guard は使わないでください。これは日々の消化予算監視用であり、この画面の入稿前CIガードとは別物です。",
              `現在の設定: budgetIncrease.warnOverRatio=${budget.warnOverRatio}, budgetIncrease.blockOverRatio=${budget.blockOverRatio}`,
              config.rootDir
                ? `設定ファイル: ${config.yamlPath ?? "workflows/guards.yaml"}`
                : "ops repo のローカル checkout がないため、保存できない場合はその理由を短く伝えてください。",
              "警告倍率はブロック倍率より小さくしてください。片方だけ指定された場合は、現在値を維持できるなら維持して設定してください。",
            ].join("\n")}
            refreshOnSuccess
          />
        </div>
      </div>
    </>
  );
}

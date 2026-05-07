# AdDroid OSS — GitOps Flow

AdDroid は Meta 広告変更を **GitOps** として管理します。Ads YAML が単一ソースであり、
すべての変更は ops repo の Pull Request としてレビューされ、merge → Apply (PAUSED) →
Activate (ACTIVE) の 2 段階で Meta に反映されます。

---

## 1. ops repo の構成

ops repo は AdDroid に bootstrap されたリポジトリで、`packages/ops-template` を
ベースに生成されます。

```
ops-repo/
├── .addroid/
│   └── project.yaml        # workspace / ad_account / brand 設定
├── ads/
│   ├── accounts/
│   │   └── <account_key>/  # ad_accounts.key に対応
│   │       ├── campaign-<name>.yaml
│   │       ├── adset-<name>.yaml
│   │       └── ad-<name>.yaml
│   └── creatives/
│       └── <creative_id>/
├── brand.yaml              # ブランドトーン / 禁止表現
├── cron.yaml               # cron preset の有効化 / schedule 上書き
└── .github/
    └── workflows/          # ops repo 側の CI (任意)
```

Ads YAML / cron.yaml / project.yaml はすべて `packages/yaml-schemas` の Zod スキーマで
検証され、不正な構造 / 安全でない予算変更 / 初期 active キャンペーン作成は拒否されます。

---

## 2. 連携の bootstrap

1. `addroid init` または `addroid connect github` で GitHub OAuth を完了
2. AdDroid が未連携 workspace に private ops repo を自動作成
3. AdDroid が ops repo 直下に initial commit を push (config skeleton)
4. `audit_logs` に `ops_repo.bootstrapped` が記録される
5. 以降、`github_poll` cron が ETag-aware ポーリングで PR / merge を検知

Web UI `/github` の OAuth Code Flow も維持しており、ブラウザから接続した場合も同じ
token store に保存して未連携なら ops repo bootstrap まで実行します。

ops repo を別の場所に置きたい場合は `addroid` から bootstrap せず、手動で
`packages/ops-template` の構造をコピーして `workspaces.ops_repo_*` に登録することも
可能です。

---

## 3. 通常の変更フロー

```
            ┌────────────────────┐
            │ Operator / AI が   │
            │ Ads YAML を編集     │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │ ops repo に PR     │
            │ (改善提案 PR は     │
            │  improvement_pr が │
            │  自動生成)          │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │ レビュー + merge    │
            │ (3 経路のいずれか) │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │ github_poll が     │
            │ merged PR を検知   │
            │ → execute_apply    │
            │   を queue          │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │ Meta に PAUSED で  │
            │ オブジェクト作成    │
            │ (apply_jobs 記録)  │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │ 人間が Activate を │
            │ 明示的に呼び出す    │
            │ (PAUSED → ACTIVE)  │
            └────────────────────┘
```

---

## 4. 3 つの merge 経路

すべての経路は `approval_records.decisionSource` に出所を残します。

### 4.1 GitHub UI で merge (`github_merge`)

通常の GitHub レビュー → merge です。AdDroid 側に追加操作は不要で、`github_poll` が
merge を検知して Apply を queue します。

### 4.2 Web UI で merge (`web_merge`)

Web UI `/approvals/[prNumber]` の MergeConfirmDialog から merge を実行します。
Dialog body は以下を含みます:

- target PR (number / title / branch)
- 変更ファイル一覧
- 影響する `ad_account`
- Apply 起動の有無
- 現在の execution mode (`report_only` / `proposal` / `auto_apply`)
- 現在の Meta execution mode (`live` / `sandbox` / `mock`)

Web UI からの merge は GitHub API を **outbound** で叩きます。AdDroid 自身は
inbound webhook を受けません。

### 4.3 CLI で merge (`cli_merge`)

`addroid` CLI から merge する経路は将来コントラクトで実装予定です。

### 4.4 Slack `/adops` (限定: Activate のみ)

Slack は **Activate** のみの導線で、merge は持ちません。`/adops activate <act_id>`
は merge 済みの PR について PAUSED → ACTIVE 遷移をかけます。

---

## 5. ETag-aware polling

`github_poll` cron (`*/2 * * * *`) は `github_polling_state` テーブルに `etag` /
`lastModified` を保存し、HTTP `If-None-Match` / `If-Modified-Since` で 304 を引き出します。

- 304 応答時は API 呼び出しのコストのみで PR 一覧の差分を取らない
- 200 応答時は新規 / 更新された PR を `github_pull_requests` に upsert
- merge を検知すると `execute_apply` を queue + `audit_logs` に `apply.enqueued`
- 承認 / mode / branch protection 違反で merge を遮断した場合は
  `audit_logs` に `apply.blocked_unapproved`

---

## 6. 承認境界

| 操作 | 承認境界 | 記録先 |
|---|---|---|
| ops repo PR の merge | GitHub branch protection / レビュー / Web UI MergeConfirmDialog | `approval_records` (targetType="github_pull_request") |
| Apply (PR merge → PAUSED 作成) | execution_mode と上記 merge 承認に従う | `apply_jobs` + `audit_logs` |
| Activate (PAUSED → ACTIVE) | `auto_apply` 以外では人間の明示確認必須 | `approval_records` (targetType="ads_hierarchy") + `audit_logs` |

`approval_records` は polymorphic な targetType を持ち、Apply と Activate を独立に
許可 / 却下できます。

---

## 7. cron preset と GitOps の関係

| preset | GitOps への影響 |
|---|---|
| `github_poll` | merge を検知して Apply を queue (実書き込みは `execute_apply`) |
| `daily_report` | レポートのみ。ops repo は触らない |
| `budget_guard` | 警告のみ。ops repo は触らない (将来コントラクトで自動 PR 化) |
| `improvement_pr` | AI が改善案を生成し ops repo に PR を作成 |
| `retention_sweep` | DB の古い行を housekeeping。ops repo は触らない |

`improvement_pr` が作成した PR は通常の review プロセスを経由し、merge されない限り
Meta には反映されません。

---

## 8. dry-run と plan

ops repo を編集する前に、ローカルで Apply の影響をシミュレーションできます。

```bash
npm run addroid -- validate    # Zod でスキーマ検証
npm run addroid -- plan --dry-run    # Apply の差分シミュレーション
```

`plan` の出力は `apply_jobs` に `state: simulated` として記録され、Web UI `/plans`
からも参照できます。実書き込みは発生しません。

---

## 9. Web UI の確認ポイント

| ルート | 確認内容 |
|---|---|
| `/github` | OAuth 状態、ops repo、PR ポーリング状態 |
| `/approvals` | 承認待ち PR、Web UI からの merge |
| `/approvals/[prNumber]` | PR の preview body / 変更ファイル一覧 / merge 操作 |
| `/plans` | Apply 前の plan dry-run 結果 |
| `/apply/[id]` | Apply ジョブの詳細とリトライ |
| `/cron/audit` | `audit_logs` の閲覧 |

---

## 10. トラブルシュート

[`docs/TROUBLESHOOTING.md` §7](./TROUBLESHOOTING.md) を参照してください。

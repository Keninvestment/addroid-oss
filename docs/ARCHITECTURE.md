# AdDroid OSS — Architecture

## 1. プロセスモデル

AdDroid OSS の既定モデルは **1 プロセスで web + worker** を併走させる構成です。
将来の `addroid start --separate-worker` で水平スケールできるよう、コードベースは
最初から分離可能な境界に保ちます。

```
+----------------------------------------------------+
| addroid CLI                                        |
|  ├── init   ── ~/.addroid/{config.yaml, storage}   |
|  ├── doctor ── env checks (uv / py / meta-ads-cli /|
|  │             github-cli / postgres / DB / config)|
|  ├── up     ── web + worker を 1 プロセスで起動     |
|  ├── down / status / logs                          |
|  ├── validate / plan / activate                    |
|  ├── cron <list/enable/disable/run/...>            |
|  └── auth <provider>                               |
+----------------------------------------------------+
                       │
       ┌───────────────┴───────────────┐
       │                               │
+---------------+              +-----------------+
|  apps/web     |              |  apps/worker    |
|  Next.js App  |   shared DB  |  pg-boss        |
|  Router       |─────────────│  - github_poll   |
|  127.0.0.1:3000|             |  - daily_report  |
+---------------+              |  - budget_guard  |
                               |  - improvement_pr|
                               |  - retention_sweep|
                               |  - execute_apply  |
                               +-----------------+
                                        │
                                        ▼
                                +-----------------+
                                | PostgreSQL 16+  |
                                |  - AdDroid      |
                                |    tables       |
                                |  - pg-boss      |
                                |    schema       |
                                +-----------------+
```

---

## 2. モノレポ境界

| Workspace | 責務 |
|---|---|
| `apps/web` | Next.js App Router の UI と Route Handler。`127.0.0.1` のみで listen。 |
| `apps/worker` | pg-boss を起動し、cron プリセットと job ハンドラ (`execute_apply` 等) を登録。 |
| `apps/cli` | `addroid` 実行ファイル。`@addroid/cli` として npm publish 可能。 |
| `packages/db` | `@prisma/client` の単一インスタンスを共有。Web/Worker/CLI の双方が依存。 |
| `packages/config` | `~/.addroid/config.yaml` の読み書き、暗号化境界、LocalDiskStorage、Slack auth ヘルパ。 |
| `packages/queue` | pg-boss boot、プリセット cron、Apply executor、retention sweep。 |
| `packages/github-adapter` | GitHub OAuth、ops repo bootstrap、ETag-aware ポーリング。adapter pattern (Real / Mock)。 |
| `packages/meta-adapter` | Meta Graph API adapter (Real / Mock / Stub)、in-memory sandbox harness。 |
| `packages/llm-provider` | LLM Provider 抽象 (Codex / Stub / Mock) と Image Provider、AI run / Creative QA / Creative storage。 |
| `packages/yaml-schemas` | Ads YAML / cron.yaml / project.yaml の Zod スキーマと型。 |
| `packages/ops-template` | 生成 ops リポジトリのテンプレート (brand.yaml / cron.yaml / .addroid/project.yaml / GitHub Actions / README)。 |

依存方向は単一方向に保ちます:

```
apps/{web,worker,cli}  →  packages/*
packages/*             →  packages/* (極小限)
```

`packages/db` は他パッケージからも読まれるため、副作用を持たないことを徹底します。

---

## 3. データプレーン

### 3.1 Prisma — 主要テーブル

| テーブル | 役割 |
|---|---|
| `workspaces` | AdDroid のローカルワークスペース (config + ops repo メタ) |
| `oauth_tokens` | GitHub / Meta / Codex / Slack の OAuth トークン (暗号化保存) |
| `ad_accounts` | Meta 広告アカウント (`ads/accounts/<key>/...` と紐付け、`modeOverride` で per-account 実行モード上書き) |
| `ads_hierarchy` | campaign / adset / ad の正規化ツリー |
| `creatives` | クリエイティブ資産 (画像 / カルーセル) と LocalDisk storage ref |
| `performance_snapshots` | 日次メトリクスの冪等スナップショット |
| `ai_runs` | AI 生成 / 改善提案ジョブの実行記録 (prompts / outputs / model / cost) |
| `github_pull_requests` | ポーリングで観測した PR と merge 状態 (preview body / files changed JSON 含む) |
| `approval_records` | PR / Activate / 個別操作の承認・却下・自動承認の記録 (polymorphic) |
| `cron_runs` | cron 実行履歴 (start/end/state/error) |
| `apply_jobs` | merged PR から enqueue された `execute_apply` ジョブ記録 (state: queued / running / succeeded / failed / simulated) |
| `execution_logs` | cron / apply / ai_run / github_poll の細粒度ログ |
| `audit_logs` | 監査ログ (actor / action / target / ref) |

加えて UI / worker / CLI が直接読む補助テーブル:

- `github_repos` — ops リポジトリのレジストリ
- `github_polling_state` — ETag-aware ポーリングの進捗
- `cron_schedules` — pg-boss プリセットの UI 表示用ミラー
- `doctor_results` — `addroid doctor` 直近結果の UI 表示キャッシュ

スキーマ詳細は [`prisma/schema.prisma`](../prisma/schema.prisma) と
[`prisma/README.md`](../prisma/README.md) を参照してください。

### 3.2 pg-boss プリセット cron

`packages/queue/src/presets.ts` に定義され、`cron_schedules` で UI から有効/無効を
切り替えできます。

| preset | schedule | 既定 | 役割 |
|---|---|---|---|
| `github_poll` | `*/2 * * * *` | enabled | ops repo の PR を ETag-aware でポーリングし merged PR を検知 |
| `daily_report` | `0 9 * * *` | disabled | 日次レポート取得 + ai_runs (`daily_report`) |
| `budget_guard` | `*/15 * * * *` | disabled | 予算超過監視 + ai_runs (`budget_guard`) |
| `improvement_pr` | `0 10 * * 1` | disabled | 週次改善提案 PR 作成 + ai_runs (`improvement_pr`) |
| `retention_sweep` | `15 3 * * *` | enabled | housekeeping (raw 90d / aggregate 1y) |

cron 経由で発火する非同期ジョブ:

- `execute_apply` — merged PR から enqueue され、Meta adapter 越しに PAUSED で
  campaign / adset / ad / creative を作成

---

## 4. Apply / Activate split

AdDroid は「Meta に書き込む」操作を 2 段階に分けます。

```
+-------------------+                  +--------------------+
| ops repo PR merge | ──github_poll─▶  | execute_apply job  | ──▶  Meta (PAUSED)
+-------------------+                  +--------------------+
                                                │
                                                ▼
                                        apply_jobs row
                                        execution_logs row
                                        audit_logs (apply.enqueued)

+-------------------+                  +--------------------+
| audited activation | ──web/slack/CLI─▶ | activate handler   | ──▶  Meta (ACTIVE)
+-------------------+                  +--------------------+
                                                │
                                                ▼
                                        approval_records (Activate)
                                        audit_logs (activate)
```

- **Apply** は ops repo の PR が merge されたときにのみ発火し、新規 Meta オブジェクトを
  すべて `PAUSED` で作成します。Apply 自身は予算を消費しません。
- **Activate** は Web UI `/campaigns` / Slack `/adops activate` / 詳細 CLI 経路
  のいずれかで明示的に呼び出された場合のみ実行され、PAUSED → ACTIVE に遷移します。
  実予算消費はこの段階で初めて発生します。
- Apply / Activate それぞれが独立した承認境界を持ち、`approval_records` の
  `targetType` で polymorphic に区別されます (`github_pull_request` / `ads_hierarchy`)。

execution_mode (`report_only` / `proposal` / `auto_apply`) が workspace / ad_account
レベルで適用され、`auto_apply` 以外では Activate に手動承認が必須です。

---

## 5. GitOps approval flow

ops repo の PR は **3 つの merge 経路**でレビューを完結できます。すべての経路は
`approval_records.decisionSource` に `github_merge` / `web_merge` / `cli_merge` /
`slack_activate` のいずれかを残します。

```
ops repo PR
    │
    ├── (1) GitHub UI で merge ─────▶ github_poll が検知 ─▶ execute_apply
    │
    ├── (2) Web UI /approvals/[prNumber] で merge
    │       (MergeConfirmDialog で blast radius を表示) ──▶ execute_apply
    │
    └── (3) Slack /adops <subcommand> (Socket Mode)
            └── activate <act_id> はマージ済 PR の Activate 用導線
```

- Web UI Merge は GitHub API 越しの merge を AdDroid から outbound で呼びます。
  AdDroid 自身は inbound webhook を受けません。
- Slack Socket Mode は AdDroid 側から Slack へ outbound WebSocket を張ります。
  Slack 側の request URL は不要です。

詳細は [`docs/GITOPS.md`](./GITOPS.md) を参照してください。

---

## 6. UI レイヤー

UI は `apps/web/components` の小さな in-house primitives と
[`design/tokens.css`](../design/tokens.css) のデザイントークンを source of truth とします。

実装側のルール:

- ページは Server Component を default、`'use client'` は対話 UI に限定。
- 表示するデータは Prisma クエリ経由で取得し、**ハードコード値を表示しない**。
- データが空のときは明示的な「空状態」を表示し、次のアクションを示す。
- デザイントークンは `design/tokens.css` を `apps/web/app/globals.css` から取り込み、
  hex を直接書かない。
- 任意統合 (Slack / Meta / LLM Provider / Image Provider) が未設定の状態で全ルートが
  200 OK を返し、各パネルは idle 表示。
- Meta execution mode (`live` / `sandbox` / `mock` / `unconfigured`) は TopBar チップで
  常時可視化。Activate / Apply の ConfirmDialog body 先頭にも mode を mono で表示。

---

## 7. 拡張パス

| 想定要件 | 対応 |
|---|---|
| ワーカー水平スケール | `addroid start --separate-worker` で `apps/worker` を別プロセスとして spawn (web は引き続き CLI 内、worker のみ別プロセス化) |
| 多人数運用 | the current implementation の範囲外。SSO 等は将来の独立コントラクト |
| 多テナント | 当面 1 ワークスペース 1 ホスト。多テナントは別契約で扱う |
| Meta sandbox / mock harness | `ADDROID_META_OAUTH_MOCK=1` で `MockMetaAdapter` に固定 (E2E / smoke-test 用) |
| LLM / Image Provider 追加 | `packages/llm-provider/factory.ts` / `image-factory.ts` の adapter pattern に従って追加 |
| Storage backend 切替 | 現状 `LocalDiskStorage` のみ。S3 / GCS は将来コントラクト |

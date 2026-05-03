# AdDroid OSS

AdDroid は、Meta 広告運用を **GitOps** として管理するためのセルフホスト可能な OSS です。
Ads YAML をリポジトリの単一ソースとして扱い、AI が広告案・改善案を生成し、AdDroid が
GitHub PR と監査ログで変更を管理し、pg-boss Cron でレポート取得・予算監視・改善提案を
自動実行します。

> **Status:** Initial OSS release candidate. `npm install` / `addroid init` /
> `addroid up` の 3 コマンドでローカル起動が完結します。`addroid init` は uv /
> Python / Meta Ads CLI / PostgreSQL を診断し、不足分は同じ流れで確認しながらセットアップできます。
> Slack / Meta OAuth / LLM Provider / Image Provider は任意統合で、未設定でも core
> ヘルスチェックを通過します。

---

## デザイン原則

- **ローカル完結**: Web UI は `127.0.0.1:3000` のみで listen。public IP / 専用ドメイン /
  SSL 証明書 / トンネリングサービスを要求しません。
- **outbound-only**: 全ての外部連携 (GitHub, Meta, Slack, LLM Provider, Image Provider) は
  AdDroid 側から outbound で起動します。GitHub Webhook は使わず、merged PR 検知は
  ETag-aware ポーリングで行います。Slack は Socket Mode のみで、request URL を要求しません。
- **GitOps**: 広告変更は ops repository の Pull Request としてレビュー・マージされ、
  全ての操作は監査ログ (`audit_logs`) に記録されます。
- **AI-assisted, human-approved**: AI は提案 (PR) を生成しますが、適用 (Apply) と有効化
  (Activate) は分離され、人間の承認 (PR merge / Web UI merge / Slack `/adops activate`) を
  経由してから Meta に反映されます。
- **Apply / Activate split**: PR merge から発火する Apply は新規オブジェクトを **PAUSED**
  で作成するのみで、ACTIVE 化は別経路 (`addroid activate` / Web UI / Slack) で行います。
- **任意統合は idle で OK**: Slack / Meta / LLM Provider / Image Provider が未設定の状態で
  Web UI は 200 OK を返し、Dashboard は idle 表示になります。任意統合不在を error として
  扱いません。

詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。

---

## 必要条件

最初に手で用意する必要があるのは **Node.js / npm** です。Git でこのリポジトリを
clone する場合は Git も必要です。`.nvmrc` に固定しているため、`nvm use` で
Node.js 22.11 以上を使ってください。

初心者向けに分けると、セットアップで必要になるものは次の 3 種類です。

| 区分 | 必要なもの | 何に使うか | 誰が入れるか |
|---|---|---|---|
| 先に用意 | Node.js / npm | `npm install` と AdDroid CLI の実行 | ユーザー |
| 先に用意 | Git | リポジトリ clone と GitOps / PR 管理 | ユーザー |
| `npm install` | JavaScript / TypeScript 依存 | Web UI、worker、CLI、Prisma など | npm が repo 内の `node_modules` に入れる |
| `addroid init` | uv | Python と Meta Ads CLI の導入補助 | 実行前に確認してから導入 |
| `addroid init` | Python 3.12+ | Meta Ads CLI の実行環境 | uv-managed Python 3.13 を導入 |
| `addroid init` | Meta Ads CLI | Meta 広告への Apply / Activate | `uv tool install meta-ads --python 3.13` で導入 |
| `addroid init` | PostgreSQL 16+ | AdDroid DB、queue、監査ログ | Homebrew / apt / dnf 等を実行前に確認 |
| Meta 側で作成 | Meta Developer App | App ID / App Secret と OAuth 認証 | ユーザーが Meta for Developers で作成 |

`addroid init` は初回セットアップ中に次の依存を診断します。不足している場合は、
実行するコマンドを表示してから確認します。`curl | sh` や `sudo` を伴う可能性がある
system 変更は既定で no です。

| 依存 | 用途 | `addroid init` の動作 |
|---|---|---|
| uv | Python / Meta Ads CLI の導入 | 無ければ公式 installer を実行前に確認 |
| Python 3.12+ | Meta Ads CLI の実行 | uv-managed Python 3.13 を導入 |
| Meta Ads CLI | Meta Apply / Activate | `uv tool install meta-ads --python 3.13` で導入 |
| PostgreSQL 16+ | DB / pg-boss queue | macOS は Homebrew、Linux は apt / dnf 実行前に確認 |

PostgreSQL の OS パッケージ導入には Homebrew または `sudo` が必要になる場合があります。
セットアップに失敗した場合でも、表示されたコマンドを実行してから `npm run addroid -- init`
を再実行すれば途中から続行できます。

`npm install` だけでは Meta Ads CLI や PostgreSQL は入りません。OS やユーザー環境を
変更するものは `addroid init` の中で確認してから実行します。

`addroid init` が作成する主なローカルファイル:

- `.env`: `DATABASE_URL`、`ENCRYPTION_KEY`、Meta Ads CLI のパス
- `~/.addroid/config.yaml`: AdDroid のローカル設定
- `~/.addroid/secrets.local.yaml`: Meta OAuth App ID / App Secret などの暗号化済み secret
- `~/.addroid/storage` / `~/.addroid/logs` / `~/.addroid/run`: 実行時データ、ログ、pid file

これらの secret 系ファイルは git 追跡対象外です。Meta OAuth App ID / App Secret は
`ENCRYPTION_KEY` で暗号化され、平文では保存しません。

### サポート対象プラットフォーム

AdDroid OSS は POSIX 前提 (`0600` パーミッション、`pg_dump` / `pg_restore`、
shell で起動する worker / web プロセス) で動作するため、以下の OS のみ動作検証
しています。

| OS | 状態 | 備考 |
|---|---|---|
| macOS 13+ (darwin x86_64 / arm64) | **対応** | 主開発環境。Homebrew 経由で PostgreSQL / Python 3.12+ を導入する想定 |
| Linux (x86_64 / arm64, glibc) | **対応** | Ubuntu 22.04+ / Debian 12+ / Fedora 39+ で動作 |
| Windows + WSL2 (Ubuntu 22.04+) | **対応 (推奨)** | WSL2 内の Linux として扱う。Windows native との混在不可 |
| Windows native (PowerShell / cmd.exe) | **非対応** | `0600` パーミッション、`pg_dump` の dynamic-link、`addroid up` の shell 起動が成立しないため対応しません。WSL2 を使用してください |
| その他 (FreeBSD, Alpine musl, etc.) | 動作未検証 | `addroid doctor` は `warn` として通過させますが動作保証は行いません |

`addroid doctor` の `platform` チェックがこの分類を runtime で再確認します
(macOS / Linux / WSL2 → `ok`、Windows native → `error`、それ以外 → `warn`)。
詳細は [`docs/SETUP.md` §1](docs/SETUP.md) と
[`docs/TROUBLESHOOTING.md` §0](docs/TROUBLESHOOTING.md) を参照してください。

任意要件 (未設定でも core 動作可):

- GitHub OAuth クライアント — ops repo bootstrap と PR ポーリングに必要
- Meta OAuth クライアント — Apply / Activate 実行に必要 (sandbox / mock 経路で開発可能)
- Codex / OpenAI OAuth クライアント — AI workflow 実行に必要 (StubLLMProvider で fail-closed)
- Slack Bot / App-level token — 通知と `/adops` slash command に必要 (任意)

---

## Meta App ID / App Secret の取得

Meta へ実際に接続して Apply / Activate するには、Meta for Developers で OAuth 用の
App を作成し、App ID / App Secret を取得します。画面名は Meta 側で変わることが
ありますが、流れは次の通りです。

公式リンク:

- [Meta for Developers](https://developers.facebook.com/)
- [Apps dashboard](https://developers.facebook.com/apps/)
- [Create app](https://developers.facebook.com/apps/create/)
- [Meta: Create an app](https://developers.facebook.com/docs/development/create-an-app/)
- [Meta: Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/)
- [Meta Marketing API](https://developers.facebook.com/docs/marketing-api/)

手順:

1. [Meta for Developers](https://developers.facebook.com/) にログインし、必要なら開発者登録を完了します。
2. [Apps dashboard](https://developers.facebook.com/apps/) で **Create app** を押します。
3. 用途は Business / business integration / manage business assets に近いものを選びます。Business Portfolio への紐付けを求められた場合は、広告アカウントを管理している Business を選びます。
4. App 作成後、App Dashboard の **Settings > Basic** で **App ID** を確認します。同じ画面の **App Secret** は `Show` などで表示してコピーします。
5. Product で **Facebook Login for Business** を追加し、必要に応じて **Marketing API** も有効化します。
6. Facebook Login for Business の OAuth 設定で **Valid OAuth Redirect URIs** に次を登録します。

```text
http://127.0.0.1:3000/api/oauth/meta/callback
```

`ADDROID_WEB_PORT` を変える場合は、ポート番号も同じ値にしてください。

7. Permission / scope は、まず `ads_read`, `ads_management`, `business_management` を使います。App が Development mode の間は、基本的に App admin / developer / tester と、その人がアクセスできる Business / Ad Account で試してください。
8. `npm run addroid -- init` の対話中に Meta OAuth App ID / App Secret を聞かれたら、ここで取得した値を入力します。どちらも暗号化されて `~/.addroid/secrets.local.yaml` に保存されます。
9. 初回セットアップ後、Meta アカウント連携は次で行います。

```bash
npm run addroid -- auth meta
```

App Secret はパスワード相当です。README、Issue、Slack、スクリーンショット、`.env.example`
などには貼らず、`addroid init` の入力欄にだけ貼ってください。

---

## 3-command クイックスタート

```bash
# 1. 依存をインストール
npm install

# 2. 初回セットアップ
#    uv / Python / Meta Ads CLI / PostgreSQL の不足分は確認しながら入れられます。
npm run addroid -- init

# 3. web (127.0.0.1:3000) と worker (pg-boss) を起動
npm run addroid -- up
```

`addroid init` は対話型 wizard として動作します。依存が不足している場合は、実行する
コマンドを見せた上で個別に確認します。

初回セットアップで作成・設定されるもの:

- `.env`: password 付き `DATABASE_URL` / `ENCRYPTION_KEY` / Meta Ads CLI のパス
- `~/.addroid/config.yaml`: ローカル設定
- `~/.addroid/secrets.local.yaml`: OAuth secret 置き場の stub
- PostgreSQL の `addroid` DB / role (ローカル既定ではランダム password を生成)
- Prisma schema
- uv-managed Python 3.13 と Meta Ads CLI

CI や手元の自動検証では次を使えます。

```bash
npm run addroid -- init --non-interactive --yes --skip-deps --skip-db-push
```

外部 API に接続せずに起動確認だけしたい場合は mock フラグも同時に作成できます。

```bash
npm run addroid -- init --non-interactive --yes --skip-deps --mock-integrations --skip-db-push
```

起動前に状態を確認したい場合は `doctor` を実行します。

```bash
npm run addroid -- doctor
```

`doctor` で `meta-ads-cli` が error になった場合は、通常は再度 `init` を実行すれば
Meta Ads CLI の導入を試行します。

```bash
npm run addroid -- init --install-deps
```

`addroid` を `npm install -g @addroid/cli` で導入済みの場合、CLI 操作は
`npm run addroid --` を `addroid` に置き換えられます。worker のみ別プロセスに分離して水平スケールしたい
場合は `addroid up --separate-worker` を使います。低レベルなデバッグ用途で個別に起動したい
場合のみ `npm run dev` / `npm run dev:worker` を直接呼び出せます。その場合は root の
`.env.local` を shell に export してから起動してください。

PostgreSQL の手動準備手順、`.env` と `.env.local` の挙動差、`addroid doctor` が点検する項目の
詳細は [`docs/SETUP.md`](docs/SETUP.md) を参照してください。

---

## モノレポ構成

```
addroid/
├── apps/
│   ├── web/                Next.js App Router (TypeScript) — localhost-only operator console
│   ├── worker/             pg-boss を起動する Node.js TypeScript ワーカー
│   └── cli/                `addroid` コマンド (init / doctor / up / down / status / logs / validate / plan / activate / cron / auth)
├── packages/
│   ├── db/                 Prisma client の共通エクスポート
│   ├── config/             ~/.addroid/config.yaml と secrets.local.yaml の取扱い、暗号化境界
│   ├── queue/              pg-boss 設定とプリセット cron / Apply executor
│   ├── github-adapter/     GitHub OAuth + Octokit + ETag-aware ポーリング adapter
│   ├── meta-adapter/       Meta Graph API adapter (Real / Mock / Stub) と sandbox harness
│   ├── llm-provider/       LLM / Image Provider 抽象 (Codex / Stub / Mock) と Creative QA
│   ├── yaml-schemas/       Ads YAML / cron.yaml / project.yaml の Zod スキーマ
│   └── ops-template/       生成 ops リポジトリのテンプレート (brand.yaml 他)
├── prisma/
│   └── schema.prisma       AdDroid テーブル + pg-boss 互換スキーマ
├── design/
│   └── tokens.css          UI デザイントークン (source of truth)
├── templates/
│   └── slack-app-manifest.yaml   Slack App Manifest (Socket Mode only)
└── docs/
    ├── ARCHITECTURE.md
    ├── SETUP.md
    ├── SECURITY.md
    ├── TROUBLESHOOTING.md
    ├── META.md
    ├── SLACK.md
    ├── LLM_PROVIDER.md
    └── GITOPS.md
```

---

## 主要コマンド

| コマンド | 説明 |
|---|---|
| `npm install` | ワークスペース全体の依存解決 |
| `npm run addroid -- init` | 対話型初期セットアップ (`.env` / DB / `~/.addroid` / Meta Ads CLI) |
| `npm run addroid -- doctor` | uv / Python 3.12+ / Meta Ads CLI / PostgreSQL 16+ / DATABASE_URL / ENCRYPTION_KEY / config を診断 |
| `npm run addroid -- up` | web (`127.0.0.1:3000`) と worker (pg-boss) を 1 監督プロセスで起動 |
| `npm run addroid -- down` | `addroid up` で起動した web/worker を停止 (pid file 経由) |
| `npm run addroid -- status` | config / プロセス / 直近 doctor 結果のスナップショット |
| `npm run addroid -- logs` | `~/.addroid/logs/{up,web,worker}.log` を tail |
| `npm run addroid -- validate` | ops repo の Ads / cron / project YAML を Zod 検証 |
| `npm run addroid -- plan` | Apply の dry-run シミュレーション (`--dry-run` 必須) |
| `npm run addroid -- activate <act_id>` | PAUSED → ACTIVE 移行 (Apply とは別の承認境界) |
| `npm run addroid -- cron <list/enable/disable/run/...>` | cron preset 管理 |
| `npm run addroid -- auth <provider>` | provider トークン登録 (現状 Slack のみ。Socket Mode 接続テスト + 暗号化保存) |
| `npm run dev` | (任意) apps/web 単独を `127.0.0.1:3000` で起動 |
| `npm run dev:worker` | (任意) apps/worker (pg-boss) 単独を起動 |
| `npm run typecheck` | 全ワークスペースで `tsc --noEmit` |
| `npm run lint` | 全ワークスペースで lint |
| `npm run test` | 全ワークスペースで単体テスト |
| `npm run db:generate` | Prisma クライアント再生成 |
| `npm run db:push` | DB スキーマを直接反映 (開発用) |
| `npm run db:migrate` | マイグレーションを生成して適用 |
| `npm run package:smoke` | `@addroid/cli` を `npm pack` して clean dir に install し postinstall / help / doctor を smoke-test |
| `npm run publish:dry-run` | `npm publish --dry-run` (実 publish は人間承認後に手動実行) |

---

## 主要ドキュメント

| ドキュメント | 内容 |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | ローカルセットアップ手順、PostgreSQL 準備、環境変数、`addroid doctor` の挙動 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | プロセスモデル、モノレポ境界、Prisma スキーマ、cron preset、Apply / Activate split |
| [`docs/SECURITY.md`](docs/SECURITY.md) | localhost-only / outbound-only 前提、token 暗号化、Meta / Slack / LLM トークン取扱、OSS リリース衛生 |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | よくある失敗モード (DB / `ENCRYPTION_KEY` / ポート競合 / OAuth / outbound 接続 / Slack Socket Mode / LLM 未設定) |
| [`docs/META.md`](docs/META.md) | Meta OAuth セットアップ、sandbox / mock harness、Apply / Activate split |
| [`docs/SLACK.md`](docs/SLACK.md) | Slack Socket Mode セットアップ (任意)、manifest テンプレ、`/adops` subcommand |
| [`docs/LLM_PROVIDER.md`](docs/LLM_PROVIDER.md) | Codex / OpenAI OAuth、`ADDROID_LLM_MOCK`、StubLLMProvider fail-closed、Image Provider |
| [`docs/GITOPS.md`](docs/GITOPS.md) | ops repo 構成、PR ポーリング、3 つの merge 経路 (GitHub / Web / Slack) と承認境界 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | npm publish 手順、SemVer 方針、CHANGELOG 運用、git tag、ロールバック (deprecate / dist-tag / unpublish) |
| [`CHANGELOG.md`](CHANGELOG.md) | リリースごとの変更点 (Keep a Changelog 1.1.0 / SemVer 2.0.0) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | OSS contribution flow、テスト走行、コミット規約、PR 規約、セキュリティ報告窓口 |

---

## OSS リリース衛生

- **secrets を絶対にコミットしない**: `.env*`, `secrets.local.yaml`, `*.local.yaml` は
  すべて `.gitignore` の対象です。`.env.example` には placeholder 値のみを書き、
  実値 (`ENCRYPTION_KEY` の本体や OAuth トークン) を書き込まないこと。
- **個人パスを書かない**: `~/.addroid` 等の home 相対表現を使い、絶対パスは
  `process.env.HOME` 経由で解決します。`ADDROID_HOME` を環境変数で上書きできます。
- **個人アカウントをハードコードしない**: GitHub / Meta / Slack / LLM の identifier は
  すべて DB / config / env から読みます。特定のユーザー名・トークン・組織名・`act_id` を
  ソースに埋め込まないこと。
- **outbound-only 仕様を破らない**: inbound webhook / 公開 URL / 専用ドメイン /
  SSL 証明書 / トンネリングサービスを要求する変更は禁止です。AdDroid OSS は
  `127.0.0.1` のみで listen し、外部統合は AdDroid 側からの outbound でのみ動作します。
- **任意統合のフェイルクローズ**: LLM Provider 未設定時は `StubLLMProvider` が fail-closed し、
  GitOps 状態を破壊しません。Slack / Image Provider 未設定時は通知 / 画像生成のみが
  skip され、Apply / Activate / レポート取得は通常通り動きます。

詳細とリリース前チェックリストは [`docs/SECURITY.md`](docs/SECURITY.md) を、
リリース手順 (バージョニング / CHANGELOG / `npm publish` / git tag / ロールバック) は
[`docs/RELEASE.md`](docs/RELEASE.md) を、リリースごとの変更点は
[`CHANGELOG.md`](CHANGELOG.md) を参照してください。

---

## ライセンス

Apache-2.0 — リポジトリ root の `LICENSE` および各ワークスペースの `package.json#license`
が source of truth です。fork 時はライセンスを変更可能ですが、その場合は依存関係の互換性を
ご自身で確認してください。

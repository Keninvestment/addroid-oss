# AdDroid OSS

AdDroid は、Meta 広告運用を **GitOps** として管理するためのセルフホスト可能な OSS です。
Ads YAML をリポジトリの単一ソースとして扱い、AI が広告案・改善案を生成し、AdDroid が
GitHub PR と監査ログで変更を管理し、pg-boss Cron でレポート取得・予算監視・改善提案を
自動実行します。

> **Status:** Initial OSS release candidate. `npm install` / `addroid init` /
> `addroid up` の 3 コマンドでローカル起動が完結します。`addroid init` は uv /
> Python / Meta Ads CLI / PostgreSQL を診断し、不足分は同じ流れで確認しながらセットアップできます。
> Meta 広告アカウントを実際に利用するには Meta Access Token が必須です。未設定でも core
> ヘルスチェックは通りますが、Apply / Activate / レポート取得はできません。

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
- **未設定統合は idle で OK**: Slack / Meta / LLM Provider / Image Provider が未設定の状態でも
  Web UI は 200 OK を返し、Dashboard は idle 表示になります。ただし実際の Meta 広告アカウントを
  利用するには Meta Access Token が必須です。

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
| `addroid init` | Meta Ads CLI | Meta 広告への insights / Apply / Activate | `uv tool install meta-ads --python 3.13` で導入 |
| `addroid init` | PostgreSQL 16+ | AdDroid DB、queue、監査ログ | Homebrew / apt / dnf 等を実行前に確認 |
| Meta 側で発行 | Meta Access Token | Meta 広告アカウント接続、Apply / Activate、レポート取得 | ユーザーが Meta Business Suite / Graph API Explorer 等で発行 |

`addroid init` は初回セットアップ中に次の依存を診断します。不足している場合は、
実行するコマンドを表示してから確認します。`curl | sh` や `sudo` を伴う可能性がある
system 変更は既定で no です。

| 依存 | 用途 | `addroid init` の動作 |
|---|---|---|
| uv | Python / Meta Ads CLI の導入 | 無ければ公式 installer を実行前に確認 |
| Python 3.12+ | Meta Ads CLI の実行 | uv-managed Python 3.13 を導入 |
| Meta Ads CLI | Meta insights / Apply / Activate | `uv tool install meta-ads --python 3.13` で導入 |
| PostgreSQL 16+ | DB / pg-boss queue | macOS は Homebrew、Linux は apt / dnf 実行前に確認 |

PostgreSQL の OS パッケージ導入には Homebrew または `sudo` が必要になる場合があります。
セットアップに失敗した場合でも、表示されたコマンドを実行してから `npm run addroid -- init`
を再実行すれば途中から続行できます。

`npm install` だけでは Meta Ads CLI や PostgreSQL は入りません。OS やユーザー環境を
変更するものは `addroid init` の中で確認してから実行します。

`addroid init` が作成する主なローカルファイル:

- `.env`: `DATABASE_URL`、`ENCRYPTION_KEY`、Meta Ads CLI のパス
- `~/.addroid/config.yaml`: AdDroid のローカル設定
- `~/.addroid/secrets.local.yaml`: provider 固有の暗号化済み secret stub
- `~/.addroid/storage` / `~/.addroid/logs` / `~/.addroid/run`: 実行時データ、ログ、pid file

これらの secret 系ファイルは git 追跡対象外です。Meta Access Token は
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

実利用で必要な外部連携:

- GitHub OAuth クライアント — ops repo bootstrap と PR ポーリングに必要
- Meta Access Token — 実際の Meta 広告アカウント接続、Apply / Activate、レポート取得に必須
- LLM Provider — AI workflow 実行に必要。初回セットアップでは OpenAI / Anthropic API key
  または Codex OAuth を選択できます (未設定時は StubLLMProvider で fail-closed)
- Image Provider — クリエイティブ画像生成に必要。OpenAI API key は GPT Image 2 に再利用でき、
  Codex OAuth は localhost の Codex app-server 経路で生成できます
- Slack Bot / App-level token — 通知と `/adops` slash command に必要 (任意)

---

## Meta Access Token の取得

Meta へ実際に接続して Apply / Activate するには、Meta Marketing API を呼び出せる
Access Token が必要です。AdDroid の標準セットアップは OAuth callback を使わず、
`addroid auth meta` で token を貼り付ける方式です。ローカル利用のために HTTPS
callback URL やトンネルサービスを用意する必要はありません。

App ID / App Secret だけでは広告アカウントの読み書きはできません。Meta Ads CLI と
AdDroid が実行時に使うのは `ACCESS_TOKEN` と `AD_ACCOUNT_ID` です。AdDroid は token
入力後に取得できる Ad Account を表示し、利用するアカウントを選択します。

公式リンク:

- [Meta for Developers](https://developers.facebook.com/)
- [Apps dashboard](https://developers.facebook.com/apps/)
- [Create app](https://developers.facebook.com/apps/create/)
- [Meta: Create an app](https://developers.facebook.com/docs/development/create-an-app/)
- [Meta Marketing API](https://developers.facebook.com/docs/marketing-api/)
- [Meta Marketing API: Get Started](https://developers.facebook.com/docs/marketing-apis/get-started)
- [Meta: Install Apps, Generate, Refresh, and Revoke System User Tokens](https://developers.facebook.com/docs/marketing-api/system-users/install-apps-and-generate-tokens)
- [Graph API Explorer](https://developers.facebook.com/tools/explorer/)

手順:

1. [Meta for Developers](https://developers.facebook.com/) にログインし、必要なら開発者登録を完了します。
2. [Apps dashboard](https://developers.facebook.com/apps/) で **Create app** を押します。
3. app type は **Business** を選びます。Business Portfolio への紐付けを求められた場合は、広告アカウントを管理している Business を選びます。
4. App Dashboard の **Add products** から **Marketing API** を有効化します。
5. 長期運用では System User Access Token を推奨します。Meta Business Settings で **Users > System Users** を開き、System User を作成または選択します。
6. 同じ System User 画面で **Add Assets** を押し、対象の **Ad Account** と **App** を割り当てます。広告の作成・更新まで行う場合は、Ad Account 側の権限を Admin 相当にしてください。
7. System User を選んだ状態で **Generate New Token** を押し、手順 2-4 で用意した Business App を選択します。
8. Permission / scope は、まず `ads_read`, `ads_management` を選びます。Business 配下の資産取得で必要な場合は `business_management` も付与します。Meta の System User token は非期限 token と 60 日期限 token を選べます。漏えい時のリスクを抑えたい場合は 60 日期限 token を選び、定期的に再発行してください。
9. 表示された token は、その画面を離れると再表示できない前提で安全な場所に一時保管します。AdDroid へ登録した後は、平文を共有・コミットしないでください。
10. 初回セットアップ後、Meta アカウント連携は次で行います。token 入力後、AdDroid が取得できる Ad Account を表示するので、利用するアカウントを選択してください。

```bash
npm run addroid -- auth meta
```

検証だけなら [Graph API Explorer](https://developers.facebook.com/tools/explorer/) で User Access Token を生成して使うこともできます。ただし User token は個人ログインに紐付き、期限切れしやすいため、非エンジニアが継続運用する AdDroid では System User Access Token を標準手順とします。

Access Token はパスワード相当です。README、Issue、Slack、スクリーンショット、`.env.example`
などには貼らず、`addroid auth meta` の入力欄にだけ貼ってください。AdDroid は token を
`ENCRYPTION_KEY` で暗号化して `oauth_tokens` に保存し、Meta Ads CLI 実行時だけ
`ACCESS_TOKEN` / `AD_ACCOUNT_ID` として子プロセスに渡します。

OAuth callback を使いたい上級者は `npm run addroid -- auth meta --oauth` を利用できます。
この場合は HTTPS の callback URL を Meta App に登録できる環境が必要です。通常のローカル
OSS 利用では token 入力方式を使ってください。

---

## クイックスタート

```bash
# 1. 依存をインストール
npm install

# 2. 初回セットアップ
#    uv / Python / Meta Ads CLI / PostgreSQL の不足分と、Meta Access Token の必要項目を確認できます。
npm run addroid -- init

# 3. 実際の Meta 広告アカウントを接続
#    Meta Access Token を貼り付けると、取得できる Ad Account が表示されます。
npm run addroid -- auth meta
npm run addroid -- accounts select

# 4. web (127.0.0.1:3000) と worker (pg-boss) を起動
npm run addroid -- up
```

`addroid init` は対話型 wizard として動作します。依存が不足している場合は、実行する
コマンドを見せた上で個別に確認します。Meta token が未設定の場合は、Access Token の
必要権限と `addroid auth meta` の手順を画面に表示します。

初回セットアップで作成・設定されるもの:

- `.env`: password 付き `DATABASE_URL` / `ENCRYPTION_KEY` / Meta Ads CLI のパス
- `~/.addroid/config.yaml`: ローカル設定
- `~/.addroid/secrets.local.yaml`: OAuth secret 置き場の stub
- PostgreSQL の `addroid` DB / role (ローカル既定ではランダム password を生成)
- Prisma schema
- uv-managed Python 3.13 と Meta Ads CLI
- Meta Access Token: 実利用では必須。入力された値は暗号化して `oauth_tokens` に保存し、
  取得できる Ad Account から既定アカウントを選択
- LLM Provider: OpenAI / Anthropic API key は `addroid auth llm` 経由で暗号化保存、
  Codex OAuth は `addroid up` 後に `/ai` から接続
- Image Provider: OpenAI API key 登録済みなら GPT Image 2 を利用可能。Codex OAuth の場合は
  localhost の `codex app-server` 経由で画像生成

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

日次レポートは Meta Ads CLI の `ads insights get` を優先して使います。
`ADDROID_META_CLI_BIN` が未設定の開発環境では mock insights に戻ります。CLI で取得できない
柔軟な breakdown / attribution window が必要な場合は、Meta Access Token 登録済みの状態で
`ADDROID_META_GRAPH_INSIGHTS_FALLBACK=1` を設定すると Graph API の read-only fallback を使えます。

自然言語の自動運用リクエストは、直接 Meta を変更せず、まず
`workflows/automation-rules.yaml` と同形の DSL に変換してから評価します。例:
「本日消化 5000 円以上で 0CV のキャンペーンを停止」「過去 7 日間 CPA 3000 円以下の
キャンペーン予算を 20% 上げる」。停止対象は campaign / adset / ad、予算変更対象は
campaign / adset です。`ad` は直接予算を持たないため、親 adset または campaign に解決します。
「今すぐ」「一度だけ」が明示されていれば単発実行、「毎日」「1時間おき」などがあれば
定期ルールとして扱います。どちらか判断できない予算変更・停止・再開リクエストでは、
実行前に「今すぐ一度だけ」「定期ルール」「両方」の確認質問を返します。

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
| `npm run addroid -- init` | 対話型初期セットアップ (`.env` / DB / `~/.addroid` / Meta Ads CLI / LLM Provider) |
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
| [`docs/META.md`](docs/META.md) | Meta Access Token セットアップ、sandbox / mock harness、Apply / Activate split |
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
- **LLM API key は暗号化保存**: `addroid auth llm --provider openai|anthropic` で登録した
  API key は `ENCRYPTION_KEY` により `oauth_tokens.access_token_ciphertext` に保存され、
  `.env` への恒久保存は不要です。
- **画像生成キーも平文保存しない**: GPT Image 2 は登録済み OpenAI API key の暗号化済み
  credential を再利用します。Codex app-server 経路は localhost のみ許可し、外部 URL を
  ブラウザに露出しません。

詳細とリリース前チェックリストは [`docs/SECURITY.md`](docs/SECURITY.md) を、
リリース手順 (バージョニング / CHANGELOG / `npm publish` / git tag / ロールバック) は
[`docs/RELEASE.md`](docs/RELEASE.md) を、リリースごとの変更点は
[`CHANGELOG.md`](CHANGELOG.md) を参照してください。

---

## ライセンス

Apache-2.0 — リポジトリ root の `LICENSE` および各ワークスペースの `package.json#license`
が source of truth です。fork 時はライセンスを変更可能ですが、その場合は依存関係の互換性を
ご自身で確認してください。

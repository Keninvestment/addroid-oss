# AdDroid OSS — Setup ガイド

このドキュメントはローカル環境で AdDroid OSS を立ち上げる手順を示します。
すべての操作は `127.0.0.1` 上で完結し、public IP / 専用ドメイン / SSL 証明書 /
トンネリングサービスは一切不要です。

---

## 1. 必要なソフトウェア

### 1.0 サポート対象プラットフォーム

AdDroid OSS は POSIX 前提 (`0600` パーミッション、`pg_dump` / `pg_restore`、
常駐サービスまたは前景実行で起動する web/worker プロセス) で動作します。
サポート対象は次の通りです。

| OS | 状態 | 備考 |
|---|---|---|
| macOS 13+ (darwin x86_64 / arm64) | **対応** | 主開発環境 |
| Linux (x86_64 / arm64, glibc) | **対応** | Ubuntu 22.04+ / Debian 12+ / Fedora 39+ で動作 |
| Windows + WSL2 (Ubuntu 22.04+) | **対応 (Windows ユーザー向け推奨)** | WSL2 内の Linux として扱う |
| Windows native (PowerShell / cmd.exe) | **非対応** | WSL2 を使用してください |
| その他 (FreeBSD, Alpine musl, etc.) | 動作未検証 | `addroid doctor` は `warn` として通過させますが動作保証は行いません |

`addroid doctor` の `platform` チェックがこの分類を runtime で再確認します:

- macOS (`darwin`) / Linux / WSL2 → `[ ok ]`
- Windows native (`win32`) → `[error]` (WSL2 を使う hint を返します)
- それ以外 → `[warn]` (未検証であることを示唆)

> **WSL2 を使う場合の注意**:
> - PostgreSQL / Node.js はすべて **WSL2 内のディストリビューション**
>   (例: Ubuntu) に install してください。Windows 側の同名ツールと混在させると、
>   path 解決 / パーミッション / `localhost` 解決の整合性が崩れます。
> - リポジトリは WSL2 のホームディレクトリ (例: `~/dev/addroid`) に clone してください。
>   Windows ファイルシステム (`/mnt/c/...`) 上で作業すると I/O が遅く、改行コードが
>   CRLF に書き換わります。
> - `127.0.0.1:3000` は WSL2 の `localhost` です。Windows 側ブラウザから
>   `http://localhost:3000` で参照できます (WSL2 はポートを自動転送)。
> - 詳細は [`docs/TROUBLESHOOTING.md` §0](./TROUBLESHOOTING.md) を参照してください。

### 1.1 必要なソフトウェア

| 種別 | 要件 | 確認コマンド |
|---|---|---|
| Node.js | 22.11 以上 (Slack Socket Mode 検証で `globalThis.WebSocket` を使う) | `node --version` |
| npm | 10 以上 (Node 22 同梱) | `npm --version` |
| PostgreSQL | 16 以上 | `psql --version` |
| GitHub CLI | 推奨 (`connect github` のブラウザ認証で使用) | `gh --version` |

Node.js / npm 以外は `addroid init` が初回セットアップ中に診断します。不足分が
ある場合は実行するコマンドを表示してから確認します。`brew` や `sudo` を伴う
system 変更は個別に確認します。セットアップに失敗した場合は表示されたコマンドを
手動で実行し、再度 `npm run addroid -- init` を実行してください。

`addroid doctor` は上記を 1 コマンドで検証します (実装済み)。Meta 入稿・レポートは
Graph API を正規経路にするため、Meta Ads CLI / Python / uv は標準必須依存ではありません。

---

## 2. PostgreSQL の準備

```bash
# 起動確認
pg_isready -h localhost -p 5432

# 0. ローカル用に強いパスワードを 1 つ用意 (任意のものを使ってよい)
#    例: 18 byte ランダム値を base64url で生成して shell 変数に格納
DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")

# 1. addroid ロールを先に作成 (PASSWORD は上で決めた値を埋め込む)
psql -d postgres -c "CREATE ROLE addroid WITH LOGIN PASSWORD '${DB_PASSWORD}' CREATEDB;" 2>/dev/null || true

# 2. addroid をオーナーとして DB を作成 (Prisma db push と pg-boss の CREATE SCHEMA に必要)
createdb -O addroid addroid 2>/dev/null || true

# 3. PostgreSQL 15+ では public スキーマへの CREATE が role に必要
psql -d addroid -c "ALTER SCHEMA public OWNER TO addroid;" 2>/dev/null || true
psql -d addroid -c "GRANT ALL ON SCHEMA public TO addroid;" 2>/dev/null || true

# 4. .env の DATABASE_URL を埋める (このシェルセッションでだけ反映する例)
#    永続化したい場合は .env / .env.local に直接書き込む。
export DATABASE_URL="postgresql://addroid:${DB_PASSWORD}@localhost:5432/addroid"
```

> `'addroid'` のような既知の弱いパスワードを **そのまま埋め込まないでください**。
> ロール作成時に決めた値はリポジトリには絶対コミットせず、`.env` /
> `.env.local` (どちらも `.gitignore` 済) または OS のキーチェーン等で保管します。

> `addroid` ロールは DB オーナーである必要があります。
> 既存の DB が別ユーザー所有で作られている場合は
> `psql -d postgres -c "ALTER DATABASE addroid OWNER TO addroid;"` で付け替えてください。
> Prisma の `db push` と pg-boss の `boss.start()` (独自 `pgboss` スキーマの `CREATE SCHEMA`) は、
> `addroid` ロールに対し DB の `CREATE` 権限と `public` スキーマの `CREATE` 権限の両方を要求します。

PostgreSQL 16 以上を要求する理由:
- pg-boss が利用する `gen_random_uuid()` / JSONB 関数群を最新挙動で揃えるため。
- AdDroid のスキーマで `pg_trgm` 等の拡張を後続タスクで利用予定のため。

---

## 3. 環境変数

通常は `addroid init` がリポジトリ root の **`.env`** を作成し、
`DATABASE_URL` と `ENCRYPTION_KEY` を保存します。手動で設定したい場合だけ、
`.env.example` をコピーして編集してください。

```bash
cp .env.example .env
```

`.env` を採用する理由は、AdDroid が利用する 3 つのツールチェーンすべてで auto-load
されるためです:

| ツールチェーン | `.env` を読む? | `.env.local` を読む? |
|---|---|---|
| Prisma CLI (`npm run db:generate` / `npm run db:push` / `npm run db:migrate`) | yes (built-in) | **no** |
| Next.js (`apps/web`) | yes (apps/web から探索) | yes (apps/web から探索) |
| `addroid` CLI (`init` / `doctor` / `up` / `down` / `status` / `logs`) | yes (起動時に自動 load) | yes (起動時に自動 load) |

`.env.local` を併用した場合、`addroid` CLI と Next.js は `.env.local` を `.env` より
優先して読みます (Next.js の慣例どおり)。`addroid` CLI は `packages/config/src/env-files.ts`
の `loadEnvFilesFromRepoRoot()` で読み込み、shell に export 済みの値は上書きしません。
`npm run addroid -- start` と前景実行の `npm run addroid -- up` は CLI がリポジトリ root の
`.env` / `.env.local` を読み込んでから web / worker に渡します。
低レベルなデバッグで `npm run dev` を直接使う場合は、
Next.js の cwd が `apps/web` になるため root の `.env.local` が自動では読まれません。
root の値を使うときは `set -a; source .env.local; set +a; npm run dev` のように shell へ
export してから起動してください。

> **注意**: Prisma の `db:*` コマンドは `.env.local` を読みません。`.env.local` だけに
> `DATABASE_URL` を書いた状態で `npm run db:push` を実行すると失敗します。Prisma にも
> 値を渡したいときは、いずれかの方法を取ってください:
>
> 1. `.env` 側に `DATABASE_URL` を書く (推奨)
> 2. shell で `export DATABASE_URL=...` してから `npm run db:*` を実行
> 3. `set -a; source .env.local; set +a; npm run db:push` のように一時的に export

| 変数 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 接続文字列。形式: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE` (ロール作成手順は [TROUBLESHOOTING §2.2](./TROUBLESHOOTING.md#22-npm-run-dbpush-が-permission-denied-for-schema-public-で失敗) / [prisma/README.md](../prisma/README.md) 参照) |
| `ENCRYPTION_KEY` | OAuth トークン暗号化に使う 32 バイト以上のランダム値 |
| `ADDROID_HOME` | 任意。`~/.addroid` の代わりに使う作業ディレクトリ |
| `ADDROID_WEB_HOSTNAME` | 任意。Web UI バインドアドレス。既定: `127.0.0.1` |
| `ADDROID_WEB_PORT` | 任意。Web UI ポート。既定: `3000` |
| `ADDROID_USER_TIMEZONE` | 任意。標準 cron の実行時刻と、Meta ad account の `timezone_name` が無い場合の report 取得日を決める IANA timezone。未設定時は `TZ` / 実行環境 timezone / UTC の順にフォールバック |

`ENCRYPTION_KEY` の生成例:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> **重要**: `.env`, `.env.local`, `secrets.local.yaml` 等は git で追跡されません
> (`.gitignore` 参照)。復元手段は OS のバックアップに任せ、リポジトリには絶対に
> コミットしないでください。

---

## 4. 依存解決と初期セットアップ

```bash
npm install
npm run addroid -- init
```

`addroid init` は TTY では対話型 wizard として動作します。依存が不足している場合は
実行するコマンドを見せた上で個別に確認します。
主な処理は次の通りです。

- GitHub CLI / PostgreSQL 16+ の診断と不足依存のインストール
- `.env` の作成、password 付き `DATABASE_URL` と `ENCRYPTION_KEY` の保存
- `~/.addroid/config.yaml`、`secrets.local.yaml`、`storage` / `logs` / `run` の作成
- ローカル PostgreSQL の `addroid` role/database 作成 (既定ではランダム password を生成)
- `npm run db:generate` と `npm run db:push` による Prisma schema 反映
- 実際の Meta 広告アカウント利用に必要な Meta Access Token の取得手順と必要権限を表示
- Meta App の Privacy Policy URL 設定と Live / 公開モード化が本番入稿に必要であることを表示
- `addroid connect meta` で Access Token を暗号化保存し、取得できる Ad Account から既定を選択

既存の `.env` / `config.yaml` / `secrets.local.yaml` は破壊しません。既存値がある場合は保持し、
`.env.example` 由来の placeholder だけを置き換えます。

CI や手順検証で対話を避ける場合は以下を使えます。

```bash
npm run addroid -- init --non-interactive --yes --skip-deps --skip-db-push
```

依存セットアップを明示的に実行したい場合は以下を使えます。`--install-deps` は
依存確認後に通常の init も続行します。

```bash
npm run addroid -- init --install-deps
```

手動で DB schema だけ反映したい場合は従来通り以下を実行できます。

```bash
npm run db:generate
npm run db:push
```

`db:push` は開発用に直接スキーマを反映します。本番運用 (将来の `--separate-worker`) では
`db:migrate` でマイグレーション履歴を残します。

---

## 5. ローカル起動

### 統合プロセス (3-command setup の既定モデル)

```bash
npm install                 # JS dependencies + CLI postinstall の next-step 表示
npm run addroid -- init     # 対話型 wizard: .env / DB / ~/.addroid / Prisma schema / Meta / GitHub / LLM

# 実際の Meta 広告アカウントと入稿用 ops repo は init 内で接続します。
# init でスキップした場合だけ、後から個別に実行します。
addroid connect meta
addroid connect github
addroid start               # 常駐サービスを起動・修復
```

`npm run addroid -- init` は repository checkout での初回 bootstrap です。`init` 後は
`addroid status` / `addroid chat` / `addroid start` を直接呼び出せます。互換 alias として
`addroid-cli <command>` も作成されます。現在の shell で PATH がまだ反映されていない場合は、
`init` の出力に表示される `export PATH=...` を実行してください。詳細診断の `addroid doctor` は任意の
診断コマンドで、セットアップ後や起動前の確認に使います。`addroid init` は対話端末で
完了した場合、macOS は LaunchAgent、Linux / WSL2 は systemd user service として
AdDroid を登録し、Web UI と pg-boss worker をログイン時に自動起動します。
`addroid start` はこの常駐サービスをインストールして起動・修復します。

前景で動作確認したい場合は `addroid start --foreground` を使います。worker を別ホストへ
水平スケールしたい場合は `addroid start --foreground --separate-worker` で worker のみ
別プロセスに spawn できます (web は引き続き CLI 内で起動)。

### 個別起動 (任意・デバッグ用途)

低レベルなデバッグや差し替え検証で web / worker を個別に動かしたい場合は、
従来通りワークスペース別に起動できます。

```bash
npm run dev          # 127.0.0.1:3000 で Web UI 単独起動
npm run dev:worker   # 別ターミナルで pg-boss worker 単独起動
```

`--separate-worker` モードで worker のみ別ホストに移すときの分離境界は
この個別起動経路と同じです。

### 起動後の確認

| URL | 内容 |
|---|---|
| http://127.0.0.1:3000/ | Dashboard — config / DB / worker / GitHub / Meta / LLM / Slack / cron / audit の状態 |
| http://127.0.0.1:3000/setup | Setup ガイド (UI 内) — config / DB / worker / GitHub / Meta / LLM Provider / Image Provider / Slack / Doctor / OSS Release Readiness / Documentation |
| http://127.0.0.1:3000/accounts | Meta Access Token 接続、Business / Ad Account 一覧、execution mode override |
| http://127.0.0.1:3000/accounts/select | 既定 Ad Account の選択 |
| http://127.0.0.1:3000/github | GitHub OAuth、ops repo、PR ポーリング状態 |
| http://127.0.0.1:3000/approvals | 承認待ち PR 一覧と Web UI からの merge |
| http://127.0.0.1:3000/plans | Apply 前の plan dry-run 結果 |
| http://127.0.0.1:3000/campaigns | 既存 Meta 階層と Activate 操作 |
| http://127.0.0.1:3000/reports/daily | 日次レポート |
| http://127.0.0.1:3000/budget | 予算超過監視 |
| http://127.0.0.1:3000/improvements | 改善提案 PR 一覧 |
| http://127.0.0.1:3000/ai | AI run 履歴と provider ヘルス |
| http://127.0.0.1:3000/creatives | クリエイティブライブラリ |
| http://127.0.0.1:3000/cron | 登録済み cron スケジュール |
| http://127.0.0.1:3000/cron/runs | cron 実行履歴 |
| http://127.0.0.1:3000/cron/audit | 監査ログ |
| http://127.0.0.1:3000/logs | 細粒度実行ログ (sanitize-on-render) |
| http://127.0.0.1:3000/api/health | サーバ JSON ヘルス |

Slack / Meta / LLM / Image Provider が未設定でも上記の全ルートは 200 OK を返し、
該当パネルは idle 表示になります。ただし実際の Meta 広告アカウントを利用するには
Meta Access Token が必須です。Meta 未接続のままでは Apply / Activate / レポート取得はできません。

---

## 6. `addroid doctor` の挙動

`addroid doctor` は以下を検査し、各項目に `ok / warn / error / skipped` と
次の一手を `hint` として返します (実装は `apps/cli/src/lib/checks.ts`)。

| check | 内容 |
|---|---|
| `platform` | macOS / Linux / WSL2 のいずれかか (Windows native は error、それ以外は warn) |
| `github-cli` | GitHub CLI (`gh --version`) が呼び出せるか。client id 不要のブラウザ認証に使用 |
| `postgres-16` | PostgreSQL 16+ が `psql --version` から判別できるか (`psql` が無ければ warn) |
| `DATABASE_URL` | 設定済みで Prisma 経由で `SELECT 1` できるか |
| `ENCRYPTION_KEY` | 設定済みで 32 byte 以上か |
| `config` | `~/.addroid/config.yaml` が存在し読み込めるか / `~/.addroid/secrets.local.yaml` のパーミッションが `0600` か |

実行結果は `doctor_results` テーブルに 1 行追記され、Web UI の `/setup` ページから
最新結果を参照できます (DB 未到達でも CLI 自体は exit code 1 とせず、いずれかの
check が error の場合のみ exit code 1 を返します)。

外部統合 (GitHub / Meta / Slack / LLM Provider / Image Provider) は doctor の必須
checks には含まれません。これらは `/setup` の OSS Release Readiness カードと各
専用パネル経由で接続状況を確認します。Meta Access Token は core 起動チェックでは任意ですが、
実ユーザーが Meta 広告アカウントを操作するには必須です。

---

## 7. 外部統合のセットアップ

各統合は未設定でも core 動作 (Dashboard / DB / worker / cron / Doctor) を阻害しません。
実際の Meta 広告アカウントを利用する場合は Meta Access Token、実際に入稿する場合は
GitHub token と ops repo 連携を必ず登録してください。CLI は GitHub CLI (`gh`) があれば
ブラウザ認証を使うため client id 入力は不要です。`gh` が無い場合は
`github.oauth.clientId` を使った Device Flow も利用できます。Web UI OAuth Code Flow は
`github.oauth.clientId` / `github.oauth.clientSecret` を使います。

| 統合 | 役割 | 詳細 |
|---|---|---|
| GitHub | ops repo bootstrap、PR ポーリング、merge 検知 | [`docs/GITOPS.md`](./GITOPS.md) |
| Meta | 実際の広告アカウント接続、Apply / Activate、ad_accounts 同期、レポート取得。実利用では必須 | [`docs/META.md`](./META.md) |
| LLM Provider (Codex / OpenAI) | daily_report / today_report / improvement_pr / custom scheduled task workflow | [`docs/LLM_PROVIDER.md`](./LLM_PROVIDER.md) |
| Image Provider | クリエイティブ画像生成 (任意) | [`docs/LLM_PROVIDER.md`](./LLM_PROVIDER.md) §Image Provider |
| Slack | 通知 + `/adops` slash command (任意、Socket Mode のみ) | [`docs/SLACK.md`](./SLACK.md) |

開発中に外部 API を一切叩かずに動作確認したい場合は、以下の mock フラグを
`.env` または `.env.local` で有効にできます。

```bash
ADDROID_META_OAUTH_MOCK=1     # Meta adapter を MockMetaAdapter に固定
ADDROID_GITHUB_OAUTH_MOCK=1   # GitHub OAuth を mock adapter で完結
ADDROID_LLM_MOCK=1            # LLM Provider を MockLLMProvider に固定
ADDROID_IMAGE_MOCK=1          # Image Provider を MockImageProvider に固定
# ENABLE_MOCK_IMAGE_PROVIDER=1  # 上記の同義語 (どちらでも可)
```

> mock フラグは **本番運用では必ず外してください**。CI / E2E / smoke-test 専用です。

---

## 8. Backup / Restore

AdDroid OSS は **`addroid backup`** / **`addroid restore`** で `pg_dump --format=custom`
ベースの最小バックアップ / 復元動線を提供します。Prisma 管理テーブルと pg-boss
スキーマ (`pgboss`) を 1 ダンプにまとめるため、移植 / DR / 鍵ローテーション前後の
復旧いずれにも 1 コマンドで対応できます。

> **前提**: `pg_dump` / `pg_restore` が PATH 上にあること。macOS なら
> `brew install postgresql@16`、Debian/Ubuntu なら `apt install postgresql-client-16`。
> AdDroid 自身は Node 経由で動作するため PostgreSQL クライアントツールは AdDroid の
> install には含まれません。

### 8.1 通常のバックアップ

```bash
# 既定: ~/.addroid/backups/<db>-<timestamp>.dump (Prisma + pgboss)
addroid backup

# pg-boss スキーマを除外 (workspace 移植 / 進行中ジョブを引き継がない場合)
addroid backup --no-pgboss

# 任意の場所に出力
addroid backup --out /path/to/snapshot.dump
```

### 8.2 復元

復元は **破壊的** (target DB の対象スキーマを `--clean --if-exists` で削除して
置換) です。worker / web が動いていると pg-boss スキーマが衝突するため、
`addroid backup` 自体は up 中でも安全ですが、`addroid restore` の前には
**必ず `addroid stop`** を実行してください。

```bash
# 1. 停止
addroid stop

# 2. (任意) 復元前に念のため現状をバックアップ
addroid backup --out ~/.addroid/backups/pre-restore.dump

# 3. 確認プロンプト付きで復元
addroid restore ~/.addroid/backups/<file>.dump

# 4. 常駐サービスを起動・修復して status で接続確認
addroid start
addroid status
```

CI / 自動化では `--yes` で確認プロンプトをスキップできます。
AdDroid の worker が動いているのを承知の上で強制実行する場合は `--force-while-up` を
指定してください (非推奨。worker が DB を触ると pg-boss スキーマが破損する
可能性があります)。

### 8.3 ダンプの機密性

ダンプには `oauth_tokens.access_token_ciphertext` 等の **暗号化トークン文** が
含まれます。`ENCRYPTION_KEY` を別途保管していないとダンプから GitHub / Meta /
Slack のトークンを復元できません。

| 復元先 | 要件 |
|---|---|
| 同じホスト | `ENCRYPTION_KEY` がそのまま使える前提。鍵が変わっていれば `oauth_tokens` を再 OAuth する必要があります。 |
| 別ホスト | ダンプファイルと `ENCRYPTION_KEY` の両方を移送。OS バックアップに任せず明示転送してください。 |
| 鍵を紛失した場合 | `oauth_tokens` を全削除して再 OAuth。Apply 履歴 / cron ログ / audit_logs は復元できます。 |

### 8.4 Migration とバックアップ

Prisma スキーマ反映 (`db push` / `migrate dev`) を行う前に必ず `addroid backup`
を取ってください。現在のマイグレーションモデルは
[`prisma/README.md`](../prisma/README.md) に集約しています:

- ローカル / 単一 host self-host: `npm run db:push` を継続使用 (`prisma/migrations/` 空)
- 履歴を残したい OSS adopter: `npm run db:migrate` で `prisma/migrations/` を populate
- CI / 本番: 生成済み migration を `prisma migrate deploy` で適用

pg-boss の `pgboss` スキーマは Prisma migration の対象外で、`boss.start()`
が自動管理します。Prisma 側で `pgboss` テーブルを意図せず drop しないよう、
`schema.prisma` には pg-boss テーブルが含まれていないことを変更時にも維持して
ください。

---

## 9. アンインストール / クリーンアップ

```bash
# DB を破棄
dropdb addroid

# AdDroid のホームディレクトリを削除 (テスト用環境)
rm -rf ~/.addroid

# リポジトリ削除
rm -rf addroid
```

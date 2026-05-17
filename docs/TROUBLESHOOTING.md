# AdDroid OSS — Troubleshooting

ローカル環境で AdDroid を立ち上げる際に頻出する失敗モードと、対処手順を集めた
ドキュメントです。`addroid doctor` が hint を返す内容と整合させており、UI の
`/setup` パネルにも同等の情報が表示されます。

> **設計前提**: AdDroid OSS は `127.0.0.1` でのみ listen し、外部統合は
> AdDroid 側からの **outbound** のみで動作します。inbound webhook / 公開 URL /
> 専用ドメイン / SSL 証明書 / トンネリングサービスは要求しません。これは設計上の
> 既定値であり、ここに書かれていない方法でこれを破る変更は受け入れられません。
> 詳細は [`docs/SECURITY.md`](./SECURITY.md) を参照してください。

---

## 0. プラットフォーム前提 (macOS / Linux / WSL2)

AdDroid OSS は **macOS / Linux / WSL2 (Windows Subsystem for Linux 2)** のみ動作
検証しています。Windows native (PowerShell / cmd.exe) は **非対応** です。
理由:

- `secrets.local.yaml` を `0600` パーミッションで保護する POSIX 前提
- `pg_dump` / `pg_restore` の dynamic-link / dlopen 前提
- 常駐サービスが起動する web/worker プロセスの POSIX shell / signal 前提

### 0.1 `addroid doctor` が `[error] platform` を返す

```
[error] platform  Windows native (win32) は非対応です。
        ↳ WSL2 (Windows Subsystem for Linux 2) 内の Ubuntu 等で AdDroid を実行してください。
```

#### 対処 (Windows ユーザー向け)

WSL2 のセットアップは Microsoft 公式手順に従ってください。

```powershell
# 管理者 PowerShell で 1 行 (Windows 10 21H2+ / Windows 11)
wsl --install -d Ubuntu-22.04
```

WSL2 起動後、**WSL2 内 (Ubuntu shell) で**以下を実施します:

```bash
# Node.js 22 (推奨は nvm)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install 22

# PostgreSQL 16
sudo apt update && sudo apt install -y postgresql-16 postgresql-client-16

# Python 3.12+ + uv
sudo apt install -y python3.12 python3.12-venv
curl -LsSf https://astral.sh/uv/install.sh | sh

# AdDroid を WSL2 のホーム配下に clone
cd ~ && git clone <repo-url> addroid && cd addroid
npm install
```

`/mnt/c/...` (Windows ファイルシステム) でリポジトリを開かないこと。
I/O が遅く、改行コードが CRLF に変わって lint / test が破壊されます。

`addroid doctor` を WSL2 内で再実行すると、`platform` チェックは
`[ ok  ] platform Linux (WSL2) supported` を返します
(`/proc/version` に `microsoft` / `wsl` を含むため自動検出されます)。

### 0.2 `addroid doctor` が `[warn] platform` を返す (FreeBSD / Alpine 等)

`darwin` / `linux` / `win32` 以外は動作未検証です。`warn` のまま進めると
`pg_dump` の dynamic-link や Node.js の native module で予期せず落ちることが
あります。可能であれば動作検証済みの Ubuntu 22.04+ / Debian 12+ / Fedora 39+
/ macOS 13+ に移行してください。Alpine (musl) は `@prisma/client` の prebuilt
binary が一致せず、追加の `apk add` 依存が必要なため非推奨です。

### 0.3 「Windows native でも動かしたい」

意図的に対応しません。現在の OSS 公開品質基準では
`addroid doctor` が clean smoke-test 環境で完走することが要件であり、
Windows native は POSIX 前提を満たさず本ドキュメントに列挙した依存関係も
インストール手順が分岐するため、サポート対象外としています。
WSL2 を使用してください。

---

## 1. 環境変数が読み込まれない

### 症状
- `npm run db:push` 実行時に `Error: Environment variable not found: DATABASE_URL`
- `addroid doctor` が `DATABASE_URL` を `error` として報告

### 原因と対処
Prisma CLI (`db:generate` / `db:push` / `db:migrate`) は **`.env.local` を読みません**。
`.env.local` だけに `DATABASE_URL` を書いた状態では、Prisma が値を見つけられず
失敗します。

| 対処 | コマンド |
|---|---|
| (推奨) `.env` に書く | `cp .env.example .env` してから値を埋める |
| シェルで export してから実行 | `export DATABASE_URL=postgresql://...; npm run db:push` |
| 一時的に load | `set -a; source .env.local; set +a; npm run db:push` |

詳細は [`docs/SETUP.md` §3](./SETUP.md) を参照。

---

## 2. PostgreSQL 関連

### 2.1 `addroid doctor` で `prisma-connect: error`

```
DB 接続に失敗: ...
hint: `pg_isready -h localhost -p 5432` で起動を確認し、`npm run db:push` を実行してください。
```

| 確認 | コマンド |
|---|---|
| サーバー起動 | `pg_isready -h localhost -p 5432` |
| DB 存在 | `psql -lqt \| cut -d\| -f1 \| grep -w addroid` |
| ロール存在 | `psql -d postgres -c "\du addroid"` |
| 接続文字列 | `DATABASE_URL=postgresql://addroid:<password>@localhost:5432/addroid` (`<password>` は §2.2 で `addroid` ロールに設定したパスワード) |

### 2.2 `npm run db:push` が `permission denied for schema public` で失敗

PostgreSQL 15 以降では、`public` スキーマへの `CREATE` 権限が role 単位で
必要です。`addroid` role が `public` スキーマのオーナーまたは権限保持者で
ない場合、Prisma `db push` も pg-boss の `CREATE SCHEMA pgboss` も失敗します。

```bash
# 0. ローカル用に強いパスワードを 1 つ用意 (任意のものを使ってよい)
DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")

# addroid role を作成 (CREATEDB 権限が必要)
psql -d postgres -c "CREATE ROLE addroid WITH LOGIN PASSWORD '${DB_PASSWORD}' CREATEDB;"

# DB を addroid 所有で作成
createdb -O addroid addroid

# 既存の DB が別オーナーで作られているなら付け替える
psql -d postgres -c "ALTER DATABASE addroid OWNER TO addroid;"

# public スキーマの権限も addroid に渡す
psql -d addroid -c "ALTER SCHEMA public OWNER TO addroid;"
psql -d addroid -c "GRANT ALL ON SCHEMA public TO addroid;"

# .env / .env.local の DATABASE_URL に埋める (リポジトリには絶対コミットしない)
#   DATABASE_URL=postgresql://addroid:${DB_PASSWORD}@localhost:5432/addroid
```

> `'addroid'` のような既知の弱いパスワードを **そのまま埋め込まないでください**。
> ロール作成時に決めた値は `.env` / `.env.local` (どちらも `.gitignore` 済) のみに
> 保存します。

### 2.3 `addroid doctor` で `postgres-16: error`

PostgreSQL 16 未満を検出した場合は 16 以上にアップグレードしてください。
AdDroid は `gen_random_uuid()` / JSONB の最新挙動 / pg-boss の最新スキーマに
依存しています。

`psql` 自体が PATH に無い環境では `warn` で skip されます。Prisma 経由の
`prisma-connect` で接続バージョンを直接判定するため、運用上は warn のままで
問題ありません。

---

## 3. ENCRYPTION_KEY 関連

### 3.1 `addroid doctor` で `ENCRYPTION_KEY: error`

OAuth トークン暗号化に使う鍵 (`ENCRYPTION_KEY`) が未設定または短すぎます。
受理される encoding は base64 (44 字) / hex (64 字) / 32 byte 以上の raw 文字列です。

```bash
# 32 byte ランダム値 (base64) を生成
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

生成した値を `.env` の `ENCRYPTION_KEY` に書き込みます。
**この値はリポジトリに絶対コミットしないでください**
(`.env*` は `.gitignore` で除外済み)。

### 3.2 `CiphertextFormatError` / 復号できない

`ENCRYPTION_KEY` を回した場合、既存の `oauth_tokens.access_token_ciphertext` は
復号できなくなります。現在の実装では:

1. 旧鍵を一時的に戻して `oauth_tokens` を空にする (DELETE FROM oauth_tokens)
2. 新鍵で `addroid start` を再起動し、OAuth 連携をやり直す

を推奨します。鍵ローテーションの本格対応は後続コントラクトで扱います。

---

## 4. `secrets.local.yaml` のパーミッション

### 症状
```
secrets.local.yaml: warn — ~/.addroid/secrets.local.yaml のパーミッションが緩い (644)。
hint: chmod 600 ~/.addroid/secrets.local.yaml を実行してください。
```

### 対処
```bash
chmod 600 ~/.addroid/secrets.local.yaml
```

`addroid init` は新規作成時に `0600` を強制しますが、後から手で書き換えた
場合に warn が出ます。`secrets.local.yaml` はリポジトリに **絶対**
コミットしないでください (`.gitignore` で除外済み)。

---

## 5. uv / Python 3.12+ / Meta Ads CLI

### 5.1 `uv: error`
[uv 公式インストール手順](https://docs.astral.sh/uv/getting-started/installation/)
の通りに `uv` を導入してください。AdDroid は Python 依存を直接管理せず、
`uv` 経由で Meta Ads CLI を呼び出します。

### 5.2 `python3.12: error`
Meta Ads CLI は Python 3.12+ を要求します。3.11 以下は非対応です。
`python3` が古い場合でも、`uv python find '>=3.12'` で互換 Python が見つかれば
AdDroid は ok として扱います。`addroid init` の自動導入は、現時点の Meta CLI wheel が
対応している安定版として Python 3.13 を使います。

```bash
# uv の例
uv python install 3.13

# pyenv の例
pyenv install 3.13.13
pyenv local 3.13.13

# Homebrew の例
brew install python@3.13
```

### 5.3 `meta-ads-cli: error`
本番では Meta Ads CLI を導入してください。通常は次で初回セットアップの流れに戻せます。

```bash
npm run addroid -- init --install-deps
```

`addroid init` は `uv` があれば次のコマンドを自動実行し、entry point の `meta` を `.env` の
`ADDROID_META_CLI_BIN` に保存します。

```bash
uv tool install meta-ads --python 3.13
```

手動確認する場合は `meta ads --help` を実行してください。

CI / 開発でローカルに導入できない場合は、環境変数で mock 経由扱いに切り替え
られます (現在の実装での暫定挙動。Meta 実行経路の検証時に外します)。

```bash
ADDROID_META_ADS_CLI_MOCK=1 addroid doctor
```

---

## 6. 常駐サービス / `addroid start` 関連

### 6.1 `EADDRINUSE: address already in use 127.0.0.1:3000`

別プロセスが `127.0.0.1:3000` を listen 中です。

```bash
# 既存プロセス確認
lsof -nP -iTCP:3000 -sTCP:LISTEN

# AdDroid 自身を起動済みなら stop で停止
addroid stop

# どうしてもポートを変えたい場合 (任意)
ADDROID_WEB_PORT=3100 addroid start --foreground
```

`ADDROID_WEB_HOSTNAME` を `0.0.0.0` 等に変更してはいけません。outbound-only /
localhost-only 設計の前提が崩れます。

### 6.2 `addroid stop` が「pid file 無し」と返す

`~/.addroid/run/up.json` が存在しないか、すでに失効しています。

```bash
# プロセスを直接探す
ps -ef | grep -E "next dev|apps/worker" | grep -v grep

# 念のため pid file をクリーンアップ
rm -f ~/.addroid/run/up.json
```

`addroid start --foreground` の中断 (kill -9 等) で pid file が残ることがあります。
ファイルを消した上で再度 `addroid start` を実行してください。

### 6.3 `addroid status` が `[stopped]` を表示し続ける

常駐サービス、または `addroid start --foreground` 起動中の親プロセスが終了した可能性があります。
`~/.addroid/run/up.json` を削除し、`addroid start` を再実行してください。

---

## 7. GitHub 連携 (OAuth / ポーリング)

### 7.1 OAuth が完了しない / token が保存されない
`packages/github-adapter` は adapter pattern です。テストおよびローカル動作の
ためには、環境変数 `ADDROID_GITHUB_OAUTH_MOCK=1` を有効にすると mock adapter
経由で OAuth が完結します。本番運用ではこのフラグを **必ず外してください**。

```bash
# 開発・テスト時のみ
ADDROID_GITHUB_OAUTH_MOCK=1 npm run addroid -- up
```

### 7.2 「webhook URL を設定したい」
**意図的に対応しません**。AdDroid OSS は GitHub Webhook を使わず、`merged PR`
検知は `github_poll` cron (ETag-aware ポーリング) で完結します。public IP /
専用ドメイン / SSL 証明書 / トンネリングサービスを要求しないことが OSS としての
セルフホスト性の前提です。詳細は [`docs/SECURITY.md` §1](./SECURITY.md) を参照。

### 7.3 ポーリングが動かない / PR が表示されない
- `oauth_tokens` テーブルにレコードがあるか確認 (`/github` パネル)
- ops repo (`workspaces.ops_repo_*`) が bootstrap 済みか確認
- `cron_runs` テーブルに `github_poll` の最新行があるか確認
- `addroid start` の出力に worker のエラーが出ていないか確認

GitOps の全体像と承認境界は [`docs/GITOPS.md`](./GITOPS.md) を参照してください。

---

## 8. Meta 連携 (Access Token / OAuth / sandbox / mock)

### 8.1 `addroid connect meta` で Ad Account が表示されない
- 入力した Meta Access Token に `ads_read`, `ads_management`, `business_management` 権限があるか確認
- Business Manager 側で、その token を発行したユーザーまたは System User に対象 Ad Account が割り当てられているか確認
- `ENCRYPTION_KEY` と `DATABASE_URL` が `addroid init` 後の値から変わっていないか確認
- 再発行した token で `addroid connect meta` を再実行する

### 8.2 Apply が `Invalid parameter` / 開発モード app の creative エラーで失敗する

症状:

- PR merge 後に `apply_jobs.state=failed` になる
- `execution_logs` または通知に `meta.api_error` が残る
- Meta 側のエラーに「クリエイティブ投稿は開発モードのアプリにより作成されたものです」
  またはそれに近い文言が出る

原因:

Access Token を発行した Meta App が Development / 開発モードのまま、または Live / 公開に
必要な App 基本設定が不足しています。token 登録や Ad Account 一覧取得は通っても、
広告 creative 作成は Meta API 側で拒否されることがあります。

対処:

1. [Meta Apps dashboard](https://developers.facebook.com/apps/) で token 発行元の App を開く
2. **App settings > Basic** で Privacy Policy URL を設定する
3. Meta の画面で求められる場合は、データ削除方法の URL / 説明、連絡先メールなども設定する
4. App Mode を **Live / 公開** に切り替える
5. System User token を使っている場合は、その App を選んで token を再発行する
6. `addroid connect meta` で新しい token を登録し直す
7. 入稿内容を再度 PR 化し、GitOps の承認経路で再実行する

AdDroid の Web UI は localhost-only のままで構いません。ここで必要なのは、Meta App
側のプライバシーポリシーページが外部から開けることと、App が本番利用できる状態に
なっていることです。

### 8.3 上級者向け OAuth で `state mismatch` または callback 失敗
`/api/oauth/meta/begin` で発行した state は CLI / Web で異なるプロセスに渡しません。
CLI の場合は詳細コマンド `addroid auth meta --oauth` を再実行してください。Web UI の場合は `addroid start`
を再起動し、別タブの古い OAuth flow を破棄してから再度 `/accounts` の "Meta を接続"
を押してください。

### 8.4 開発で外部 `graph.facebook.com` を一切叩きたくない
```bash
ADDROID_META_OAUTH_MOCK=1 npm run addroid -- up
```
`MockMetaAdapter` が選択され、すべての Meta 操作が in-memory `MockMetaSandbox` で
deterministic に実行されます。Apply / Activate も mock 経路で完結し、外部通信は
発生しません。

### 8.5 Meta execution mode が `unconfigured` のままになる
- `oauth_tokens` テーブルに provider="meta" のレコードがあるか確認
- `ENCRYPTION_KEY` が変わっていないか確認 (変更後は保存済み token を復号できない)
- `apps/web/lib/meta-runtime.ts` の `selectMetaAdapter` が `StubMetaAdapter` を
  返している場合は `ENCRYPTION_KEY` が未設定、または mock / OAuth / token のいずれの経路も
  利用できない状態
- `addroid account` で登録済み Ad Account と default を確認し、未設定なら
  `addroid account sync --select-default` または `addroid account choose` を実行する

### 8.6 Apply で本番 Meta を誤って書き換えそう
- Apply は新規オブジェクトをすべて **PAUSED** で作成します。Activate を別経路で
  人間が承認するまで予算は消費されません。
- TopBar の Meta execution mode チップが `live` になっているのを確認したうえで
  Apply するのは設計通りの挙動です。本番に影響したくない場合は sandbox app に
  繋ぐか `ADDROID_META_OAUTH_MOCK=1` を使ってください。

詳細は [`docs/META.md`](./META.md) を参照してください。

---

## 9. Slack 連携 (任意 / Socket Mode)

### 9.1 Slack 未設定で動作するか
**動作します**。`/setup#slack` および Dashboard の Slack カードは benign idle 表示
となり、cron / Apply / Activate / レポートは通常通り動きます。Slack 関連 env を
何も設定しなくても問題ありません。

### 9.2 `addroid connect slack` が "socket-connect-failed" で失敗
- Bot Token (`xoxb-*`) と App-Level Token (`xapp-*`、`connections:write` scope) の
  両方が登録されているか確認
- App-Level Token の scope に `connections:write` が含まれているか
- 企業ファイアウォールが `wss://` outbound を許可しているか
- Slack 側で App が enable されているか

### 9.3 「Slack の request URL を設定したい」
**意図的に対応しません**。AdDroid OSS は Socket Mode 専用で、public な request
URL / event URL を要求しません。`templates/slack-app-manifest.yaml` をそのまま
Slack に貼り付ければ Socket Mode の App が作成されます。

### 9.4 `/adops` slash command が timeout する
- `addroid start` の worker が起動しているか確認
- `cron_runs` / `execution_logs` に `slack` 由来のジョブが記録されているか確認
- `pg-boss` で job が ack されてから 3 秒以内に `response_url` で reply される契約
  なので、worker が遅延すると Slack 側で timeout になります

詳細は [`docs/SLACK.md`](./SLACK.md) を参照してください。

---

## 10. LLM / Image Provider 関連

### 10.1 LLM Provider 未設定で AI workflow が動かない
**設計通りの挙動**です。`StubLLMProvider` が fail-closed し、`improvement_pr` は
`skipped` で終了して PR は作成されません。GitOps 状態は破壊されません。

開発・テストで mock を使いたい場合:
```bash
ADDROID_LLM_MOCK=1 npm run addroid -- up
```

### 10.2 Codex app-server に接続できない
- `codex --version` が成功するか確認してください。未インストールの場合は
  `addroid init --install-deps` を実行します。
- `addroid connect ai --provider codex` を再実行し、表示された URL で Codex にログインしてください。
- 既存の app-server を指定している場合、`ADDROID_CODEX_APP_SERVER_URL` は
  `ws://127.0.0.1:<port>` または `ws://localhost:<port>` のみ利用できます。
- Codex token は AdDroid の DB に保存しません。`ENCRYPTION_KEY` を変更しても
  Codex の接続状態には影響しません。

### 10.3 Image Provider 未設定で improvement_pr が画像なしで PR を作る
**設計通りの挙動**です。Image Provider 未設定時は creative 生成を skip し、
improvement_pr はテキストのみで PR を作成します (`/improvements` の outcome は
`succeeded_text_only`)。Apply / Activate / レポート取得は通常通り動きます。

詳細は [`docs/LLM_PROVIDER.md`](./LLM_PROVIDER.md) を参照してください。

---

## 11. 外部接続 (outbound) が失敗する

| 症状 | 想定原因 | 対処 |
|---|---|---|
| `ECONNREFUSED` (GitHub API) | 企業プロキシ / オフライン | `HTTPS_PROXY` を設定。GitHub API への outbound HTTPS が必須 |
| `ETIMEDOUT` | ファイアウォールが outbound を遮断 | ネットワーク管理者に GitHub / Meta API の outbound 許可を確認 |
| `self signed certificate in certificate chain` | プロキシが TLS を MITM | プロキシのルート証明書を `NODE_EXTRA_CA_CERTS` に追加 |

AdDroid 側から **inbound 接続を待ち受けることは一切ありません**。outbound のみで
動作する性質上、outbound HTTPS が許されないネットワークでは利用できません。

---

## 12. Backup / Restore 関連

`addroid backup` / `addroid restore` の挙動と典型的な失敗モードを集めます。
詳細手順は [`docs/SETUP.md` §8](./SETUP.md) を参照してください。

### 12.1 `pg_dump が見つかりません` / `pg_restore が見つかりません`

PostgreSQL クライアントツールが PATH 上にありません。AdDroid OSS は Node 経由で
動作するため、`pg_dump` / `pg_restore` の install は OS パッケージマネージャに任せて
います。

```bash
# macOS
brew install postgresql@16

# Debian/Ubuntu
sudo apt install postgresql-client-16

# 確認
which pg_dump && pg_dump --version
```

### 12.2 `pg_dump: error: aborting because of server version mismatch`

`pg_dump` のバージョンが PostgreSQL サーバーよりも古いと拒否されます。
AdDroid は PostgreSQL 16+ 必須なので、クライアントも 16 以上に揃えてください
(同 major か上位 major を使うのが安全)。

### 12.3 `pg_restore: error: relation "..." already exists`

`--clean --if-exists` で既存テーブルを drop しているはずなのに発生する場合、
AdDroid の常駐サービスが並行して走っていてスキーマを再作成している可能性があります。
`addroid stop` で停止してから再度 `addroid restore` を実行してください。

### 12.4 `addroid restore` が AdDroid 起動中として停止する

設計通りの挙動です。`addroid stop` で常駐サービスを停止してから再実行して
ください。CI 等で起動中に強制実行する必要がある場合のみ `--force-while-up` を
指定してください (pg-boss スキーマが破損するリスクあり)。

### 12.5 復元後に Meta / GitHub / Slack のトークンが復号できない

`ENCRYPTION_KEY` がダンプ取得時と異なります。ダンプファイルには
`oauth_tokens.access_token_ciphertext` の暗号文が入っており、復号には
ダンプ取得時と同じ `ENCRYPTION_KEY` が必要です。

| 鍵が手元にある | `.env` の `ENCRYPTION_KEY` をダンプ取得時の値に戻す |
| 鍵を紛失した | `psql -d addroid -c "DELETE FROM oauth_tokens;"` で全削除し、各 provider の OAuth をやり直す |

### 12.6 `pgboss` スキーマを含めて復元したのに job が消える

`pg-boss` の `archive` table 保持期間 (`retention_sweep` cron) を超えた job は
ダンプ取得時点でも archive 済み / 削除済みの可能性があります。Apply / cron の
**実行履歴** を追跡したい場合は `cron_runs` / `apply_jobs` / `audit_logs`
(Prisma 管理テーブル) を参照してください。これらはダンプに必ず含まれます。

### 12.7 ダンプファイルを git にコミットしてしまった

`.gitignore` で `~/.addroid/` 配下は git の追跡対象外ですが、
`addroid backup --out` で repo 内に出力した場合は手動で除外する必要があります。
コミットしてしまった場合は次の手順で履歴から除去してください:

```bash
# 1. ファイルを git 履歴から除去 (BFG Repo Cleaner 推奨)
bfg --delete-files '*.dump'

# 2. 既存 OAuth トークンは漏洩相当として全削除 + 再 OAuth
psql -d addroid -c "DELETE FROM oauth_tokens;"

# 3. ENCRYPTION_KEY もローテーション
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

ダンプは `oauth_tokens.access_token_ciphertext` を含むため、`ENCRYPTION_KEY` と
合わせて漏洩した場合は credential が漏洩したのと同等と扱ってください。

---

## 13. OSS リリース衛生 (commit 前チェック)

`/setup` ページの "Security & Network Posture" パネルが ok を返さないと、
コミットしてはいけない状態である可能性があります。手元での目視確認:

```bash
# 1. 追跡対象に secrets が混ざっていないか (.env.example だけは tracked で OK)
git ls-files | grep -E '(^|/)\.env(\.[^/]+)?$|secrets\.local\.ya?ml$' \
  | grep -v '^\.env\.example$' \
  && echo "FAIL" || echo "ok"

# 2. 個人パスがコミットされていないか
grep -RIn -E "/Users/[^/]+/|/home/[^/]+/" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
  --exclude-dir=dist . && echo "FAIL" || echo "ok"

# 3. ENCRYPTION_KEY の実値が .env.example に書かれていないか (placeholder のみであるべき)
grep -E '^ENCRYPTION_KEY=' .env.example
```

`.env.example` の `ENCRYPTION_KEY` 値は必ず placeholder
(例: `replace-with-a-32-byte-random-value`) のままにしてください。
リリース前のチェック項目は [`docs/SECURITY.md` §5](./SECURITY.md) のチェック
リストに従ってください。

---

## 14. それでも解決しない場合

- `npm run addroid -- doctor` の **完全な出力** を保存
- `~/.addroid/logs/` 配下の最新ログを確認
- `apps/web` / `apps/worker` のターミナル出力を確認
- 上記を添えて GitHub Issue を立てるか、Security 関連は GitHub Security
  Advisories から非公開報告してください ([`docs/SECURITY.md` §6](./SECURITY.md))。

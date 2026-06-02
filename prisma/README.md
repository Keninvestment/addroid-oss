# Prisma — AdDroid OSS

このディレクトリは AdDroid OSS の Prisma スキーマを管理します。

## ファイル

- `schema.prisma` — AdDroid 12 必須テーブル + 補助テーブルの定義。
- `migrations/` — `prisma migrate dev` で生成されるマイグレーション。初期 OSS リリースでは空 (`db push` を主動線にしています)。

## 12 必須テーブル (contract acceptance)

| テーブル | 役割 | Prisma model |
|---|---|---|
| `workspaces` | ローカルワークスペース (config + ops repo メタ) | `Workspace` |
| `oauth_tokens` | GitHub / Meta などの OAuth トークン (暗号化保存) | `OAuthToken` |
| `ad_accounts` | Meta 広告アカウント (Meta Mirror DB / operation manifests と紐付け) | `AdAccount` |
| `ads_hierarchy` | campaign / adset / ad の正規化ツリー | `AdsHierarchyNode` |
| `performance_snapshots` | 日次メトリクスの冪等スナップショット | `PerformanceSnapshot` |
| `ai_runs` | AI 生成 / 改善提案ジョブの実行記録 (agent / workflow / provider / model / prompt / inputs / outputs / decision / confidence / tokens / costUsd / linkedRef) | `AiRun` |
| `github_pull_requests` | ポーリングで観測した PR と merge 状態 | `GithubPullRequest` |
| `approval_records` | PR ごとの承認・却下・自動承認の記録 | `ApprovalRecord` |
| `cron_runs` | cron 実行履歴 (pg-boss 1 ジョブ = 1 行) | `CronRun` |
| `execution_logs` | cron / apply / ai_run / github_poll の細粒度ログ | `ExecutionLog` |
| `audit_logs` | 監査ログ (actor / action / target / ref) | `AuditLog` |
| `creatives` | クリエイティブ資産 (画像/動画/テキスト) | `Creative` |

## 補助テーブル (初期 OSS リリース向け)

| テーブル | 役割 |
|---|---|
| `github_repos` | ops リポジトリのレジストリ (PR/polling から参照) |
| `github_polling_state` | ETag-aware ポーリングの進捗 |
| `cron_schedules` | pg-boss に登録済みプリセットの UI 表示用ミラー |
| `apply_jobs` | merged PR から enqueue される execute_apply ジョブ記録 |
| `doctor_results` | `addroid doctor` 直近結果の UI 表示キャッシュ |

これらは初期 OSS リリースで UI / worker / CLI が直接読むためのものです。
将来の拡張で `execution_logs` への統合や Workspace への正規化を検討します。

## マイグレーションモデル

初期 OSS リリースでは migration history を作らず `db push` を主動線とし、
`prisma/migrations/` は意図的に空 (`.gitkeep` のみ) にしています。
OSS 公開時点でのモデルは次のとおりです:

| 操作 | 想定環境 | 用途 |
|---|---|---|
| `npm run db:push` | 開発 / 単一ホストの self-host 運用 | スキーマ差分を直接反映。履歴を残さない。初期 OSS リリースの主動線。 |
| `npm run db:migrate` (= `prisma migrate dev`) | 開発 (履歴を残したい場合) | 差分から SQL ファイルを生成して `prisma/migrations/` に追加。 |
| `prisma migrate deploy` | 本番 / CI | 既存の migration ファイルを順に適用するだけ。差分検出は行わない。 |

OSS adopter が `npm run db:migrate` で migration history を始めるのは自由です。
その場合は生成された `prisma/migrations/<timestamp>_*/` ディレクトリをリポジトリに
コミットし、以降は `prisma migrate deploy` で本番反映してください。

> **重要**: スキーマ反映を行う前に必ず `addroid backup` でダンプを取得してください
> (`docs/SETUP.md` §8 "Backup / Restore" 参照)。`db push` / `migrate dev` のいずれも
> 既存テーブルを破壊する可能性があるため、復旧経路を確保してから実行します。

## DB 反映 (3-command setup の補助手順)

ローカル開発では `db push`、本番想定では `migrate dev` を使い分けます。

```bash
# 1. PostgreSQL 16+ が起動していることを確認
pg_isready -h localhost -p 5432

# 2. ローカル用に強いパスワードを 1 つ用意 (任意のものを使ってよい)
DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")

# 3. addroid ロールを先に作成 (DB オーナーになる前提。PASSWORD は上で決めた値)
psql -d postgres -c "CREATE ROLE addroid WITH LOGIN PASSWORD '${DB_PASSWORD}' CREATEDB;" 2>/dev/null || true

# 4. addroid をオーナーとして DB を作成
#    -O addroid を付けないと、現在の OS ユーザーが DB と public スキーマのオーナーになり、
#    addroid ロールが Prisma db push / pg-boss の CREATE SCHEMA を実行できなくなります。
createdb -O addroid addroid 2>/dev/null || true

# 5. PostgreSQL 15+ では public スキーマへの CREATE 権限が暗黙では付与されません。
#    addroid ロールが Prisma で CREATE TABLE できるよう、public をオーナー譲渡します。
psql -d addroid -c "ALTER SCHEMA public OWNER TO addroid;" 2>/dev/null || true
psql -d addroid -c "GRANT ALL ON SCHEMA public TO addroid;" 2>/dev/null || true

# 6. .env / 環境変数に DATABASE_URL を設定 (このシェルセッションだけ反映する例)
#    形式: postgresql://addroid:<password>@localhost:5432/addroid
#    リポジトリには絶対コミットしない (.env / .env.local は .gitignore 済)。
export DATABASE_URL="postgresql://addroid:${DB_PASSWORD}@localhost:5432/addroid"

# 7a. 開発: スキーマを直接反映 (履歴なし)
npm run db:push

# 7b. 本番想定: マイグレーション履歴を残す
npm run db:migrate

# 8. Prisma Client の再生成 (型と runtime)
npm run db:generate
```

`db push` と `migrate dev` のどちらでも pg-boss スキーマ (`pgboss`) は影響を受けません。

## pg-boss との共存

pg-boss は同 PostgreSQL DB に独自スキーマ (`pgboss`) を `boss.start()` 時に自動作成します。
Prisma 側でこれを管理する必要はありません。
ただし、`addroid` ロールが DB の `CREATE` 権限 (= 新規スキーマ作成権限) を持つ必要があります。
上記手順の `createdb -O addroid addroid` で `addroid` を DB オーナーにしておけば、
`CREATE SCHEMA pgboss` は自動的に成功します。
既存 DB が別ユーザー所有の場合は次で付け替えてください:

```bash
psql -d postgres -c "ALTER DATABASE addroid OWNER TO addroid;"
```

### スキーマ境界のまとめ

| スキーマ | 管理者 | 作成タイミング | Prisma migrate の対象 | バックアップ既定 |
|---|---|---|---|---|
| `public` | Prisma | `db:push` / `migrate dev` | yes | yes |
| `pgboss` | pg-boss | `addroid up` 起動時の `boss.start()` | no | yes (除外したい場合は `addroid backup --no-pgboss`) |

`pgboss` スキーマには現在 enqueue 中のジョブ (= cron / apply / slack) と
直近の job archive が入ります。これを除外してダンプすると、復元先で worker が
`boss.start()` を再実行してスキーマが再生成されますが、未処理ジョブは消えます。
業務継続性 (進行中の Apply / GitHub poll) を保ったまま移植したい場合は
`pgboss` を含めて復元してください。

## Backup / Restore

`addroid backup` / `addroid restore` で `pg_dump --format=custom` ベースの
冪等なダンプ / 復元ができます。詳細は [`docs/SETUP.md` §8](../docs/SETUP.md) を参照してください。

```bash
addroid backup                        # ~/.addroid/backups/<db>-<timestamp>.dump (Prisma + pgboss)
addroid backup --no-pgboss            # Prisma 管理テーブルのみ
addroid backup --out /path/to/x.dump  # 出力先指定

addroid down                          # 必ず先に stop
addroid restore ~/.addroid/backups/<file>.dump
addroid restore <file> --yes          # CI / 自動化
addroid restore <file> --no-pgboss    # workspace 移植 (pg-boss は復元先で再生成)
```

ダンプファイルには `oauth_tokens.access_token_ciphertext` 等の暗号文が含まれます。
**`ENCRYPTION_KEY` と同じ機密度で保管してください**。鍵を紛失するとダンプから
GitHub / Meta / Slack のトークンを復元できません。

## 命名規則

- モデル名は `PascalCase`、テーブル名は `snake_case` (`@@map` で指定)。
- 列名はキャメルケース (初期 OSS リリースでは `@map("snake_case")` は付けず Prisma 既定のまま)。
  → 列名のスネーク化は 12 テーブルが安定したあと、別タスクでまとめて適用します。
- Meta 側 ID 等の外部識別子は `externalId` に統一し、`metaAccountId` 等の専用列は
  ad_accounts のように identity が必要なテーブルに限定して保持します。

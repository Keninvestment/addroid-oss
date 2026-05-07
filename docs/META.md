# AdDroid OSS — Meta Setup

AdDroid で実際の Meta 広告アカウントを利用するには **Meta Access Token が必須**です。
Meta Access Token が登録されていない状態では、Apply (PR merge → 新規オブジェクト作成)、
Activate (PAUSED → ACTIVE)、ad_accounts 同期、レポート取得は実行できません。

未連携の状態でも Web UI / cron / Doctor は通常通り動作し、`/setup#meta` および
`/accounts` は idle 表示になります。これは初回起動と開発検証を妨げないための挙動であり、
実利用で Meta Access Token を省略できるという意味ではありません。

---

## 1. 連携モードの選択

Meta adapter は env、OAuth client config、暗号化境界から決定されます (`packages/meta-adapter/src/factory.ts`)。

| 条件 | 採択される adapter | 用途 |
|---|---|---|
| `ADDROID_META_OAUTH_MOCK=1` | `MockMetaAdapter` | E2E / smoke-test / 開発 (外部通信なし) |
| OAuth client config 完備 + `ENCRYPTION_KEY` 設定済 | `RealMetaAdapter` | 本番 / sandbox app 接続 |
| `ENCRYPTION_KEY` 設定済 | `StoredTokenMetaAdapter` | 標準の Access Token 入力接続 |
| 上記以外 | `StubMetaAdapter` | 未連携状態 (UI で idle 表示) |

`MockMetaAdapter` は `MockMetaSandbox` を内蔵しており、campaign / adset / ad / creative /
insights をすべて in-memory で deterministic に再現します。`graph.facebook.com` には
一切到達しません。

---

## 2. 本番 / sandbox 接続 (`StoredTokenMetaAdapter`)

### 2.1 Access Token の準備

1. [Meta for Developers](https://developers.facebook.com/) で Business App を作成
2. Marketing API を有効化
3. `ads_read`, `ads_management`, `business_management` を含む Access Token を発行
5. System User token を使う場合は、Business Settings で System User に対象 Ad Account を割り当てる

非エンジニア向けの標準手順では OAuth callback は使いません。ローカル利用のために
HTTPS callback URL、public domain、ngrok 等を用意する必要はありません。

> **Sandbox app**: Meta の Sandbox mode で App を作成すると、本番予算には影響しない
> 検証用 app type が得られます。AdDroid は app type をトークン取得時に判定し、
> Web UI で `Meta: act_xxx · sandbox` と表示します。

### 2.2 Token の保存

`addroid connect meta` で貼り付けた Access Token は、`ENCRYPTION_KEY` で暗号化して
`oauth_tokens(provider="meta")` に保存します。Meta Ads CLI 実行時は公式 CLI 互換の
`ACCESS_TOKEN` / `AD_ACCOUNT_ID` だけを短命な子プロセス環境に注入します。

### 2.3 Token 入力フロー

1. `addroid connect meta` を実行
2. Meta Access Token を貼り付ける
3. AdDroid が `/me` と `/me/adaccounts` を呼び、取得できる Ad Account を表示
4. CLI に表示された Ad Account 候補から既定アカウントを選択
5. `oauth_tokens` (provider="meta") に AES-256-GCM で暗号化保存
6. Web UI を使う場合は `/accounts` で接続状態・Ad Account 同期・既定変更を確認可能

OAuth callback を使う上級者向け経路は詳細 CLI の `addroid auth meta --oauth` です。HTTPS callback
URL を Meta App に登録できる環境でのみ使ってください。

---

## 3. 開発 / E2E モード (`MockMetaAdapter`)

外部 `graph.facebook.com` を一切叩かずに Apply / Activate / レポートを動かしたい場合:

```bash
ADDROID_META_OAUTH_MOCK=1 npm run addroid -- up
```

- すべての Meta 操作が in-memory `MockMetaSandbox` で deterministic に実行される
- `graph.facebook.com` への通信は発生しない
- TopBar の Meta execution mode チップが `Meta: <act_id> · mock` と表示される
- Activate ConfirmDialog の確認ボタンラベルが `ACTIVE にする (mock)` になる
- `audit_logs` に痕跡が残るため、後から mock 経路だったことを確認できる

> **本番では絶対に有効にしないこと**。`/setup#release` の OSS Release Readiness
> カードと `addroid doctor` は mock フラグが残置していると warn を返します。

---

## 4. Apply / Activate split

AdDroid は Meta への書き込みを 2 段階に分けます (詳細は [`docs/ARCHITECTURE.md` §4](./ARCHITECTURE.md))。

### 4.1 Apply

- ops repo の PR が merge されると `github_poll` が検知して `execute_apply` を queue
- `apps/worker/src/lib/apply-meta-executor.ts` が Meta adapter 越しに **PAUSED** で
  campaign / adset / ad / creative を作成
- Apply 自身は予算を消費しない
- 結果は `apply_jobs` (state: queued / running / succeeded / failed / simulated) と
  `audit_logs` (action: `apply.enqueued` / `apply.blocked_unapproved`) に記録

### 4.2 Activate

- Web UI `/campaigns` / Slack `/adops activate <act_id>` / 詳細 CLI の activate 経路
  のいずれかで明示的に呼び出された場合のみ実行
- PAUSED → ACTIVE に遷移し、実予算消費はこの段階で初めて発生
- `approval_records` (targetType="ads_hierarchy") に承認の出所 (`web_merge` /
  `cli_merge` / `slack_activate`) を記録
- Activate ConfirmDialog body 先頭に `Meta execution mode: <mode>` を mono で表示

### 4.3 execution_mode override

workspace 全体の `mode` (`report_only` / `proposal` / `auto_apply`) に加え、
`ad_accounts.modeOverride` で per-account の上書きが可能です。`auto_apply` 以外では
Activate に手動承認が必須です (TopBar Mode チップで常時可視化)。

---

## 5. Web UI の確認ポイント

| ルート | 確認内容 |
|---|---|
| `/setup#meta` | Meta execution mode (live / sandbox / mock / unconfigured) と接続済み app type |
| `/accounts` | OAuth 状態 / Business 一覧 / Ad Account 一覧 / per-account mode override |
| `/plans` | Apply 前の plan dry-run 結果 |
| `/apply/[id]` | Apply ジョブ単位の詳細とリトライ |
| `/campaigns` | Meta 階層と Activate 操作 |

TopBar の `Meta: <act_id> · <mode>` チップは全ルートで常時表示され、`mock` /
`sandbox` 中は info / accent dot で安全網が働いていることを示します。

---

## 6. トラブルシュート

[`docs/TROUBLESHOOTING.md` §8](./TROUBLESHOOTING.md) を参照してください。

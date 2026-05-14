# AdDroid OSS — Slack Setup (任意 / Socket Mode)

Slack 連携は **完全に任意**です。トークンを設定しなくても AdDroid OSS は通常通り稼働し、
Dashboard / `/setup#slack` は benign idle 表示になります。連携時は Slack に通知を送り、
`/adops` slash command で簡単な操作を Slack 側から起動できます。

> **Socket Mode 専用**: AdDroid は public な request URL / event URL / webhook を
> 一切要求しません。`templates/slack-app-manifest.yaml` をそのまま Slack 管理画面に
> 貼り付ければ Socket Mode の App が作成されます。

---

## 1. Slack App の作成

1. https://api.slack.com/apps の "Create New App" → "From an app manifest" を選ぶ
2. 連携したい workspace を選び、`templates/slack-app-manifest.yaml` の内容を YAML
   入力欄に貼り付ける
3. App の Settings で **Socket Mode** を有効化 (manifest で `socket_mode_enabled: true`
   が指定済み)
4. **App-Level Token** を発行: scope `connections:write` のみで OK (`xapp-*` プレフィックス)
5. **Bot Token** を発行 (`xoxb-*` プレフィックス): scope は manifest で
   `chat:write`, `commands`, `channels:read`, `users:read` が指定済み
6. 通知を投稿したい channel に Bot を invite

`templates/slack-app-manifest.yaml` は以下を保証します:

- Socket Mode のみ (`socket_mode_enabled: true`)
- `/adops` slash command は `url:` を持たない (Socket Mode 経由でルーティング)
- Interactivity も `request_url` を持たない (Socket Mode 経由)
- bot scope は最小集合のみ
- `org_deploy_enabled: false` / `token_rotation_enabled: false`

---

## 2. AdDroid 側のトークン登録

```bash
# 推奨: addroid CLI 経由 (Socket Mode 接続テスト → 成功時のみトークン暗号化保存)
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
  npm run addroid -- auth slack
```

CLI は以下を順に実行します:

1. Bot Token の `auth.test` で workspace と bot user を検証
2. App-Level Token で WebSocket (`apps.connections.open`) を 1 回張って Socket Mode が
   有効か確認
3. 両方成功した場合のみ `oauth_tokens` (provider="slack") に AES-256-GCM で暗号化保存
4. 失敗時はトークンを永続化せず、原因を hint として表示

`SLACK_NOTIFICATION_CHANNEL_ID` を併せて設定すると、通知の宛先 channel を固定できます
(未設定時は workspace ごとの fallback channel を使用)。

---

## 3. Slack 連携を解除する

`addroid connect slack --revoke` か Web UI `/setup#slack` の「Disconnect Slack」で
トークンを削除できます。`oauth_tokens` から該当行を削除し、Socket Mode 接続を
graceful close します。Slack 側の App は手動で削除してください。

---

## 4. `/adops` subcommand

`/adops <subcommand>` の 6 つのサブコマンドを Socket Mode 経由で受け取り、3 秒以内
ack → pg-boss queue → `response_url` で reply する契約です。

| subcommand | 役割 |
|---|---|
| `report` | 直近の daily_report 結果を返す |
| `budget` | 直近の budget_guard 結果を返す |
| `improve` | 改善提案 PR (improvement_pr workflow) を起動 |
| `status` | AdDroid のヘルス (config / DB / worker / cron) を返す |
| `accounts` | 接続済み ad_accounts を一覧 |
| `activate <act_id>` | 指定 ad_account の PAUSED → ACTIVE 遷移 (Activate) |

Activate のみ別の承認境界 (`approval_records` の `decisionSource="slack_activate"`) を
持ち、Slack ユーザー ID が `audit_logs.actor` に `slack:<user_id>` として記録されます。

> Slack 経由の Activate は Activate のみ可能です。**PR merge** / **Apply** は Slack から
> 直接起動できません (GitOps の境界を Slack で越えないため)。merge は GitHub UI / Web
> UI のいずれかから明示的に行ってください。

---

## 5. 通知の種類

`packages/queue` / `apps/worker` から outbound に送信される通知の主な種類:

- PR opened (improvement_pr / 手動 PR)
- Daily report / Budget guard 結果
- Apply 完了 / 失敗 / 承認待ち
- Activate 完了 / 失敗
- Rate limit warning (Meta API throttling)
- Auth revoked (token expire / Meta sandbox mode 強制切替)

通知は `notification_dispatch` テーブルに記録されます。Slack 接続状態は `/setup` と
`/api/slack/connect` の接続フローから確認します。

---

## 6. Slack 未設定時の挙動

- `oauth_tokens` に provider="slack" の行がない場合は SlackNotificationDispatcher が
  no-op で skip
- Dashboard と `/setup` は benign idle 表示
- `/api/slack/connect` は未接続状態を安全に扱い、既存トークンの秘匿値は返さない
- AI workflow / Apply / Activate / レポート取得は通常通り動作

---

## 7. トラブルシュート

[`docs/TROUBLESHOOTING.md` §9](./TROUBLESHOOTING.md) を参照してください。

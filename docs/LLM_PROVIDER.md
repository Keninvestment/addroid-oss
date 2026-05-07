# AdDroid OSS — LLM / Image Provider Setup

AdDroid は AI workflow (`daily_report`, `budget_guard`, `improvement_pr`, `adhoc`) を
LLM Provider 経由で実行します。LLM Provider 未設定の状態でも core 動作は続き、
AI workflow のみ `StubLLMProvider` で fail-closed します。

Image Provider はクリエイティブ画像生成のための独立した任意統合です。未設定時は
`improvement_pr` がテキストのみで PR を作成します。

---

## 1. LLM Provider の選択

`packages/llm-provider/src/factory.ts` の判定:

| 条件 | 採択される provider | 用途 |
|---|---|---|
| `ADDROID_LLM_MOCK=1` | `MockLLMProvider` | E2E / smoke-test / 開発 (deterministic fixture) |
| `oauth_tokens` に OpenAI / Anthropic API key credential がある | `ApiKeyLLMProvider` | 初回セットアップ推奨 |
| Codex / OpenAI OAuth client config 完備 + `ENCRYPTION_KEY` 設定済 | `CodexLLMProvider` | 本番 |
| 上記以外 | `StubLLMProvider` (fail-closed) | 未連携状態 |

`StubLLMProvider` は `ai_runs` に `failed: provider not configured` を残して終了し、
`improvement_pr` は `skipped` 扱いで PR を作成しません。GitOps 状態は破壊されません。

---

## 2. API key 認証 (`ApiKeyLLMProvider`)

初心者向けの推奨経路です。`addroid init` の対話セットアップで
`openai-api-key` または `anthropic-api-key` を選ぶか、後から CLI で登録します。

```bash
npm run addroid -- auth llm --provider openai
# または
npm run addroid -- auth llm --provider anthropic
```

`--api-key` を省略すると、TTY では非表示入力になります。CI などでは
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` を一時的な環境変数として渡せます。

```bash
npm run addroid -- auth llm --provider openai --model gpt-4.1
npm run addroid -- auth llm --provider anthropic --model claude-3-5-sonnet-latest
```

保存先は `oauth_tokens` です。

- `provider`: `openai` または `anthropic`
- `access_token_ciphertext`: API key を `ENCRYPTION_KEY` で AES-256-GCM 暗号化した値
- `metadata.authKind`: `api_key`
- `metadata.defaultModel`: 既定 model
- `metadata.apiBaseUrl`: endpoint URL。機微値ではありません

平文 API key は DB / `ai_runs` / audit log / error message に保存しません。

切断:

```bash
npm run addroid -- auth llm --provider openai --disconnect
```

`ADDROID_LLM_PROVIDER=openai|anthropic|codex` を設定すると provider 優先度を明示できます。
未指定時は mock → 保存済み API key → Codex OAuth → stub の順に選択します。

---

## 3. Codex / OpenAI OAuth (`CodexLLMProvider`)

### 3.1 必須環境変数

Codex OAuth の OAuth client は OpenAI Codex 互換の内蔵 public client を既定で使います。
`ADDROID_CODEX_CLIENT_ID` の入力は不要です。

通常は `addroid init` で `Codex OAuth` を選ぶだけで、次の runtime 設定が `.env` に
補完されます (`ENCRYPTION_KEY` と `DATABASE_URL` も別途必要):

```bash
ADDROID_CODEX_CHAT_COMPLETIONS_URL=https://api.openai.com/v1/chat/completions
ADDROID_CODEX_DEFAULT_MODEL=gpt-4.1
```

### 3.2 任意の上書き

```bash
ADDROID_CODEX_CLIENT_ID=...
ADDROID_CODEX_AUTHORIZATION_URL=https://auth.openai.com/oauth/authorize
ADDROID_CODEX_TOKEN_URL=https://auth.openai.com/oauth/token
ADDROID_CODEX_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/api/oauth/codex/callback
ADDROID_CODEX_SCOPES=openid,profile,email,offline_access
ADDROID_CODEX_CLIENT_SECRET=    # 設定すると Confidential Client、未設定なら PKCE
```

`offline_access` を含めないと refresh token が発行されず、access token expire 後に
再 OAuth が必要になります。長期運用では含めることを推奨します。

### 3.3 OAuth フロー

対話型 `addroid init` で `Codex OAuth` を選ぶと、その場で
`addroid auth llm --provider codex` が起動します。
内蔵 OAuth client と `.env` の既定 runtime 設定を使うため、client id の入力はありません。

1. CLI がブラウザを開き、Codex / OpenAI OAuth の許可画面に遷移
2. 許可後、`http://localhost:1455/auth/callback` を CLI が localhost で受信
3. AdDroid が authorization code を token に交換 (PKCE 既定)
4. `oauth_tokens` (provider="codex") に AES-256-GCM で暗号化保存

localhost callback を自動検出できない場合は、ブラウザに表示された callback URL 全体を
CLI に貼り付けて Enter すると同じ処理で完了できます。

後から接続し直す場合:

```bash
npm run addroid -- init --interactive --reauth-llm

# Codex OAuth だけを直接再認証したい場合
npm run addroid -- auth llm --provider codex
```

Web UI から接続する場合は、`addroid up` 後に `/ai` の "Codex を接続" を押しても同じ
`oauth_tokens` に保存されます。

---

## 4. 開発 / E2E モード (`MockLLMProvider`)

```bash
ADDROID_LLM_MOCK=1 npm run addroid -- up
```

- 外部 OpenAI / Codex API には一切到達しない
- すべての AI workflow が deterministic な fixture を返す
- `ai_runs` に `provider: mock` が記録される

> **本番では絶対に有効にしないこと**。

---

## 5. AI workflow の種類

| workflow | 役割 | 実行経路 |
|---|---|---|
| `daily_report` | 日次レポート生成 | cron preset (`0 9 * * *`) |
| `budget_guard` | 予算超過監視 + 警告 | cron preset (`*/15 * * * *`) |
| `improvement_pr` | 改善提案 PR (週次) | cron preset (`0 10 * * 1`) + Slack `/adops improve` |
| `adhoc` | UI / CLI からの単発実行 | `/improvements` の "Adhoc 実行" |

各 workflow は `ai_runs` に prompts / outputs / model / cost を記録し、`/ai` で
履歴を確認できます。出力はサニタイズ済みで、token-shape の値は `[REDACTED]` に置換
されます。

---

## 6. Image Provider (任意)

クリエイティブ画像を生成する場合のみ必要です。未設定時は `improvement_pr` が
テキストのみで PR を作成します。

### 6.1 mock を使う

```bash
ADDROID_IMAGE_MOCK=1 npm run addroid -- up
# または
ENABLE_MOCK_IMAGE_PROVIDER=1 npm run addroid -- up
```

`MockImageProvider` が deterministic な placeholder PNG を返し、外部通信は発生しません。

### 6.2 OpenAI API key で GPT Image 2 を使う

`addroid auth llm --provider openai` で登録済みの OpenAI API key がある場合、
同じ暗号化済み credential を使って `gpt-image-2` の画像生成を実行できます。
追加で画像専用 API key を `.env` に保存する必要はありません。

```bash
npm run addroid -- auth llm --provider openai
ADDROID_IMAGE_PROVIDER=openai npm run addroid -- up
```

未指定時も、保存済み OpenAI API key があり Codex image provider が優先されていなければ
OpenAI Image Provider が選択されます。

主な設定:

```bash
ADDROID_IMAGE_PROVIDER=openai
ADDROID_OPENAI_IMAGE_MODEL=gpt-image-2
ADDROID_OPENAI_IMAGE_QUALITY=medium  # low / medium / high / auto
```

Anthropic API key は LLM 用には使えますが、GPT Image 2 の画像生成には使えません。
Anthropic を LLM に選ぶ場合、画像生成には OpenAI API key または Codex app-server 経路が
別途必要です。

### 6.3 Codex OAuth / app-server で画像生成する

Codex OAuth を使う場合は、OpenAI Images API を直接叩かず、ローカルの
`codex app-server` 経由で画像生成します。AdDroid は `ws://127.0.0.1:<port>` の
app-server を起動し、JSON-RPC で生成依頼を送り、保存された PNG を bytes として読み込みます。

```bash
ADDROID_IMAGE_PROVIDER=codex npm run addroid -- up
```

通常は `ADDROID_CODEX_APP_SERVER_URL` を設定せず、AdDroid に localhost の空き port で
app-server を起動させます。既存の app-server を使う場合も、URL は localhost / loopback
だけ許可されます。

```bash
ADDROID_CODEX_APP_SERVER_URL=ws://127.0.0.1:4455
ADDROID_CODEX_IMAGE_PARALLEL=5
```

Codex app-server 経路は PNG 生成のみを扱います。JPEG が必要な場合は OpenAI API key
経路を使ってください。

### 6.4 生成画像の扱い

- LocalDiskStorage (`~/.addroid/storage/`) に保存
- `creatives` テーブルから `storage://creatives/<account_key>/<creative_id>/<asset_id>.<ext>`
  形式の stable ref で参照
- Web UI は `/api/creatives/[id]/asset/[assetId]` 経由でプロキシ配信し、外部 URL を
  ブラウザに露出させない
- Creative QA (dimensions / format / quality / forbidden_expression / brand_tone) を
  通過したものだけ improvement_pr に添付される
- **Apply / Activate を経由しない限り Meta には反映されない**: 生成画像は ops repo の
  PR にコミットされ、merge → Apply (PAUSED) → Activate の通常経路を通る

---

## 7. Web UI の確認ポイント

| ルート | 確認内容 |
|---|---|
| `/ai` | LLM Provider の接続状態 / default model と AI workflow の実行履歴を 1 画面に集約 |
| `/improvements` | improvement_pr の outcome (`pr_opened` / `succeeded_text_only` / `skipped` / `failed`) |
| `/creatives` | 生成済みクリエイティブと QA 結果 |

---

## 8. トラブルシュート

[`docs/TROUBLESHOOTING.md` §10](./TROUBLESHOOTING.md) を参照してください。

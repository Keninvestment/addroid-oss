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
| Codex / OpenAI OAuth client config 完備 + `ENCRYPTION_KEY` 設定済 | `CodexLLMProvider` | 本番 |
| 上記以外 | `StubLLMProvider` (fail-closed) | 未連携状態 |

`StubLLMProvider` は `ai_runs` に `failed: provider not configured` を残して終了し、
`improvement_pr` は `skipped` 扱いで PR を作成しません。GitOps 状態は破壊されません。

---

## 2. Codex / OpenAI OAuth (`CodexLLMProvider`)

### 2.1 必須環境変数

`.env.example` に定義済みの 5 つを `.env` または `.env.local` に設定します
(`ENCRYPTION_KEY` も別途必要):

```bash
ADDROID_CODEX_CLIENT_ID=...
ADDROID_CODEX_AUTHORIZATION_URL=https://auth.openai.com/oauth/authorize
ADDROID_CODEX_TOKEN_URL=https://auth.openai.com/oauth/token
ADDROID_CODEX_CHAT_COMPLETIONS_URL=https://api.openai.com/v1/chat/completions
ADDROID_CODEX_DEFAULT_MODEL=gpt-4.1
```

### 2.2 任意の上書き

```bash
ADDROID_CODEX_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/api/oauth/codex/callback
ADDROID_CODEX_SCOPES=openai,offline_access
ADDROID_CODEX_CLIENT_SECRET=    # 設定すると Confidential Client、未設定なら PKCE
```

`offline_access` を含めないと refresh token が発行されず、access token expire 後に
再 OAuth が必要になります。長期運用では含めることを推奨します。

### 2.3 OAuth フロー

1. `addroid up` で web を起動
2. Web UI `/ai` の "Codex を接続" を押す
3. ブラウザが OAuth ページに遷移し、許可後 `/api/oauth/codex/callback` で
   AdDroid が token 交換 (PKCE 既定)
4. `oauth_tokens` (provider="codex") に AES-256-GCM で暗号化保存
5. `/ai` で provider status が `connected` になり、`default_model` が表示

---

## 3. 開発 / E2E モード (`MockLLMProvider`)

```bash
ADDROID_LLM_MOCK=1 npm run addroid -- up
```

- 外部 OpenAI / Codex API には一切到達しない
- すべての AI workflow が deterministic な fixture を返す
- `ai_runs` に `provider: mock` が記録される

> **本番では絶対に有効にしないこと**。

---

## 4. AI workflow の種類

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

## 5. Image Provider (任意)

クリエイティブ画像を生成する場合のみ必要です。未設定時は `improvement_pr` が
テキストのみで PR を作成します。

### 5.1 mock を使う

```bash
ADDROID_IMAGE_MOCK=1 npm run addroid -- up
# または
ENABLE_MOCK_IMAGE_PROVIDER=1 npm run addroid -- up
```

`MockImageProvider` が deterministic な placeholder PNG を返し、外部通信は発生しません。

### 5.2 本番 Image Provider

`packages/llm-provider/src/image-factory.ts` の adapter pattern に従って provider を
追加します (現状 OSS template には Real adapter は含まれていません — 必要な provider を
fork 側で実装してください)。

### 5.3 生成画像の扱い

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

## 6. Web UI の確認ポイント

| ルート | 確認内容 |
|---|---|
| `/ai` | LLM Provider の接続状態 / default model と AI workflow の実行履歴を 1 画面に集約 |
| `/improvements` | improvement_pr の outcome (`pr_opened` / `succeeded_text_only` / `skipped` / `failed`) |
| `/creatives` | 生成済みクリエイティブと QA 結果 |

---

## 7. トラブルシュート

[`docs/TROUBLESHOOTING.md` §10](./TROUBLESHOOTING.md) を参照してください。

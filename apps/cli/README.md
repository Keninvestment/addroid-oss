# `@addroid/cli`

AdDroid OSS のローカル CLI。`addroid` コマンドとして、初期化・診断・起動・YAML 検証・cron 操作などを 1 つのバイナリから提供します。

AdDroid 全体は **localhost-only / outbound-only** で動作する GitOps ベースの Meta 広告運用 OSS です。CLI から public な inbound ポートを開くことはありません。

---

## インストール

グローバルにインストールして `addroid status` を実行できます:

```bash
npm install -g @addroid/cli
addroid --help
addroid init
addroid status
```

`npm install` 後の `postinstall` は次に実行すべき `addroid init` を表示するだけで、
OS パッケージやユーザー設定を勝手に変更しません。uv / GitHub CLI /
PostgreSQL の不足分は `addroid init` で実行コマンドを表示し、確認後にセットアップします。

実運用 (Web UI / Worker) を起動する場合はリポジトリをクローンしてセットアップしてください。詳細は OSS リポジトリの `docs/SETUP.md` を参照してください。

---

## 主なコマンド

| コマンド | 用途 |
|---|---|
| `addroid init` | 対話型初期セットアップ (`.env` / DB / `~/.addroid` / GitHub / LLM Provider)。初期設定済みなら状態表示のみ |
| `addroid chat` | init 済み LLM credential と `AGENTS.md` を使う対話型 agent chat |
| `addroid start` | Web UI (127.0.0.1:3000) と Worker (pg-boss) を併走起動 |
| `addroid stop` | 起動中の Web UI / Worker を停止 |
| `addroid open` | Web UI を開く / URL を表示 |
| `addroid status` | 接続・起動状態を確認 |
| `addroid connect` | Meta / GitHub / AI / Slack を接続・再接続 |
| `addroid account` | Meta Ad Account の取得・登録・デフォルト選択 |
| `addroid report` | 日次レポートや予算チェックを今すぐ実行 |
| `addroid submit` | 入稿前チェックと dry-run 変更予定の確認 |
| `addroid schedule` | 自動実行の確認・変更 |
| `addroid backup` | データベースをバックアップ |
| `addroid version` | CLI バージョン |

詳細は `addroid --help` を参照してください。

---

## ライセンス

Apache-2.0 — リポジトリ root の `LICENSE` を参照してください。

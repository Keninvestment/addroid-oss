# `@addroid/cli`

AdDroid OSS のローカル CLI。`addroid` コマンドとして、初期化・診断・起動・YAML 検証・cron 操作などを 1 つのバイナリから提供します。

AdDroid 全体は **localhost-only / outbound-only** で動作する GitOps ベースの Meta 広告運用 OSS です。CLI から public な inbound ポートを開くことはありません。

---

## インストール

グローバルにインストールして smoke-test 用途で `addroid doctor` を実行できます:

```bash
npm install -g @addroid/cli
addroid --help
addroid init
addroid doctor
```

`npm install` 後の `postinstall` は次に実行すべき `addroid init` を表示するだけで、
OS パッケージやユーザー設定を勝手に変更しません。uv / Python / Meta Ads CLI /
PostgreSQL の不足分は `addroid init` で実行コマンドを表示し、確認後にセットアップします。

実運用 (Web UI / Worker) を起動する場合はリポジトリをクローンしてセットアップしてください。詳細は OSS リポジトリの `docs/SETUP.md` を参照してください。

---

## 主なコマンド

| コマンド | 用途 |
|---|---|
| `addroid init` | 対話型初期セットアップ (`.env` / DB / `~/.addroid` / Meta Ads CLI) と冪等 scaffold |
| `addroid doctor` | 実行環境 (Node / uv / Python / Meta Ads CLI / PostgreSQL / DATABASE_URL / config / secrets / ENCRYPTION_KEY) を診断 |
| `addroid up` | Web UI (127.0.0.1:3000) と Worker (pg-boss) を併走起動 (リポジトリ内でのみ意味があります) |
| `addroid down` | `addroid up` で起動したプロセスを停止 |
| `addroid status` | 直近の状態スナップショットを表示 |
| `addroid validate` | ops repo の Ads YAML / cron.yaml / project.yaml を Zod で検証 |
| `addroid plan` | ops repo から apply 案を simulate (dry-run 必須) |
| `addroid activate` | PAUSED 状態の Meta オブジェクトを ACTIVE に遷移 |
| `addroid cron` | cron プリセットの list / enable / disable / set / run / logs |
| `addroid auth` | Provider 別のトークン登録 (`meta` OAuth / `slack` Socket Mode) |
| `addroid accounts` | Meta Ad Account の取得・登録・デフォルト選択 |
| `addroid version` | CLI バージョン |

詳細は `addroid --help` を参照してください。

---

## ライセンス

Apache-2.0 — リポジトリ root の `LICENSE` を参照してください。

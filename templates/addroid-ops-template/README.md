# {{workspaceDisplayName}} — AdDroid ops repository

このリポジトリは [AdDroid OSS](https://github.com/) によって管理される、
Meta 広告運用の単一ソースです。

- `operations/<account>/*.json`: PR 承認後に worker が Graph API 経由で反映する操作マニフェスト
- `workflows/cron.yaml`: AdDroid に登録する cron プリセット
- `workflows/automation-rules.yaml`: 自然言語リクエストから生成する自動運用ルールの下書き
- `.addroid/project.yaml`: ワークスペースのメタ
- `.github/workflows/addroid-validate.yml`: PR 時の構造検証 (placeholder)

直接 main にコミットせず、Pull Request 経由で変更してください。
AdDroid は merged PR を ETag-aware にポーリングし、apply ジョブを enqueue します。

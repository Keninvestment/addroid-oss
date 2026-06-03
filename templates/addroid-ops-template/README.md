# {{workspaceDisplayName}} — AdDroid ops repository

このリポジトリは [AdDroid OSS](https://github.com/) によって管理される、
Meta 広告運用の単一ソースです。

- `operations/<account>/*.json`: PR 承認後に worker が Graph API 経由で反映する操作マニフェスト
- `workflows/cron.yaml`: AdDroid に登録する cron プリセット
- `workflows/automation-rules.yaml`: 自然言語リクエストから生成する自動運用ルールの下書き
- `.addroid/project.yaml`: ワークスペースのメタ
- `.github/workflows/addroid-validate.yml`: PR 時の軽量な構造検証

直接 main にコミットせず、Pull Request 経由で変更してください。
AdDroid は merged PR を ETag-aware にポーリングし、apply ジョブを enqueue します。

GitHub Actions の `addroid-validate` は、PR 作成時に YAML / JSON の構造ミスを早めに見つける
ための補助チェックです。AdDroid 本体は merge 後の Apply 前にも server-side で再検証するため、
Actions が無効でも安全境界は維持されます。ただし、非エンジニアの運用では PR 画面で早く
エラーに気づけるため、有効のまま使うことを推奨します。

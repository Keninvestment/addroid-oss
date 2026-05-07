# Contributing to AdDroid OSS

AdDroid OSS は localhost-only / outbound-only / GitOps 駆動の Meta 広告運用ツールです。
本ドキュメントは contribution の流れ、開発環境の整備、PR 規約、レビュー観点をまとめます。

> **セキュリティ脆弱性**は GitHub の Security Advisories で **非公開**報告してください
> (`docs/SECURITY.md` §9)。パブリックな issue には書かないでください。

---

## 1. 開発環境

[`docs/SETUP.md`](docs/SETUP.md) の手順に従って、ローカルで `addroid up` が動く状態を
作ってください。

```bash
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# ↑ で得た値を .env の ENCRYPTION_KEY に設定
npm run db:push
npm run addroid -- init
npm run addroid -- doctor
npm run addroid -- up
```

外部 API を一切叩かずに開発したい場合:

```bash
ADDROID_GITHUB_OAUTH_MOCK=1 \
ADDROID_META_OAUTH_MOCK=1 \
ADDROID_LLM_MOCK=1 \
ADDROID_IMAGE_MOCK=1 \
ADDROID_META_ADS_CLI_MOCK=1 \
  npm run addroid -- up
```

---

## 2. テストと typecheck

PR を出す前に最低限以下が pass することを確認してください。

```bash
npm run db:generate    # Prisma client (typecheck の前段で必須)
npm run typecheck      # 全 workspace の tsc --noEmit
npm run lint           # 全 workspace の lint
npm run test           # 全 workspace の単体 / 統合テスト (DB 必要なものは個別 skip)
npm run build          # 全 workspace の build
npm run package:smoke  # @addroid/cli の pack + clean install + addroid doctor smoke
npm run publish:dry-run  # npm publish dry-run
```

CI (`.github/workflows/ci.yml`) もこのフルセットを実行します。CI で落ちる場合は
ローカルで上記をすべて pass させてから push してください。

DB を立てて E2E を流したい場合は `npm run test:browser` が `apps/web/scripts/browser-test.mjs`
を起動します (PostgreSQL + Chrome / Chromium / Edge のいずれかが必要)。Chrome / Prisma の
どちらかが欠けている環境では ブラウザー検証 は **既定で fail** します。
typecheck-only の CI stage 等で意図的に browser flow を走らせない場合のみ
`ADDROID_BROWSER_TEST_OPT_OUT=<reason>` を環境変数で設定して skip 扱いに降格できます
(降格はログに loud で記録されます)。

---

## 3. コーディング規約

このリポジトリでは以下の実装ガードレールに従います。

- **No Dead UI**: インタラクティブ要素は同一 PR 内でハンドラ + API 接続まで完了させる
- **No Placeholder Data**: ページコンポーネントはハードコードされたダミーデータを表示しない
- **Unified Feedback**: データ変更操作は Toast 等で成功 / 失敗を必ず表示
- **API-First for Every View**: ページ作成時に必ず API / SSR クエリも同時実装
- **Secure Media Proxy**: 外部メディアは AdDroid 自前のプロキシエンドポイントから配信
- **Error Handling at Boundaries**: `fetch()` 後は必ず `res.ok` チェック、外部 API は try-catch
- **OSS hygiene**: 個人 path / 個人 GitHub login / hardcoded `act_id` / 平文 token を
  ソースに残さない

UI の構成方針は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。
デザイントークンは [`design/tokens.css`](design/tokens.css) から取り込み、
hex を直接書きません。

---

## 4. Commit / PR 規約

### 4.1 Commit message

- 1 コミットに 1 トピック。複数の関心事を 1 commit に混ぜない
- subject は短く (50 文字以内目安)、命令形で書く
- secret や個人情報を含むファイルは絶対に commit しない
- 自動生成物 (`dist/`, `node_modules/`, `.next/`) を commit しない

### 4.2 Pull Request

- target は `main` ブランチ
- description には:
  - 変更の動機 (Why)
  - 影響範囲 (どの workspace / package / ルート)
  - テスト計画 (`npm run test` で pass、E2E シナリオ等)
  - スクリーンショット (UI 変更時)
- 個人 path / 個人 GitHub login / hardcoded `act_id` などが scrubbed されているか
  確認 (`docs/SECURITY.md` §8 のチェックリスト)
- breaking change がある場合は description で明示
- 公開前の rollout / フィーチャーフラグが必要な場合は description に書く

### 4.3 Review 観点

レビュアーは以下を確認します:

- Implementation Guardrails 遵守
- 任意統合 (Slack / Meta / LLM / Image) が未設定でも 200 OK が返るか
- secret / 個人情報 / 個人 path が commit に含まれていないか
- DB schema 変更がある場合は migration / `db push` の影響評価
- 外部 API への新規依存がないか (`docs/SECURITY.md` §1 の outbound-only)
- inbound webhook / 公開 URL を要求していないか
- 適切なテストが追加されているか

---

## 5. 新しい統合の追加

| 種別 | 追加場所 | 備考 |
|---|---|---|
| LLM Provider | `packages/llm-provider/src/factory.ts` | `CodexAppServerLLMProvider` を雛形に adapter pattern |
| Image Provider | `packages/llm-provider/src/image-factory.ts` | mock / stub 経路を保持して fail-closed |
| Storage backend | `packages/config/src/storage.ts` | `LocalDiskStorage` を雛形に adapter pattern |
| Ad platform | 新規 `packages/<platform>-adapter/` | `meta-adapter` を雛形に Real / Mock / Stub の 3 形態を実装 |

新規依存ライブラリの追加は `package.json` の変更を伴うため、PR description で明示し、
レビュアーがライセンス・サイズ・メンテナンス状況を確認できるようにしてください。

---

## 6. Release 手順

実 npm publish は **人間の明示承認**を経て手動で行います。AdDroid OSS のコントラクトは
CI から `npm publish` を実行することを禁止しています (CI は `--dry-run` のみ)。

- リリース手順 (バージョニング、CHANGELOG 確定、`npm publish` 実発行、git tag、
  GitHub Release、ロールバック): [`docs/RELEASE.md`](docs/RELEASE.md)
- リリース前のセキュリティ衛生チェックリスト: [`docs/SECURITY.md` §8](docs/SECURITY.md)
- リリースごとの変更点: [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog 1.1.0 / SemVer 2.0.0)

---

## 7. 質問 / フィードバック

- バグ報告 / 機能要望: GitHub Issues
- セキュリティ脆弱性: GitHub Security Advisories (非公開)
- 実装の議論: GitHub Discussions または PR コメント

ご協力ありがとうございます。

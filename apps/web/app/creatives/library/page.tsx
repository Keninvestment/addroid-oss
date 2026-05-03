// AdDroid OSS — /creatives/library ページ (this implementation browser regression fix).
//
// 目的:
//   the browser test harness の `creative-library` シナリオが要求する
//   `/creatives/library` を 200 OK で描画する。設計上、生成クリエイティブの
//   ライブラリは `/creatives` と同一の責務 (creatives テーブルの一覧 + 各行の
//   prompt / model / provider / storage metadata + 欠落 asset の placeholder)。
//
// 実装:
//   既存の CreativesPage (apps/web/app/creatives/page.tsx) を再利用する。
//   独自にデータ取得 / フィルタ / metadata 解決ロジックを再実装すると Image
//   Provider 抽象 / LocalDisk / Creative QA への接続を二重に書くことになり、
//   guardrail #2 (No Placeholder Data) と #4 (API-First for Every View) の
//   観点でも単一実装が望ましい。
//
// ルート優先順位:
//   `/creatives/[id]` は dynamic segment だが、Next.js App Router は静的
//   セグメント `library` を優先するため、ここから `id="library"` で誤って
//   creative 詳細に解決される回路はない。

import CreativesPage from "../page";

export const dynamic = "force-dynamic";

export default CreativesPage;

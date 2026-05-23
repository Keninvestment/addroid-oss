#!/usr/bin/env node
// AdDroid OSS — `@addroid/cli` の npm 配布用バンドラ。
//
// 生成物:
//   apps/cli/dist/index.cjs   ... `bin/addroid.cjs` から `process.execPath` で直接実行する CommonJS バンドル。
//
// 方針:
//   - `@addroid/*` ワークスペースは npm 公開していないため、すべて inline する。
//   - 実 npm 依存 (`@prisma/client`, `pg-boss`, `yaml`, `zod`) は `external` に残し、
//     install 時に npm が解決する。`apps/cli/package.json` の `dependencies` と
//     ここの `external` は一致させること。
//   - 本スクリプトは `npm run build --workspace apps/cli` (= prepack) から呼ばれる。
//     CI / publish 経路でしか触らないため、`tsx` は要求しない (素の Node で実行)。

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "src", "index.ts");
// ESM 出力 (.mjs)。`paths.ts` / `slack-manifest.ts` が `import.meta.url` で自分自身の
// 位置を解決するため、CJS 出力にすると import.meta が empty になり実行時に壊れる。
// Node 22 は .mjs を直接実行できるので bin から `node dist/index.mjs` で起動する。
const outFile = path.resolve(here, "dist", "index.mjs");

// 外部のままにするモジュール:
//   - `pg-boss`, `sharp`, `yaml`, `zod` は package.json に `dependencies` として宣言済み。
//     install 時に npm が解決する。これらは ESM/CJS の named export 互換が良い。
//     `sharp` は CJS/native 依存の dynamic require を持つため、ESM バンドルには inline しない。
//   - `next` は `addroid up` が `await import("next")` で動的解決する。グローバル
//     インストール時には next はインストールされないため、`addroid up` 不可で OK。
//     `addroid doctor` 等の他コマンドには影響しない。
//   - `node:*` 標準モジュールは esbuild の `platform: "node"` で自動的に external 扱い。
//
// `@prisma/client` は external 化せず、`alias` で `prisma-shim.mjs` に差し替える
// (詳細はそのファイル参照)。実 CJS は shim 内の `createRequire` で遅延ロードする。
const EXTERNAL_RUNTIME_DEPS = ["pg-boss", "sharp", "yaml", "zod", "next"];

await fs.mkdir(path.dirname(outFile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL_RUNTIME_DEPS,
  alias: {
    // `@prisma/client` を遅延ファサード (createRequire ベース) に差し替える。
    // バンドルの top-level で `import { PrismaClient } from "@prisma/client"` が
    // 走って prisma generate 未実施環境で SyntaxError になるのを防ぐ。
    "@prisma/client": path.resolve(here, "src", "lib", "prisma-shim.mjs"),
  },
  legalComments: "none",
  minify: false,
  sourcemap: false,
  // `prepack` 経由で呼ばれたとき、esbuild が stdout に書く進捗ログが
  // `npm pack --json` の JSON 出力と混ざる。`silent` にして本スクリプトから
  // stderr に 1 行だけ報告する。
  logLevel: "silent",
  metafile: false,
});

for (const warn of result.warnings ?? []) {
  process.stderr.write(`[build] warn: ${warn.text}\n`);
}
if (result.errors.length > 0) {
  for (const e of result.errors) {
    process.stderr.write(`[build] error: ${e.text}\n`);
  }
  process.exit(1);
}

const stats = await fs.stat(outFile);
// stderr に書く: `npm pack --json` 経由で prepack から走るとき、stdout を汚さないため。
process.stderr.write(
  `[build] wrote ${path.relative(process.cwd(), outFile)} (${(stats.size / 1024).toFixed(
    1
  )} KB)\n`
);

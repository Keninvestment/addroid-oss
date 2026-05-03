#!/usr/bin/env node
// AdDroid CLI launcher.
//
// 同じ launcher を 2 つの実行形態に流用する:
//   1) npm install 経由 (production):
//        `apps/cli/dist/index.cjs` (bundle.mjs が事前ビルド済み) を `process.execPath`
//        で直接実行する。tsx 等の dev 依存を必要としない。
//   2) リポジトリ内 dev (`npm run addroid -- <cmd>`):
//        dist が無いため tsx で `src/index.ts` を直接実行する。
//
// このどちらの場合でも `addroid <cmd>` は同じ src/index.ts のディスパッチ表に
// 着地する (production では bundle 化されているだけ)。

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const here = __dirname;
const root = path.resolve(here, "..");
const bundlePath = path.resolve(root, "dist", "index.mjs");

function exitWith(status) {
  process.exit(typeof status === "number" ? status : 1);
}

if (fs.existsSync(bundlePath)) {
  // Production: 事前ビルド済みバンドルを Node でそのまま実行。
  const result = spawnSync(
    process.execPath,
    [bundlePath, ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env }
  );
  exitWith(result.status);
}

// Dev: tsx で TypeScript を直接実行。
const entry = path.resolve(root, "src", "index.ts");
let tsxBin;
try {
  tsxBin = require.resolve("tsx/cli", { paths: [root] });
} catch {
  console.error(
    "[addroid] dist/index.mjs が無く、tsx も解決できません。\n" +
      "  - リポジトリで作業中の場合: `npm install` をリポジトリルートで実行してください。\n" +
      "  - npm からインストールした場合: `npm install -g @addroid/cli` を再実行するか、\n" +
      "    `npm install --include=dev` で再構築してください (本来は dist が同梱されています)。"
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [tsxBin, entry, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env }
);
exitWith(result.status);

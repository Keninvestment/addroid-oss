// AdDroid OSS — CLI path helpers (monorepo root resolution).
//
// `addroid up` は `apps/web` と `apps/worker` を子プロセスとして起動するため、
// 「リポジトリルート (= workspaces を持つ package.json の場所)」を解決する必要がある。
// 個人パスのハードコードを避けるため、本ファイル自身の位置から相対的に解決する。

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * AdDroid モノレポのルート (apps/web, apps/worker, packages/* を含む) を返す。
 * `import.meta.url` から上方探索し、`workspaces` を含む package.json を見つけたらそこを root とする。
 */
export function resolveRepoRoot(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === "object")) {
          cached = dir;
          return dir;
        }
      } catch {
        /* malformed; keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "AdDroid のリポジトリルートを特定できませんでした (workspaces 付き package.json が見つかりません)。"
  );
}

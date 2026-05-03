// AdDroid OSS — minimal `.env` / `.env.local` loader.
//
// 目的:
//   `addroid` CLI が起動時に `.env` と `.env.local` を自動で読み込めるようにする。
//   Prisma CLI は `.env` を自動で読むが `.env.local` は読まない。Next.js は両方を
//   読むが、リポジトリ root ではなく `apps/web` ディレクトリ基準で探す。CLI が
//   起動時にリポジトリ root の env ファイルを `process.env` に反映しておくことで、
//   - `addroid up` から spawn される web/worker
//   - 同一プロセス内で programmatic に起動する Next.js
//   - `addroid doctor` の DB 接続検査
//   いずれも同じ値を見られる。
//
// 制約:
//   - 新しい dependency を増やさない (dotenv 等を入れない)。手書きパーサで KEY=value、
//     クォート文字列、`#` コメントだけを扱う。マルチライン値や ${VAR} 展開は意図的に
//     未対応。
//   - 既存の `process.env` は決して上書きしない。優先順位は
//       process.env  >  .env.local  >  .env
//     これは Next.js の慣例と同じ。
//   - ファイルが存在しない場合は無音で skip (この loader はあくまで開発時の利便)。

import fs from "node:fs";
import path from "node:path";

const ENV_FILE_ORDER = [".env.local", ".env"] as const;

export interface LoadEnvFilesResult {
  loaded: string[];
  applied: string[];
}

/**
 * Read `.env.local` and `.env` from `repoRoot` (in that priority order) and
 * write missing keys into `target` (defaults to `process.env`).
 * Already-set values in `target` are never overwritten — exporting a variable
 * in the user's shell still wins.
 */
export function loadEnvFilesFromRepoRoot(
  repoRoot: string,
  target: NodeJS.ProcessEnv = process.env
): LoadEnvFilesResult {
  const loaded: string[] = [];
  const appliedSet = new Set<string>();
  for (const name of ENV_FILE_ORDER) {
    const file = path.join(repoRoot, name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    loaded.push(file);
    const parsed = parseEnvFile(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (target[key] === undefined) {
        target[key] = value;
        appliedSet.add(key);
      }
    }
  }
  return { loaded, applied: Array.from(appliedSet) };
}

/**
 * Pure parser for the small subset of `.env` syntax we support.
 * Exported so tests can pin the supported grammar.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (!quoted) {
      // strip trailing inline `# comment` (only when preceded by whitespace,
      // so URLs containing `#` fragments are not truncated mid-value).
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    } else {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

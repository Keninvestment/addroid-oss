// AdDroid OSS — ops repository template loader.
//
// `templates/addroid-ops-template/` 配下の実テンプレートファイルを読み、
// プレースホルダを差し込んで `OpsTemplateFile[]` を返す純粋関数。
//
// テンプレートは GitOps の起点になるため、コードに埋め込むよりも実ファイルとして
// リポジトリに置くほうが OSS ユーザーにとって inspect / 編集しやすい。コード側は
// loader に徹する。
//
// 含まれるファイル:
//   - operations/.gitkeep
//   - workflows/cron.yaml
//   - .addroid/project.yaml
//   - .github/workflows/addroid-validate.yml
//   - README.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface OpsTemplateInput {
  workspaceSlug: string;
  workspaceDisplayName: string;
  initialAccountKey: string;
  initialAccountDisplayName: string;
}

export interface OpsTemplateFile {
  path: string;
  content: string;
}

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates/addroid-ops-template"
);

export const OPS_TEMPLATE_DIR = TEMPLATE_DIR;

export function buildOpsTemplate(input: OpsTemplateInput): OpsTemplateFile[] {
  const replacements: Record<string, string> = {
    workspaceSlug: input.workspaceSlug,
    workspaceDisplayName: input.workspaceDisplayName,
    accountKey: input.initialAccountKey,
    accountDisplayName: input.initialAccountDisplayName,
  };
  const files: OpsTemplateFile[] = [];
  for (const relPath of listTemplateFiles(TEMPLATE_DIR)) {
    const absPath = path.join(TEMPLATE_DIR, relPath);
    const raw = fs.readFileSync(absPath, "utf8");
    files.push({
      path: substitutePath(relPath, input.initialAccountKey),
      content: substituteContent(raw, replacements),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function listTemplateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out;
}

function substituteContent(
  source: string,
  values: Record<string, string>
): string {
  return source.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g,
    (_match, key: string) => {
      const v = values[key];
      if (v === undefined) {
        throw new Error(`Unknown ops template placeholder: {{${key}}}`);
      }
      return v;
    }
  );
}

function substitutePath(relPath: string, accountKey: string): string {
  return relPath
    .split("/")
    .map((segment) => segment.replaceAll("__account_key__", accountKey))
    .join("/");
}

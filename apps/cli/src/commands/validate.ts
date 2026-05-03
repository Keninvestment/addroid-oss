// `addroid validate` — ops repo (cwd または --root) の YAML を Zod スキーマで検証する。
//
// このコマンドは AdDroid 本体だけでなく、ops repo 側 GitHub Actions
// (`.github/workflows/addroid-validate.yml`) からも `npx addroid-cli validate` として
// 呼ばれる。ファイル群:
//   - .addroid/project.yaml
//   - workflows/cron.yaml
//   - ads/accounts/<account_key>/brand.yaml
//
// 失敗したら exit code 1、警告のみなら 0、エラー無しなら 0。
//
// 使い方:
//   addroid validate                 # cwd を ops repo として走査
//   addroid validate --root ./ops    # 任意ディレクトリ
//   addroid validate --json          # 機械可読出力 (CI ログ用)

import path from "node:path";
import {
  loadAndValidateOpsRepo,
  loadPreviousOpsRepoState,
  type OpsRepoValidationResult,
  type ValidationFinding,
} from "@addroid/yaml-schemas";

interface ValidateOptions {
  root: string;
  base: string | null;
  json: boolean;
}

export async function runValidate(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (opts === null) return 2;
  const previous = opts.base ? loadPreviousOpsRepoState(opts.base) : undefined;
  const result = loadAndValidateOpsRepo(opts.root, undefined, { previous });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(toJson(opts.root, result), null, 2)}\n`);
  } else {
    printHuman(opts.root, result);
  }
  return result.errors.length > 0 ? 1 : 0;
}

function parseArgs(args: string[]): ValidateOptions | null {
  let root = process.cwd();
  let base: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--root" || a === "-r") {
      const next = args[i + 1];
      if (!next) {
        process.stderr.write("[addroid validate] --root に値がありません\n");
        return null;
      }
      root = path.resolve(next);
      i += 1;
    } else if (a.startsWith("--root=")) {
      root = path.resolve(a.slice("--root=".length));
    } else if (a === "--base") {
      const next = args[i + 1];
      if (!next) {
        process.stderr.write("[addroid validate] --base に値がありません\n");
        return null;
      }
      base = path.resolve(next);
      i += 1;
    } else if (a.startsWith("--base=")) {
      base = path.resolve(a.slice("--base=".length));
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      return null;
    } else {
      process.stderr.write(`[addroid validate] 未知のオプション: ${a}\n`);
      printHelp();
      return null;
    }
  }
  return { root, base, json };
}

function printHelp() {
  process.stdout.write(
    [
      "addroid validate — Ads YAML / cron.yaml / project.yaml を Zod で検証",
      "",
      "Usage:",
      "  addroid validate [--root <dir>] [--base <dir>] [--json]",
      "",
      "Options:",
      "  --root, -r <dir>   検証対象の ops repo ルート (default: cwd)",
      "  --base <dir>       前回 / base 状態の ops repo ルート。指定すると既存キャンペーン",
      "                     との差分から budget 変更や initialState の安全性を比較する",
      "  --json             機械可読 JSON で結果を出力",
      "  --help, -h         このヘルプ",
      "",
    ].join("\n")
  );
}

function printHuman(root: string, r: OpsRepoValidationResult): void {
  const lines: string[] = [];
  lines.push("[addroid validate]");
  lines.push("");
  lines.push(`  root        : ${root}`);
  lines.push(`  project     : ${r.loaded.project ? "ok" : "missing/invalid"}`);
  lines.push(`  cron        : ${r.loaded.cron ? "ok" : "missing/invalid"}`);
  lines.push(`  brand files : ${r.loaded.brands.length}`);
  lines.push("");
  if (r.errors.length === 0 && r.warnings.length === 0) {
    lines.push("  result      : [ ok  ] no issues");
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return;
  }
  if (r.errors.length > 0) {
    lines.push(`  errors      : ${r.errors.length}`);
    for (const f of r.errors) lines.push(`    [error] ${formatFinding(f)}`);
  }
  if (r.warnings.length > 0) {
    lines.push(`  warnings    : ${r.warnings.length}`);
    for (const f of r.warnings) lines.push(`    [warn ] ${formatFinding(f)}`);
  }
  lines.push("");
  lines.push(
    `  result      : ${r.errors.length > 0 ? "[error]" : "[warn ]"} ${
      r.errors.length > 0 ? "failed" : "passed with warnings"
    }`
  );
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function formatFinding(f: ValidationFinding): string {
  return f.pointer ? `${f.file} :: ${f.pointer} — ${f.message}` : `${f.file} — ${f.message}`;
}

function toJson(root: string, r: OpsRepoValidationResult) {
  return {
    root,
    ok: r.ok,
    counts: {
      errors: r.errors.length,
      warnings: r.warnings.length,
      brandFiles: r.loaded.brands.length,
    },
    errors: r.errors,
    warnings: r.warnings,
  };
}

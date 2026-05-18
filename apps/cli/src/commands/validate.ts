// `addroid validate` — ops repo の operation manifest を検証する。

import path from "node:path";
import {
  runPlanForRoot,
  type PlanRunOutput,
  type ValidationFinding,
} from "../../../worker/src/lib/plan-runtime.js";

interface ValidateOptions {
  root: string;
  base: string | null;
  json: boolean;
}

export async function runValidate(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (opts === null) return 2;
  const result = runPlanForRoot({
    rootDir: opts.root,
    baseDir: opts.base,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(toJson(opts.root, result), null, 2)}\n`);
  } else {
    printHuman(opts.root, result);
  }
  return result.validationErrors.length > 0 ? 1 : 0;
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
      "addroid validate — operations/*.json を検証",
      "",
      "Usage:",
      "  addroid validate [--root <dir>] [--base <dir>] [--json]",
      "",
      "Options:",
      "  --root, -r <dir>   検証対象の ops repo ルート (default: cwd)",
      "  --base <dir>       互換オプション。operation manifest 経路では参照しません",
      "  --json             機械可読 JSON で結果を出力",
      "  --help, -h         このヘルプ",
      "",
    ].join("\n")
  );
}

function printHuman(root: string, result: PlanRunOutput): void {
  const lines: string[] = [];
  lines.push("[addroid validate]");
  lines.push("");
  lines.push(`  root            : ${root}`);
  lines.push(`  operation files : ${result.perAccount.reduce((sum, p) => sum + p.actions.length, 0)}`);
  lines.push("");
  if (result.validationErrors.length === 0 && result.validationWarnings.length === 0) {
    lines.push("  result          : [ ok  ] no issues");
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return;
  }
  appendFindings(lines, "errors", "error", result.validationErrors);
  appendFindings(lines, "warnings", "warn ", result.validationWarnings);
  lines.push("");
  lines.push(`  result          : ${result.validationErrors.length > 0 ? "[error] failed" : "[warn ] passed with warnings"}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function appendFindings(
  lines: string[],
  title: string,
  label: string,
  findings: ValidationFinding[]
): void {
  if (findings.length === 0) return;
  lines.push(`  ${title.padEnd(15)}: ${findings.length}`);
  for (const f of findings) lines.push(`    [${label}] ${formatFinding(f)}`);
}

function formatFinding(f: ValidationFinding): string {
  return f.pointer ? `${f.file} :: ${f.pointer} - ${f.message}` : `${f.file} - ${f.message}`;
}

function toJson(root: string, result: PlanRunOutput) {
  return {
    root,
    ok: result.validationErrors.length === 0,
    counts: {
      errors: result.validationErrors.length,
      warnings: result.validationWarnings.length,
      operations: result.perAccount.reduce((sum, p) => sum + p.actions.length, 0),
    },
    errors: result.validationErrors,
    warnings: result.validationWarnings,
  };
}

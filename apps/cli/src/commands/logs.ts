// `addroid logs [web|worker|all] [--lines N]` — `addroid up` が書き出したログを末尾から表示する。

import fs from "node:fs/promises";
import { resolveAddroidPaths } from "@addroid/config";

const DEFAULT_LINES = 200;

export async function runLogs(args: string[]): Promise<number> {
  const paths = resolveAddroidPaths();
  const { target, lines } = parseArgs(args);
  if (target === "__help__") {
    printUsage();
    return 0;
  }

  const sources: Array<{ label: string; file: string }> = [];
  if (target === "all" || target === "up") {
    sources.push({ label: "up (shared mode)", file: paths.upLogFile });
  }
  if (target === "all" || target === "web") {
    sources.push({ label: "web", file: paths.webLogFile });
  }
  if (target === "all" || target === "worker") {
    sources.push({ label: "worker", file: paths.workerLogFile });
  }

  let printed = 0;
  for (const src of sources) {
    const tail = await readTail(src.file, lines);
    process.stdout.write(`==> ${src.label}: ${src.file} (last ${lines} lines) <==\n`);
    if (tail === null) {
      process.stdout.write("  (ログファイル未生成 — まだ `addroid up` が走っていない可能性)\n");
    } else if (tail.length === 0) {
      process.stdout.write("  (空)\n");
    } else {
      process.stdout.write(tail);
      if (!tail.endsWith("\n")) process.stdout.write("\n");
    }
    process.stdout.write("\n");
    printed += 1;
  }
  return printed > 0 ? 0 : 1;
}

interface ParsedArgs {
  target: "web" | "worker" | "up" | "all" | "__help__";
  lines: number;
}

function parseArgs(args: string[]): ParsedArgs {
  let target: ParsedArgs["target"] = "all";
  let lines = DEFAULT_LINES;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      target = "__help__";
      continue;
    }
    if (a === "--lines" || a === "-n") {
      const v = args[i + 1];
      i += 1;
      const n = Number.parseInt(v ?? "", 10);
      if (Number.isFinite(n) && n > 0) lines = n;
      continue;
    }
    if (a === "web" || a === "worker" || a === "up" || a === "all") {
      target = a;
      continue;
    }
  }
  return { target, lines };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: addroid logs [up|web|worker|all] [--lines N]",
      "",
      "  up        shared モード (`addroid up` 既定) の up.log のみ表示",
      "  web       apps/web のログのみ表示 (`--separate-worker` モードで生成)",
      "  worker    apps/worker のログのみ表示 (`--separate-worker` モードで生成)",
      "  all       3 つすべて表示 (default)",
      "  --lines N 末尾 N 行を表示 (default 200)",
      "",
    ].join("\n")
  );
}

async function readTail(file: string, lines: number): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const split = raw.split("\n");
  // 末尾要素が空文字なら除外 (ファイルが \n で終わっている場合)
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  const slice = split.slice(-lines);
  return slice.join("\n");
}

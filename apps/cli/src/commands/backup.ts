// `addroid backup` / `addroid restore` — DB ダンプ / 復元の最小導線。
//
// this implementation:
//   Prisma migration と pg-boss スキーマを扱うため、AdDroid のテーブルと
//   `pgboss` スキーマの両方を 1 ダンプにまとめて pg_dump --format=custom で
//   保存する。復元は pg_restore --clean --if-exists で冪等に行う。
//
// 設計:
//   - DATABASE_URL を `parseDatabaseUrl` で解析し、host / port / user / password /
//     database を取得する。OS shell に値を露出しないため password は環境変数
//     `PGPASSWORD` 経由で pg_dump / pg_restore に渡す (常套手段)。
//   - 出力先は既定で `~/.addroid/backups/<slug>-<timestamp>.dump`。`--out PATH` で
//     上書き可能。stdin / stdout を介さずファイルパスを pg_dump の `-f` に渡す。
//   - 既定では Prisma 管理テーブル + pg-boss `pgboss` スキーマの両方を含める。
//     `--no-pgboss` を付けると `pgboss` を除外し、復元先 DB の pg-boss 状態を
//     温存できる (workspace を別ホストへ移植する用途など)。
//   - Restore は破壊的なので `--yes` がない限り stdin 確認を要求する。さらに
//     `addroid up` 起動中 (pid file から判定) は worker と DB スキーマが衝突する
//     ため、明示停止を促して exit する (`--force-while-up` で上書き可能)。

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  ensureAddroidPaths,
  homeAnchorPath,
  parseDatabaseUrl,
  resolveAddroidPaths,
  type AddroidPaths,
} from "@addroid/config";
import { isProcessAlive, readUpState } from "../lib/processes.js";

interface BackupOptions {
  out?: string;
  includePgBoss: boolean;
  help: boolean;
}

interface RestoreOptions {
  file?: string;
  yes: boolean;
  includePgBoss: boolean;
  forceWhileUp: boolean;
  help: boolean;
}

interface ParsedDb {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  url: string;
}

/**
 * Test 用: pg_dump / pg_restore / readline を fake に差し替えるためのフック。
 * 本番経路 (= 注入なし) では実バイナリを spawn する。
 */
export interface BackupRuntimeOverrides {
  /** spawn(cmd, args, opts) を差し替える。stdout / stderr / exit code をテスト側で制御するため。 */
  spawn?: (
    cmd: string,
    args: string[],
    opts: SpawnOptions
  ) => Promise<{ status: number | null }>;
  /** 確認プロンプト (`yes/no`) を差し替える。CI / テストでは "yes" を返す。 */
  confirm?: (question: string) => Promise<boolean>;
  /** `pg_dump` / `pg_restore` の存在確認を差し替える (テストで PATH を汚さない)。 */
  hasBinary?: (cmd: string) => boolean;
}

const DEFAULT_OVERRIDES: Required<BackupRuntimeOverrides> = {
  spawn: defaultSpawn,
  confirm: defaultConfirm,
  hasBinary: defaultHasBinary,
};

export async function runBackupCommand(
  args: string[],
  overrides: BackupRuntimeOverrides = {}
): Promise<number> {
  const o: Required<BackupRuntimeOverrides> = { ...DEFAULT_OVERRIDES, ...overrides };
  const opts = parseBackupArgs(args);
  if ("error" in opts) {
    process.stderr.write(opts.error);
    if (opts.printHelp) printBackupHelp();
    return opts.code;
  }
  if (opts.help) {
    printBackupHelp();
    return 0;
  }

  if (!o.hasBinary("pg_dump")) {
    process.stderr.write(
      [
        "[addroid backup] pg_dump が見つかりません。",
        "  PostgreSQL クライアントツール (postgresql-client / postgresql@16 等) を導入してください。",
        "  例: brew install postgresql@16 / apt install postgresql-client-16",
        "",
      ].join("\n")
    );
    return 1;
  }

  const db = resolveDatabase();
  if ("error" in db) {
    process.stderr.write(db.error);
    return db.code;
  }

  const paths = await ensureAddroidPaths();
  const outFile = await resolveOutFile(opts.out, paths, db.database);
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  const dumpArgs = [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--host=${db.host}`,
    `--port=${db.port}`,
    `--username=${db.user}`,
    `--dbname=${db.database}`,
    `--file=${outFile}`,
  ];
  if (!opts.includePgBoss) {
    dumpArgs.push("--exclude-schema=pgboss");
  }

  process.stdout.write(
    [
      "[addroid backup]",
      `  source     : postgres @ ${db.host}:${db.port}/${db.database}`,
      `  pg-boss    : ${opts.includePgBoss ? "included" : "excluded"}`,
      `  output     : ${homeAnchorPath(outFile)}`,
      "",
    ].join("\n")
  );

  const result = await o.spawn("pg_dump", dumpArgs, {
    env: { ...process.env, PGPASSWORD: db.password },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    process.stderr.write(
      `[addroid backup] pg_dump が失敗しました (exit ${result.status ?? "null"})。\n`
    );
    return result.status ?? 1;
  }

  let bytes = 0;
  try {
    const stat = await fs.stat(outFile);
    bytes = stat.size;
  } catch {
    /* size 表示は best-effort */
  }
  process.stdout.write(
    [
      "[addroid backup] 完了",
      `  size       : ${formatBytes(bytes)}`,
      `  restore    : addroid restore ${homeAnchorPath(outFile)}`,
      "",
    ].join("\n")
  );
  return 0;
}

export async function runRestoreCommand(
  args: string[],
  overrides: BackupRuntimeOverrides = {}
): Promise<number> {
  const o: Required<BackupRuntimeOverrides> = { ...DEFAULT_OVERRIDES, ...overrides };
  const opts = parseRestoreArgs(args);
  if ("error" in opts) {
    process.stderr.write(opts.error);
    if (opts.printHelp) printRestoreHelp();
    return opts.code;
  }
  if (opts.help || !opts.file) {
    printRestoreHelp();
    return opts.help ? 0 : 2;
  }

  if (!o.hasBinary("pg_restore")) {
    process.stderr.write(
      [
        "[addroid restore] pg_restore が見つかりません。",
        "  PostgreSQL クライアントツール (postgresql-client / postgresql@16 等) を導入してください。",
        "  例: brew install postgresql@16 / apt install postgresql-client-16",
        "",
      ].join("\n")
    );
    return 1;
  }

  const fileAbs = path.resolve(opts.file);
  try {
    const stat = await fs.stat(fileAbs);
    if (!stat.isFile()) {
      process.stderr.write(`[addroid restore] ${fileAbs} はファイルではありません。\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`[addroid restore] バックアップファイルが見つかりません: ${fileAbs}\n`);
    return 1;
  }

  const db = resolveDatabase();
  if ("error" in db) {
    process.stderr.write(db.error);
    return db.code;
  }

  // worker / web が起動中だと restore 中にスキーマがロックされたり pg-boss が
  // クラッシュするため、`addroid up` の pid file を確認して明示停止を促す。
  const upState = await readUpState(resolveAddroidPaths()).catch(() => null);
  const upAlive =
    upState !== null &&
    (isProcessAlive(upState.parentPid) ||
      isProcessAlive(upState.webPid) ||
      isProcessAlive(upState.workerPid));
  if (upAlive && !opts.forceWhileUp) {
    process.stderr.write(
      [
        "[addroid restore] addroid up が起動中です。",
        "  Restore 中に worker が DB を触ると pg-boss スキーマが破損する可能性があります。",
        "  別ターミナルで `addroid down` を実行して停止してから再実行してください。",
        "  どうしても起動中に強制実行する場合は --force-while-up を指定してください (非推奨)。",
        "",
      ].join("\n")
    );
    return 1;
  }

  const summary = [
    `  target     : postgres @ ${db.host}:${db.port}/${db.database}`,
    `  source     : ${homeAnchorPath(fileAbs)}`,
    `  pg-boss    : ${opts.includePgBoss ? "included (上書き)" : "excluded (既存温存)"}`,
  ];
  process.stdout.write("[addroid restore]\n" + summary.join("\n") + "\n\n");

  if (!opts.yes) {
    const confirmed = await o.confirm(
      "Restore は target DB の既存テーブルを削除し、ダンプ内容で置き換えます。続行しますか? (yes/no): "
    );
    if (!confirmed) {
      process.stdout.write("[addroid restore] 中断しました (確認で no が選ばれました)。\n");
      return 1;
    }
  }

  const restoreArgs = [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    `--host=${db.host}`,
    `--port=${db.port}`,
    `--username=${db.user}`,
    `--dbname=${db.database}`,
  ];
  if (!opts.includePgBoss) {
    restoreArgs.push("--exclude-schema=pgboss");
  }
  restoreArgs.push(fileAbs);

  const result = await o.spawn("pg_restore", restoreArgs, {
    env: { ...process.env, PGPASSWORD: db.password },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    process.stderr.write(
      [
        `[addroid restore] pg_restore が失敗しました (exit ${result.status ?? "null"})。`,
        "  `pg_restore --list <file>` で内容を確認し、所有者 / 権限の差分を確認してください。",
        "",
      ].join("\n")
    );
    return result.status ?? 1;
  }

  process.stdout.write(
    [
      "[addroid restore] 完了",
      "  next       : `addroid up` を再起動し、`addroid doctor` で接続を確認してください。",
      "",
    ].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------

interface ParseError {
  error: string;
  code: number;
  printHelp?: boolean;
}

function parseBackupArgs(args: string[]): BackupOptions | ParseError {
  let out: string | undefined;
  let includePgBoss = true;
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--no-pgboss") includePgBoss = false;
    else if (a === "--out" || a === "-o") {
      const v = args[i + 1];
      i += 1;
      if (!v || v.startsWith("-")) {
        return {
          error: `[addroid backup] --out の値がありません。\n`,
          code: 2,
          printHelp: true,
        };
      }
      out = v;
    } else {
      return {
        error: `[addroid backup] 未知の引数: ${a}\n`,
        code: 2,
        printHelp: true,
      };
    }
  }
  return { out, includePgBoss, help };
}

function parseRestoreArgs(args: string[]): RestoreOptions | ParseError {
  let file: string | undefined;
  let yes = false;
  let includePgBoss = true;
  let forceWhileUp = false;
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--no-pgboss") includePgBoss = false;
    else if (a === "--force-while-up") forceWhileUp = true;
    else if (a.startsWith("-")) {
      return {
        error: `[addroid restore] 未知の引数: ${a}\n`,
        code: 2,
        printHelp: true,
      };
    } else if (!file) {
      file = a;
    } else {
      return {
        error: `[addroid restore] 余分な引数: ${a}\n`,
        code: 2,
        printHelp: true,
      };
    }
  }
  return { file, yes, includePgBoss, forceWhileUp, help };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function resolveDatabase(): ParsedDb | { error: string; code: number } {
  const v = parseDatabaseUrl();
  if (!v.ok) {
    return {
      error: `[addroid backup] DATABASE_URL を解釈できません: ${v.reason}\n${
        v.hint ? `  hint: ${v.hint}\n` : ""
      }`,
      code: 2,
    };
  }
  // URL に含まれる username / password は percent-encoded で来る可能性があるので
  // decodeURIComponent で戻す。pg_dump / pg_restore に渡すのは生の値。
  const user = safeDecode(v.url.username) || "addroid";
  const password = safeDecode(v.url.password);
  return {
    host: v.hostname,
    port: v.port,
    user,
    password,
    database: v.database,
    url: v.url.toString(),
  };
}

function safeDecode(s: string): string {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function resolveOutFile(
  override: string | undefined,
  paths: AddroidPaths,
  database: string
): Promise<string> {
  if (override) {
    return path.resolve(override);
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const fname = `${database}-${stamp}.dump`;
  return path.join(paths.home, "backups", fname);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: SpawnOptions
): Promise<{ status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    child.on("error", () => resolve({ status: 127 }));
    child.on("close", (code) => resolve({ status: code }));
  });
}

function defaultHasBinary(cmd: string): boolean {
  // `command -v` 風のクロスプラットフォーム探索。Windows では `where`、その他は `which`。
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [cmd], { encoding: "utf8" })
      : spawnSync("which", [cmd], { encoding: "utf8" });
  if (probe.error) return false;
  return probe.status === 0 && Boolean((probe.stdout ?? "").trim());
}

function defaultConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

// ---------------------------------------------------------------------
// help
// ---------------------------------------------------------------------

function printBackupHelp(): void {
  process.stdout.write(
    [
      "addroid backup — DATABASE_URL の DB を pg_dump --format=custom で保存",
      "",
      "Usage:",
      "  addroid backup [--out PATH] [--no-pgboss]",
      "",
      "Options:",
      "  --out, -o PATH    出力ファイル (既定: ~/.addroid/backups/<db>-<timestamp>.dump)",
      "  --no-pgboss       pg-boss スキーマ (`pgboss`) を除外する (workspace 移植用)",
      "  -h, --help        このヘルプを表示",
      "",
      "Notes:",
      "  - pg_dump は PATH 上に存在する必要があります (postgresql-client パッケージ)。",
      "  - 既定では Prisma 管理テーブルと pg-boss スキーマの両方を 1 ダンプに含めます。",
      "  - 出力ファイルにトークン暗号文 (oauth_tokens.access_token_ciphertext 等) が",
      "    含まれます。バックアップは ENCRYPTION_KEY と同等の機密として扱ってください。",
      "",
    ].join("\n")
  );
}

function printRestoreHelp(): void {
  process.stdout.write(
    [
      "addroid restore — pg_restore --clean --if-exists でダンプを復元",
      "",
      "Usage:",
      "  addroid restore <FILE> [--yes] [--no-pgboss] [--force-while-up]",
      "",
      "Options:",
      "  --yes, -y          確認プロンプトをスキップ (CI 用)",
      "  --no-pgboss        pg-boss スキーマ (`pgboss`) を復元対象から除外",
      "  --force-while-up   addroid up 起動中でも強制実行 (非推奨。worker と DB が衝突する可能性)",
      "  -h, --help         このヘルプを表示",
      "",
      "Notes:",
      "  - Restore は破壊的 (target DB の対象スキーマを削除して置換) です。",
      "  - 復元前に必ず `addroid down` を実行してください。",
      "  - ENCRYPTION_KEY が変わっていると oauth_tokens を復号できません。鍵もセットで保管してください。",
      "",
    ].join("\n")
  );
}

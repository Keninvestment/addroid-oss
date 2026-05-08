// AdDroid OSS — path resolution for ~/.addroid (overridable via ADDROID_HOME).
//
// 個人パスをハードコードしないため、すべての OS パスは process.env.HOME 経由で解決します。
// 実体ディレクトリの作成は `ensureAddroidPaths` のみが行い、解決のみが必要な側 (UI / doctor)
// は副作用なしの `resolveAddroidPaths` を使います。

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

export interface AddroidPaths {
  home: string;
  configFile: string;
  secretsFile: string;
  storageDir: string;
  logsDir: string;
  runDir: string;
  pidFile: string;
  webLogFile: string;
  workerLogFile: string;
  serviceLogFile: string;
  serviceErrLogFile: string;
  serviceEnvFile: string;
  serviceWrapperFile: string;
  /**
   * `addroid up` の既定モード (web + worker を 1 プロセス併走) で、CLI 自身の
   * stdout/stderr を tee する先。`--separate-worker` の場合は web/worker 各ログに分かれる。
   */
  upLogFile: string;
}

/**
 * AdDroid のホームディレクトリを返す。`ADDROID_HOME` が設定されていれば
 * それを使い、未設定なら `~/.addroid` を返す。個人パスをハードコードしない。
 */
export function resolveAddroidHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ADDROID_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".addroid");
}

/**
 * 絶対パスが `$HOME` で前置されている場合のみ `~/...` 形式の HOME-anchored
 * 表示に変換する。SSR HTML / UI 表示用の redactor として使う。`$HOME` の外側に
 * あるパスは原文を返す (個人 path を含まないため redact 不要)。
 *
 * `~` は常に shell セマンティクスの `$HOME` を意味する。`ADDROID_HOME` は
 * AdDroid 固有の概念なので、ここでは展開しない (もし `ADDROID_HOME` が
 * `$HOME` の外側を指していても本ヘルパは原文を返し、呼び出し側に明示的な
 * 個人パスを露出しないことを優先する)。
 *
 * 個人 path (`/Users/<me>/...` 等) を Web UI / 監査ログ / docs に出さないための
 * 共有ヘルパ。the current implementation の `oss_hygiene_rules` で参照される。
 */
export function homeAnchorPath(
  absolutePath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    return absolutePath;
  }
  // テスト容易性: env.HOME / env.USERPROFILE を尊重し、それが無ければ
  // `os.homedir()` にフォールバック。
  const home =
    (env.HOME && env.HOME.length > 0 ? env.HOME : undefined) ??
    (env.USERPROFILE && env.USERPROFILE.length > 0 ? env.USERPROFILE : undefined) ??
    os.homedir();
  if (typeof home !== "string" || home.length === 0) {
    return absolutePath;
  }
  if (absolutePath === home) {
    return "~";
  }
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (absolutePath.startsWith(prefix)) {
    const rest = absolutePath.slice(prefix.length);
    return rest.length === 0 ? "~" : "~/" + rest.split(path.sep).join("/");
  }
  return absolutePath;
}

export function resolveAddroidPaths(env: NodeJS.ProcessEnv = process.env): AddroidPaths {
  const home = resolveAddroidHome(env);
  const logsDir = path.join(home, "logs");
  const runDir = path.join(home, "run");
  return {
    home,
    configFile: path.join(home, "config.yaml"),
    secretsFile: path.join(home, "secrets.local.yaml"),
    storageDir: path.join(home, "storage"),
    logsDir,
    runDir,
    pidFile: path.join(runDir, "up.json"),
    webLogFile: path.join(logsDir, "web.log"),
    workerLogFile: path.join(logsDir, "worker.log"),
    serviceLogFile: path.join(logsDir, "service.log"),
    serviceErrLogFile: path.join(logsDir, "service.err.log"),
    serviceEnvFile: path.join(runDir, "service.env"),
    serviceWrapperFile: path.join(runDir, "service-runner.sh"),
    upLogFile: path.join(logsDir, "up.log"),
  };
}

/**
 * ~/.addroid とその配下ディレクトリ (storage / logs / run) を冪等に作成する。
 * 既存ファイルやサブパスは破壊しない。CLI から繰り返し呼んでも安全。
 */
export async function ensureAddroidPaths(
  env: NodeJS.ProcessEnv = process.env
): Promise<AddroidPaths> {
  const paths = resolveAddroidPaths(env);
  for (const dir of [paths.home, paths.storageDir, paths.logsDir, paths.runDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
  return paths;
}

/**
 * AdDroid OSS が許容する Web UI バインド先 (localhost-only)。
 * the current implementation の不変条件である「Web UI binds to 127.0.0.1 only / outbound-only」を
 * 強制するため、`resolveWebBinding` はこの集合に含まれない hostname を拒否する。
 */
export const ALLOWED_LOCALHOST_HOSTNAMES = ["127.0.0.1", "localhost", "::1"] as const;

/**
 * Web UI のバインド情報。デフォルトは 127.0.0.1:3000。
 * `ADDROID_WEB_HOSTNAME` は 127.0.0.1 / localhost / ::1 のみ許容し、
 * `0.0.0.0` などの public-interface バインドは throw して拒否する。
 */
export function resolveWebBinding(env: NodeJS.ProcessEnv = process.env): {
  hostname: string;
  port: number;
} {
  const hostname = env.ADDROID_WEB_HOSTNAME?.trim() || "127.0.0.1";
  if (!(ALLOWED_LOCALHOST_HOSTNAMES as readonly string[]).includes(hostname)) {
    throw new Error(
      `Invalid ADDROID_WEB_HOSTNAME: ${JSON.stringify(hostname)}. ` +
        `AdDroid OSS は localhost-bound 起動のみを許可します ` +
        `(許可される値: ${ALLOWED_LOCALHOST_HOSTNAMES.join(", ")})。`
    );
  }
  const portRaw = env.ADDROID_WEB_PORT?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3000;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ADDROID_WEB_PORT: ${portRaw ?? "(unset)"}`);
  }
  return { hostname, port };
}

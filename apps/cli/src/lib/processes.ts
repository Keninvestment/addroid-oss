// AdDroid OSS — pid file 管理 + プロセス生存確認。
//
// `addroid up` がリポジトリルートから web/worker を spawn するときに pid を記録し、
// `addroid down` / `addroid status` から再利用する。pid file 自体は ~/.addroid/run/up.json。

import fs from "node:fs/promises";
import path from "node:path";
import { resolveAddroidPaths, type AddroidPaths } from "@addroid/config";

export type UpMode = "shared" | "separate-worker";

export interface UpState {
  startedAt: string;
  parentPid: number;
  webPid?: number;
  workerPid?: number;
  webUrl: string;
  cwd: string;
  /**
   * "shared": web と worker を CLI と同じプロセスで併走 (the current implementation の既定).
   * "separate-worker": worker のみ別プロセスで spawn (将来の scale-out 経路).
   */
  mode: UpMode;
  /**
   * Web UI の起動状態。"failed" は Next.js prepare/listen が失敗し worker のみで
   * 稼働している degraded mode を示す (GitOps polling / Apply / Cron は継続)。
   */
  webStatus?: "running" | "failed";
}

export async function readUpState(
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<UpState | null> {
  try {
    const raw = await fs.readFile(paths.pidFile, "utf8");
    return JSON.parse(raw) as UpState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeUpState(
  state: UpState,
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<void> {
  await fs.mkdir(path.dirname(paths.pidFile), { recursive: true });
  const temporary = `${paths.pidFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, paths.pidFile);
}

export async function clearUpState(
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<void> {
  try {
    await fs.unlink(paths.pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // 別ユーザー起動だが存在はしている
    return false;
  }
}

/**
 * pid に SIGTERM を送る。生存していなければ noop。
 */
export function terminateProcess(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  if (!isProcessAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// SSR からサブシステムの状態を判定するヘルパ。すべて副作用なし、I/O なしで
// "skeleton 段階で何が利用可能か" を返す。実 I/O が必要なものは呼び出し元で
// Prisma に直接問い合わせる。

import fs from "node:fs";
import { homeAnchorPath, resolveAddroidPaths, resolveWebBinding } from "@addroid/config";
import { prisma } from "./prisma";

export interface SubsystemStatus {
  state: "ok" | "warn" | "error" | "info" | "idle";
  message: string;
}

export interface DashboardStatus {
  config: SubsystemStatus & { configPath: string };
  database: SubsystemStatus;
  worker: SubsystemStatus;
  github: SubsystemStatus;
  binding: { hostname: string; port: number };
}

/**
 * `~/.addroid/config.yaml` の存在チェック。中身の検証は後続タスクで行う。
 */
export function inspectConfig(): SubsystemStatus & { configPath: string } {
  const paths = resolveAddroidPaths();
  // SSR HTML に絶対個人 path を出さないため、`~/.addroid/config.yaml` 形式に
  // 正規化する (the current implementation oss_hygiene_rules)。実 I/O は絶対 path に対して行う。
  const displayPath = homeAnchorPath(paths.configFile);
  let exists = false;
  try {
    exists = fs.statSync(paths.configFile).isFile();
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      state: "warn",
      configPath: displayPath,
      message: "config 未生成。ターミナルで addroid init を実行してください。",
    };
  }
  return {
    state: "ok",
    configPath: displayPath,
    message: "config を検出しました。",
  };
}

/**
 * Prisma 経由で SELECT 1 を発行し DB 接続を検証する。
 * テーブル未作成の場合も SELECT 1 は通るので、別途 workspaces.count() で骨格反映を確認する。
 */
export async function inspectDatabase(): Promise<SubsystemStatus> {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (err) {
    return {
      state: "error",
      message: `PostgreSQL に接続できません: ${describeError(err)}。pg_isready -h localhost -p 5432 で起動を確認してください。`,
    };
  }
  try {
    await prisma.workspace.count();
  } catch (err) {
    return {
      state: "warn",
      message: `DB 接続は成功しましたが Prisma スキーマが未反映です: ${describeError(
        err
      )}。npm run db:push を実行してください。`,
    };
  }
  return {
    state: "ok",
    message: "PostgreSQL に接続できました。",
  };
}

/**
 * Worker / pg-boss の起動状況。the current implementation の skeleton では `cron_schedules` の
 * 登録件数で間接的に「worker が一度でも起動した形跡」があるかを判定する。
 */
export async function inspectWorker(): Promise<SubsystemStatus> {
  try {
    const count = await prisma.cronSchedule.count();
    if (count === 0) {
      return {
        state: "warn",
        message: "worker が起動していません。addroid up または npm run dev:worker を実行してください。",
      };
    }
    return {
      state: "ok",
      message: `${count} 件の cron スケジュールを検出しました。`,
    };
  } catch (err) {
    return {
      state: "error",
      message: `worker の状態を取得できません: ${describeError(err)}。`,
    };
  }
}

/**
 * GitHub OAuth 連携の有無。the current implementation 段階では `oauth_tokens` に GitHub の行が
 * 存在するかを判定するだけにとどめる。
 */
export async function inspectGithub(): Promise<SubsystemStatus> {
  try {
    const count = await prisma.oAuthToken.count({ where: { provider: "github" } });
    if (count === 0) {
      return {
        state: "warn",
        message: "GitHub と未連携です。/github から OAuth を開始してください。",
      };
    }
    return {
      state: "ok",
      message: "GitHub OAuth トークンを検出しました。",
    };
  } catch (err) {
    return {
      state: "error",
      message: `GitHub 連携の状態を取得できません: ${describeError(err)}。`,
    };
  }
}

export async function loadDashboardStatus(): Promise<DashboardStatus> {
  let binding = { hostname: "127.0.0.1", port: 3000 };
  try {
    binding = resolveWebBinding();
  } catch {
    /* keep default */
  }
  const config = inspectConfig();
  const [database, worker, github] = await Promise.all([
    inspectDatabase(),
    inspectWorker(),
    inspectGithub(),
  ]);
  return { config, database, worker, github, binding };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.name;
  return String(err);
}

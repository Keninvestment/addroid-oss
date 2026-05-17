// AdDroid OSS — execute_apply 用の Ads YAML loader (apps/worker side).
//
// the current implementation 受入の "Apply a valid YAML change as PAUSED resources or a mocked
// equivalent in local tests" を満たすために、以下 2 つの動作モードを持つ:
//
//   - real: `ADDROID_OPS_REPO_LOCAL_DIR` が指すローカル checkout を使う。
//     承認済み PR の merge commit と、その first parent の差分だけを `next` /
//     `previous` として読み込む。Apply は PR 単位で独立し、過去/後続 PR の
//     desired-state 差分を別PRの承認で巻き込まない。
//   - mocked: env が未設定の場合は `accounts: []` を返し、orchestrator 側で
//     `simulated` 状態に倒す。the current implementation の "mocked equivalent in local tests"
//     経路をこれで吸収する (UI/audit には source=unavailable を表示する)。
//
// regression fix: real モードでは `loadForApply` 呼び出し時に
// `AdsLoaderInput.context` の `headSha` / `repoId` を必ず検証する。
//   - 承認済み merge commit / parent commit / changed brand.yaml を解決できない、または
//   - 起動時に解決した workspace の opsRepoId が `context.repoId` と一致しない、
// 場合は fail-closed (source=unavailable) で返し、Meta mutation 経路に到達させない。
// これにより「承認済み PR の差分だけが Apply に流れる」契約 (gitops-only
// approved PR diff) を loader 境界でも保証する。
//
// 本ファイルは Prisma を import せず、ファイルシステム + git の HEAD 取得のみを
// 触る純粋境界。git 取得は execFile (引数固定, no shell) を使う。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_OPS_REPO_LAYOUT,
  loadAndValidateOpsRepo,
  loadPreviousOpsRepoState,
} from "@addroid/yaml-schemas";
import type {
  AccountAdsState,
  AdsLoader,
  AdsLoaderInput,
  AdsLoadResult,
} from "@addroid/queue";

const execFileAsync = promisify(execFile);

/** 40-char hex SHA1 (git のコミットハッシュ) を判定する。 */
function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * `git -C <dir> rev-parse HEAD` を呼び、現在の HEAD コミットの 40-char hex を
 * 返す。git が無い / .git が無い / 何らかの失敗時は null を返す (fail-closed)。
 */
async function readGitHeadSha(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "HEAD"],
      { timeout: 5_000, maxBuffer: 256 * 1024 }
    );
    const sha = stdout.trim().toLowerCase();
    return isFullSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function gitCommitExists(dir: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function readGitFirstParentSha(dir: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", `${sha}^`], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const parent = stdout.trim().toLowerCase();
    return isFullSha(parent) ? parent : null;
  } catch {
    return null;
  }
}

async function readGitChangedFiles(
  dir: string,
  baseSha: string,
  headSha: string
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "diff", "--name-only", `${baseSha}..${headSha}`],
      { timeout: 10_000, maxBuffer: 1024 * 1024 }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function changedAccountKeys(files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (
      parts.length >= 4 &&
      parts[0] === "ads" &&
      parts[1] === "accounts" &&
      parts[3] === "brand.yaml"
    ) {
      out.add(parts[2]!);
    }
  }
  return out;
}

async function materializeGitCommit(dir: string, sha: string): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const worktreeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "addroid-apply-worktree-"));
  let added = false;
  try {
    await execFileAsync(
      "git",
      ["-C", dir, "worktree", "add", "--detach", "--quiet", worktreeDir, sha],
      { timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
    added = true;
    return {
      dir: worktreeDir,
      cleanup: async () => {
        if (added) {
          await execFileAsync(
            "git",
            ["-C", dir, "worktree", "remove", "--force", worktreeDir],
            { timeout: 30_000, maxBuffer: 1024 * 1024 }
          ).catch(() => undefined);
        }
        await fsp.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    await fsp.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export interface LocalDirAdsLoaderOptions {
  /** ops repo の checkout 絶対パス。null/未指定なら "no source" を返す。 */
  localDir: string | null;
  /**
   * このワーカーが管理する ops repo の `github_repos.id` (UUID)。
   * `loadForApply` は `AdsLoaderInput.context.repoId` がこの値と一致した
   * 場合だけ load を許可する。null/未指定なら repoId 検証はスキップせず
   * fail-closed する (= 別 ops repo の PR を localDir 経由で apply しない)。
   */
  expectedRepoId?: string | null;
  /**
   * テスト用の HEAD SHA リゾルバ差し替え点。本番では `git rev-parse HEAD` を
   * 呼び出すデフォルト実装を使う。
   */
  readHeadSha?: (dir: string) => Promise<string | null>;
  commitExists?: (dir: string, sha: string) => Promise<boolean>;
  readParentSha?: (dir: string, sha: string) => Promise<string | null>;
  readChangedFiles?: (dir: string, baseSha: string, headSha: string) => Promise<string[] | null>;
  materializeCommit?: (dir: string, sha: string) => Promise<{
    dir: string;
    cleanup: () => Promise<void>;
  }>;
}

export class LocalDirAdsLoader implements AdsLoader {
  private readonly localDir: string | null;
  private readonly expectedRepoId: string | null;
  private readonly readHeadSha: (dir: string) => Promise<string | null>;
  private readonly commitExists: (dir: string, sha: string) => Promise<boolean>;
  private readonly readParentSha: (dir: string, sha: string) => Promise<string | null>;
  private readonly readChangedFiles: (
    dir: string,
    baseSha: string,
    headSha: string
  ) => Promise<string[] | null>;
  private readonly materializeCommit: (
    dir: string,
    sha: string
  ) => Promise<{ dir: string; cleanup: () => Promise<void> }>;

  constructor(opts: LocalDirAdsLoaderOptions) {
    this.localDir = opts.localDir;
    this.expectedRepoId = opts.expectedRepoId ?? null;
    this.readHeadSha = opts.readHeadSha ?? readGitHeadSha;
    this.commitExists = opts.commitExists ?? gitCommitExists;
    this.readParentSha = opts.readParentSha ?? readGitFirstParentSha;
    this.readChangedFiles = opts.readChangedFiles ?? readGitChangedFiles;
    this.materializeCommit = opts.materializeCommit ?? materializeGitCommit;
  }

  async loadForApply(input: AdsLoaderInput): Promise<AdsLoadResult> {
    const { context } = input;
    if (!this.localDir || !fs.existsSync(this.localDir)) {
      return {
        source: "unavailable",
        detail:
          "ADDROID_OPS_REPO_LOCAL_DIR is not set (or path does not exist); falling back to simulated apply.",
        accounts: [],
      };
    }
    // 1) repoId guard: workspace に登録された ops repo と PR の repoId が
    //    一致しなければ "他リポジトリの状態を localDir 経由で適用してしまう"
    //    リスクを fail-closed で遮断する。
    if (!this.expectedRepoId) {
      return {
        source: "unavailable",
        detail:
          "ops repo id is not configured for the worker; refusing to apply local checkout without repo identity verification.",
        accounts: [],
      };
    }
    if (context.repoId !== this.expectedRepoId) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} targets repoId=${context.repoId}, but local checkout is bound to repoId=${this.expectedRepoId}; refusing to apply foreign repo state.`,
        accounts: [],
      };
    }
    // 2) mergeSha guard: approved PR が base branch に入った merge/squash/rebase
    //    commit と、その first parent の差分だけを load する。
    //    headSha は承認対象IDとして検証し、実際の next/previous は mergeSha 境界で読む。
    if (!isFullSha(context.headSha)) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} headSha is not a 40-char SHA (${context.headSha}); refusing to apply.`,
        accounts: [],
      };
    }
    const mergeSha = context.mergeSha?.toLowerCase() ?? null;
    if (!mergeSha || !isFullSha(mergeSha)) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} has no verified mergeSha; refusing to apply without the exact merged PR boundary.`,
        accounts: [],
      };
    }
    const head = await this.readHeadSha(this.localDir);
    if (!head) {
      return {
        source: "unavailable",
        detail: `cannot resolve git HEAD at ${this.localDir} (not a git checkout, or git unavailable); refusing to apply unverified ops repo state.`,
        accounts: [],
      };
    }
    const parentSha = await this.readParentSha(this.localDir, mergeSha);
    if (!parentSha) {
      return {
        source: "unavailable",
        detail: `cannot resolve parent commit for approved PR merge ${mergeSha}; refusing to apply without a PR-specific base state.`,
        accounts: [],
      };
    }
    if (!(await this.commitExists(this.localDir, mergeSha))) {
      return {
        source: "unavailable",
        detail: `approved PR merge ${mergeSha} is not available locally; refusing to apply without the exact merged PR diff.`,
        accounts: [],
      };
    }
    if (!(await this.commitExists(this.localDir, parentSha))) {
      return {
        source: "unavailable",
        detail: `parent commit ${parentSha} for approved PR merge ${mergeSha} is not available locally; refusing to apply without the exact merged PR diff.`,
        accounts: [],
      };
    }
    const changedFiles = await this.readChangedFiles(this.localDir, parentSha, mergeSha);
    if (!changedFiles) {
      return {
        source: "unavailable",
        detail: `cannot resolve changed files for approved PR merge ${mergeSha}; refusing to apply without the exact merged PR diff.`,
        accounts: [],
      };
    }
    const changedAccounts = changedAccountKeys(changedFiles);
    if (changedAccounts.size === 0) {
      return {
        source: "unavailable",
        detail: `approved PR #${context.prNumber} does not change any ads/accounts/*/brand.yaml file; no Meta apply actions are allowed for this PR.`,
        accounts: [],
      };
    }
    let loadDir = this.localDir;
    let cleanup: (() => Promise<void>) | null = null;
    let previousCleanup: (() => Promise<void>) | null = null;
    if (head !== mergeSha) {
      const materialized = await this.materializeCommit(this.localDir, mergeSha);
      loadDir = materialized.dir;
      cleanup = materialized.cleanup;
    }
    const previous = await this.materializeCommit(this.localDir, parentSha);
    const previousDir = previous.dir;
    previousCleanup = previous.cleanup;
    // 3) 検証済 — 既存の YAML loader でロード。
    try {
      const previousState = loadPreviousOpsRepoState(previousDir);
      const validation = loadAndValidateOpsRepo(loadDir, undefined, { previous: previousState });
      if (!validation.ok) {
        return {
          source: "unavailable",
          detail: `ops repo at ${loadDir} failed validation (${validation.errors.length} errors)`,
          accounts: [],
        };
      }
      const accounts: AccountAdsState[] = validation.loaded.brands
        .filter((b) => changedAccounts.has(b.accountKey))
        .map((b) => ({
          accountKey: b.accountKey,
          next: b.brand,
          previous: previousState.brands.get(b.accountKey) ?? null,
        }));
      if (accounts.length === 0) {
        return {
          source: "unavailable",
          detail: `${path.join(loadDir, DEFAULT_OPS_REPO_LAYOUT.accountsDir)} has no changed accounts for approved PR #${context.prNumber}`,
          accounts: [],
        };
      }
      return {
        source: "local_dir",
        detail:
          head === mergeSha
            ? `loaded ${accounts.length} changed account(s) from approved PR merge diff ${parentSha}..${mergeSha}`
            : `loaded ${accounts.length} changed account(s) from approved PR merge ${mergeSha} using local checkout ${this.localDir} @ ${head}`,
        accounts,
      };
    } finally {
      await cleanup?.();
      await previousCleanup?.();
    }
  }
}

/**
 * env から `ADDROID_OPS_REPO_LOCAL_DIR` を読み、
 * `LocalDirAdsLoader` を構築する。worker 起動時に 1 度だけ呼ぶ。
 *
 * `expectedRepoId` は呼び出し側 (runtime.ts) が Prisma から
 * `workspace.opsRepoId` を取得して渡す。Apply は承認済み PR からしか流れないため、
 * opsRepoId が未設定の workspace では apply_jobs 自体が積まれない。
 */
export function createLocalDirAdsLoaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { expectedRepoId?: string | null; localDir?: string | null } = {}
): LocalDirAdsLoader {
  const local = opts.localDir ?? (env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || null);
  return new LocalDirAdsLoader({
    localDir: local,
    expectedRepoId: opts.expectedRepoId ?? null,
  });
}

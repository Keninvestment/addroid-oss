// AdDroid OSS — execute_apply 用の Ads YAML loader (apps/worker side).
//
// the current implementation 受入の "Apply a valid YAML change as PAUSED resources or a mocked
// equivalent in local tests" を満たすために、以下 2 つの動作モードを持つ:
//
//   - real: `ADDROID_OPS_REPO_LOCAL_DIR` が指すローカル checkout を使う。
//     `<dir>/ads/accounts/<key>/brand.yaml` を `next` として読み込み、
//     `ADDROID_OPS_REPO_BASE_DIR` (任意) があればそれを `previous` として使う。
//     どちらも `loadAndValidateOpsRepo` / `loadPreviousOpsRepoState` を流用する。
//   - mocked: env が未設定の場合は `accounts: []` を返し、orchestrator 側で
//     `simulated` 状態に倒す。the current implementation の "mocked equivalent in local tests"
//     経路をこれで吸収する (UI/audit には source=unavailable を表示する)。
//
// regression fix: real モードでは `loadForApply` 呼び出し時に
// `AdsLoaderInput.context` の `headSha` / `repoId` を必ず検証する。
//   - localDir の git HEAD が `context.headSha` と一致しない、または
//   - 起動時に解決した workspace の opsRepoId が `context.repoId` と一致しない、
// 場合は fail-closed (source=unavailable) で返し、Meta mutation 経路に到達させない。
// これにより「承認済み PR の YAML だけが Apply に流れる」契約 (gitops-only
// approved state) を loader 境界でも保証する。
//
// 本ファイルは Prisma を import せず、ファイルシステム + git の HEAD 取得のみを
// 触る純粋境界。git 取得は execFile (引数固定, no shell) を使う。

import fs from "node:fs";
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

export interface LocalDirAdsLoaderOptions {
  /** ops repo の checkout 絶対パス。null/未指定なら "no source" を返す。 */
  localDir: string | null;
  /** 比較ベースとなる base ブランチ checkout (`previous`)。任意。 */
  baseDir?: string | null;
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
}

export class LocalDirAdsLoader implements AdsLoader {
  private readonly localDir: string | null;
  private readonly baseDir: string | null;
  private readonly expectedRepoId: string | null;
  private readonly readHeadSha: (dir: string) => Promise<string | null>;

  constructor(opts: LocalDirAdsLoaderOptions) {
    this.localDir = opts.localDir;
    this.baseDir = opts.baseDir ?? null;
    this.expectedRepoId = opts.expectedRepoId ?? null;
    this.readHeadSha = opts.readHeadSha ?? readGitHeadSha;
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
    // 2) headSha guard: localDir の git HEAD が approved PR の headSha と
    //    一致しない場合は stale/未同期とみなし fail-closed。
    if (!isFullSha(context.headSha)) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} headSha is not a 40-char SHA (${context.headSha}); refusing to apply.`,
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
    if (head !== context.headSha.toLowerCase()) {
      return {
        source: "unavailable",
        detail: `local checkout HEAD (${head}) does not match approved PR headSha (${context.headSha}) for pr#${context.prNumber}; refusing to apply stale ops repo state.`,
        accounts: [],
      };
    }
    // 3) 検証済 — 既存の YAML loader でロード。
    const validation = loadAndValidateOpsRepo(this.localDir);
    if (!validation.ok) {
      return {
        source: "unavailable",
        detail: `ops repo at ${this.localDir} failed validation (${validation.errors.length} errors)`,
        accounts: [],
      };
    }
    const previous =
      this.baseDir && fs.existsSync(this.baseDir)
        ? loadPreviousOpsRepoState(this.baseDir)
        : null;
    const accounts: AccountAdsState[] = validation.loaded.brands.map((b) => ({
      accountKey: b.accountKey,
      next: b.brand,
      previous: previous?.brands.get(b.accountKey) ?? null,
    }));
    if (accounts.length === 0) {
      return {
        source: "unavailable",
        detail: `${path.join(this.localDir, DEFAULT_OPS_REPO_LAYOUT.accountsDir)} has no accounts`,
        accounts: [],
      };
    }
    return {
      source: "local_dir",
      detail: `loaded ${accounts.length} account(s) from ${this.localDir} @ ${head}`,
      accounts,
    };
  }
}

/**
 * env から `ADDROID_OPS_REPO_LOCAL_DIR` / `ADDROID_OPS_REPO_BASE_DIR` を読み、
 * `LocalDirAdsLoader` を構築する。worker 起動時に 1 度だけ呼ぶ。
 *
 * `expectedRepoId` は呼び出し側 (runtime.ts) が Prisma から
 * `workspace.opsRepoId` を取得して渡す。Apply は承認済み PR からしか流れないため、
 * opsRepoId が未設定の workspace では apply_jobs 自体が積まれない。
 */
export function createLocalDirAdsLoaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { expectedRepoId?: string | null } = {}
): LocalDirAdsLoader {
  const local = env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || null;
  const base = env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  return new LocalDirAdsLoader({
    localDir: local,
    baseDir: base,
    expectedRepoId: opts.expectedRepoId ?? null,
  });
}

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureAddroidPaths, getCryptoBoundary, resolveAddroidPaths } from "@addroid/config";

const execFileAsync = promisify(execFile);

export interface OpsRepoLocalWorkspace {
  opsRepoId: string | null;
  opsRepo: {
    owner: string;
    name: string;
    defaultBranch: string;
  } | null;
}

export interface OpsRepoLocalPrisma {
  workspace: {
    findUnique(args: unknown): Promise<OpsRepoLocalWorkspace | null>;
  };
  oAuthToken?: {
    findFirst(args: unknown): Promise<{ accessTokenCiphertext: string } | null>;
  };
}

export interface ResolvedOpsRepoLocalDir {
  rootDir: string | null;
  source: "env" | "managed" | "missing";
  repo: OpsRepoLocalWorkspace["opsRepo"];
  exists: boolean;
}

export function managedOpsRepoLocalDir(input: {
  storageDir: string;
  owner: string;
  name: string;
}): string {
  return path.join(
    input.storageDir,
    "ops-repos",
    safePathSegment(input.owner),
    safePathSegment(input.name)
  );
}

export async function resolveOpsRepoLocalDirForWorkspace(opts: {
  prisma: OpsRepoLocalPrisma;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedOpsRepoLocalDir> {
  const env = opts.env ?? process.env;
  const envRoot = env.ADDROID_OPS_REPO_LOCAL_DIR?.trim();
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      opsRepoId: true,
      opsRepo: { select: { owner: true, name: true, defaultBranch: true } },
    },
  });
  const repo = workspace?.opsRepo ?? null;
  if (envRoot) {
    return {
      rootDir: path.resolve(envRoot),
      source: "env",
      repo,
      exists: await pathExists(envRoot),
    };
  }
  if (!workspace?.opsRepoId || !repo) {
    return { rootDir: null, source: "missing", repo: null, exists: false };
  }
  const paths = resolveAddroidPaths(env);
  const rootDir = managedOpsRepoLocalDir({
    storageDir: paths.storageDir,
    owner: repo.owner,
    name: repo.name,
  });
  return {
    rootDir,
    source: "managed",
    repo,
    exists: await pathExists(rootDir),
  };
}

export async function ensureOpsRepoLocalCheckout(opts: {
  prisma: OpsRepoLocalPrisma;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedOpsRepoLocalDir & { cloned: boolean; synced: boolean }> {
  const env = opts.env ?? process.env;
  const resolved = await resolveOpsRepoLocalDirForWorkspace(opts);
  if (!resolved.rootDir || !resolved.repo) {
    return { ...resolved, cloned: false, synced: false };
  }
  if (resolved.source === "managed") {
    await ensureAddroidPaths(env);
  } else {
    await fs.mkdir(path.dirname(resolved.rootDir), { recursive: true });
  }

  const token = await loadGithubAccessToken(opts.prisma, env);
  const remoteUrl = `https://github.com/${encodeURIComponent(resolved.repo.owner)}/${encodeURIComponent(
    resolved.repo.name
  )}.git`;
  const branch = resolved.repo.defaultBranch || "main";

  if (!resolved.exists) {
    await fs.mkdir(path.dirname(resolved.rootDir), { recursive: true });
    await runGitWithGithubToken(
      ["clone", "--branch", branch, "--depth", "1", remoteUrl, resolved.rootDir],
      token
    );
    return { ...resolved, exists: true, cloned: true, synced: false };
  }

  if (!(await pathExists(path.join(resolved.rootDir, ".git")))) {
    return { ...resolved, cloned: false, synced: false };
  }
  const dirty = await gitHasLocalChanges(resolved.rootDir);
  if (dirty) {
    return { ...resolved, cloned: false, synced: false };
  }
  await runGitWithGithubToken(
    [
      "-C",
      resolved.rootDir,
      "fetch",
      "origin",
      branch,
      "+refs/pull/*/head:refs/remotes/origin/pr/*",
    ],
    token
  );
  await runGitWithGithubToken(["-C", resolved.rootDir, "pull", "--ff-only", "origin", branch], token);
  return { ...resolved, cloned: false, synced: true };
}

async function loadGithubAccessToken(
  prisma: OpsRepoLocalPrisma,
  env: NodeJS.ProcessEnv
): Promise<string> {
  if (!prisma.oAuthToken) {
    throw new Error("GitHub token store is unavailable; cannot clone ops repo.");
  }
  const row = await prisma.oAuthToken.findFirst({
    where: { provider: "github" },
    orderBy: { connectedAt: "desc" },
    select: { accessTokenCiphertext: true },
  });
  if (!row) {
    throw new Error("GitHub OAuth token is not connected; cannot clone ops repo.");
  }
  return getCryptoBoundary(env).decrypt(row.accessTokenCiphertext);
}

async function runGitWithGithubToken(args: string[], token: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addroid-git-askpass-"));
  const askpass = path.join(dir, "askpass.sh");
  await fs.writeFile(
    askpass,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "*Username*) printf '%s\\n' \"$GIT_USERNAME\" ;;",
      "*) printf '%s\\n' \"$GIT_PASSWORD\" ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 }
  );
  try {
    await execFileAsync("git", args, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: askpass,
        GIT_USERNAME: "x-access-token",
        GIT_PASSWORD: token,
      },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function gitHasLocalChanges(rootDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootDir, "status", "--porcelain"], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!segment || segment === "." || segment === ".." || segment.includes(path.sep)) {
    throw new Error(`Invalid ops repo path segment: ${JSON.stringify(value)}`);
  }
  return segment;
}

export function existingOpsRepoLocalDirSync(input: {
  env?: NodeJS.ProcessEnv;
  storageDir: string;
  repo: { owner: string; name: string };
}): string | null {
  const envRoot = input.env?.ADDROID_OPS_REPO_LOCAL_DIR?.trim();
  if (envRoot && fsSync.existsSync(envRoot)) return path.resolve(envRoot);
  const managed = managedOpsRepoLocalDir({
    storageDir: input.storageDir,
    owner: input.repo.owner,
    name: input.repo.name,
  });
  return fsSync.existsSync(managed) ? managed : null;
}

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import {
  managedOpsRepoLocalDir,
  resolveOpsRepoLocalDirForWorkspace,
} from "../ops-repo-local.js";

test("resolveOpsRepoLocalDirForWorkspace uses ADDROID_OPS_REPO_LOCAL_DIR when set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "addroid-ops-env-"));
  try {
    const out = await resolveOpsRepoLocalDirForWorkspace({
      prisma: fakePrisma({
        owner: "owner",
        name: "repo",
        defaultBranch: "main",
      }),
      workspaceId: "ws_1",
      env: { ADDROID_OPS_REPO_LOCAL_DIR: dir },
    });
    assert.equal(out.source, "env");
    assert.equal(out.rootDir, dir);
    assert.equal(out.exists, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveOpsRepoLocalDirForWorkspace falls back to managed storage path", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "addroid-home-"));
  try {
    const expected = managedOpsRepoLocalDir({
      storageDir: path.join(home, "storage"),
      owner: "octo",
      name: "addroid-ops",
    });
    await mkdir(expected, { recursive: true });
    const out = await resolveOpsRepoLocalDirForWorkspace({
      prisma: fakePrisma({
        owner: "octo",
        name: "addroid-ops",
        defaultBranch: "main",
      }),
      workspaceId: "ws_1",
      env: { ADDROID_HOME: home },
    });
    assert.equal(out.source, "managed");
    assert.equal(out.rootDir, expected);
    assert.equal(out.exists, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function fakePrisma(repo: { owner: string; name: string; defaultBranch: string }) {
  return {
    workspace: {
      async findUnique() {
        return {
          opsRepoId: "repo_1",
          opsRepo: repo,
        };
      },
    },
  };
}

// AdDroid OSS — apply-source LocalDirAdsLoader のユニットテスト (regression fix).
//
// loadForApply が AdsLoaderInput.context.headSha / context.repoId を実際に検証
// していること、approved PR の状態と一致しないときに fail-closed (source =
// unavailable, accounts: []) で返すことを確認する。git は呼ばず、`readHeadSha`
// を注入して制御する。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalDirAdsLoader } from "../apply-source.js";
import type { ApplyJobContext } from "@addroid/queue";

// ---- fixture helpers -------------------------------------------------

function writeFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-apply-src-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const VALID_PROJECT = `version: 1
workspace:
  slug: default
  displayName: "Default Workspace"
`;
const VALID_CRON = `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: true
`;
const VALID_BRAND = `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: fall
    name: Fall
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyBudget: 50
`;

const HEAD_SHA = "deadbeefcafebabedeadbeefcafebabedeadbeef";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const PARENT_SHA = "1111111111111111111111111111111111111111";
const REPO_ID = "repo-uuid-1";

function ctx(overrides: Partial<ApplyJobContext> = {}): ApplyJobContext {
  return {
    applyJobId: "apply-1",
    pullRequestId: "pr-row-1",
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeSha: MERGE_SHA,
    htmlUrl: null,
    repoId: REPO_ID,
    ...overrides,
  };
}

function fixtureRepo(): { dir: string; cleanup: () => void } {
  return writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND,
  });
}

function prDiffSeams(parentDir: string) {
  return {
    commitExists: async (_dir: string, sha: string) => sha === MERGE_SHA || sha === PARENT_SHA,
    readParentSha: async (_dir: string, sha: string) => (sha === MERGE_SHA ? PARENT_SHA : null),
    readChangedFiles: async () => ["ads/accounts/primary/brand.yaml"],
    materializeCommit: async (_dir: string, sha: string) => {
      assert.equal(sha, PARENT_SHA);
      return {
        dir: parentDir,
        cleanup: async () => undefined,
      };
    },
  };
}

// ---- happy path -----------------------------------------------------

test("loadForApply loads accounts when repoId and mergeSha both match", async () => {
  const current = fixtureRepo();
  const parent = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(parent.dir),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.equal(out.accounts.length, 1);
    assert.equal(out.accounts[0]!.accountKey, "primary");
    assert.equal(out.accounts[0]!.previous?.account.key, "primary");
  } finally {
    current.cleanup();
    parent.cleanup();
  }
});

// ---- mismatched headSha ---------------------------------------------

test("loadForApply fails closed when mergeSha is missing", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({ context: ctx({ mergeSha: null }) });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /no verified mergeSha/);
  } finally {
    cleanup();
  }
});

test("loadForApply reads an approved PR merge from a materialized commit when main HEAD differs", async () => {
  const current = fixtureRepo();
  const merged = fixtureRepo();
  let cleanedMaterialized = false;
  try {
    const otherSha = "0000000000000000000000000000000000000000";
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => otherSha,
      commitExists: async (_dir, sha) => sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) => (sha === MERGE_SHA ? PARENT_SHA : null),
      readChangedFiles: async () => ["ads/accounts/primary/brand.yaml"],
      materializeCommit: async (_dir, sha) => {
        assert.ok(sha === MERGE_SHA || sha === PARENT_SHA);
        return {
          dir: sha === MERGE_SHA ? merged.dir : current.dir,
          cleanup: async () => {
            cleanedMaterialized = true;
          },
        };
      },
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.equal(out.accounts.length, 1);
    assert.equal(out.accounts[0]!.accountKey, "primary");
    assert.equal(cleanedMaterialized, true);
    assert.match(out.detail ?? "", /approved PR merge/);
  } finally {
    current.cleanup();
    merged.cleanup();
  }
});

test("loadForApply derives previous state from the approved merge parent", async () => {
  const current = fixtureRepo();
  const merged = fixtureRepo();
  const parent = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND.replace("displayName: \"Primary\"", "displayName: \"Previous\""),
  });
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => "0000000000000000000000000000000000000000",
      commitExists: async (_dir, sha) => sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) => (sha === MERGE_SHA ? PARENT_SHA : null),
      readChangedFiles: async () => ["ads/accounts/primary/brand.yaml"],
      materializeCommit: async (_dir, sha) => ({
        dir: sha === PARENT_SHA ? parent.dir : merged.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.equal(out.accounts[0]!.previous?.account.displayName, "Previous");
  } finally {
    current.cleanup();
    merged.cleanup();
    parent.cleanup();
  }
});

test("loadForApply only returns accounts whose brand.yaml changed in the approved merge", async () => {
  const secondaryBrand = VALID_BRAND.replaceAll("primary", "secondary").replace("Primary", "Secondary");
  const current = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND,
    "ads/accounts/secondary/brand.yaml": secondaryBrand,
  });
  const parent = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": VALID_BRAND,
    "ads/accounts/secondary/brand.yaml": secondaryBrand,
  });
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      commitExists: async (_dir, sha) => sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) => (sha === MERGE_SHA ? PARENT_SHA : null),
      readChangedFiles: async () => ["ads/accounts/primary/brand.yaml"],
      materializeCommit: async () => ({
        dir: parent.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.deepEqual(out.accounts.map((a) => a.accountKey), ["primary"]);
  } finally {
    current.cleanup();
    parent.cleanup();
  }
});

test("loadForApply returns unavailable when the approved merge has no brand.yaml changes", async () => {
  const current = fixtureRepo();
  const parent = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      commitExists: async (_dir, sha) => sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) => (sha === MERGE_SHA ? PARENT_SHA : null),
      readChangedFiles: async () => ["README.md"],
      materializeCommit: async () => ({
        dir: parent.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /does not change any ads\/accounts\/\*\/brand.yaml/);
  } finally {
    current.cleanup();
    parent.cleanup();
  }
});

// ---- mismatched repoId ----------------------------------------------

test("loadForApply fails closed when context.repoId differs from configured ops repo", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({
      context: ctx({ repoId: "some-other-repo" }),
    });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /foreign repo state/);
  } finally {
    cleanup();
  }
});

// ---- expectedRepoId not configured ----------------------------------

test("loadForApply fails closed when expectedRepoId is not configured but localDir is set", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: null,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /ops repo id is not configured/);
  } finally {
    cleanup();
  }
});

// ---- localDir is not a git checkout ---------------------------------

test("loadForApply fails closed when git HEAD cannot be resolved", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => null,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /cannot resolve git HEAD/);
  } finally {
    cleanup();
  }
});

// ---- malformed headSha in context -----------------------------------

test("loadForApply fails closed when context.headSha is not a 40-char SHA", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({
      context: ctx({ headSha: "short" }),
    });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /not a 40-char SHA/);
  } finally {
    cleanup();
  }
});

// ---- localDir absent (mocked equivalent path) -----------------------

test("loadForApply returns unavailable (simulated path) when localDir is null", async () => {
  const loader = new LocalDirAdsLoader({
    localDir: null,
    expectedRepoId: REPO_ID,
    readHeadSha: async () => MERGE_SHA,
  });
  const out = await loader.loadForApply({ context: ctx() });
  assert.equal(out.source, "unavailable");
  assert.equal(out.accounts.length, 0);
  assert.match(out.detail ?? "", /ADDROID_OPS_REPO_LOCAL_DIR/);
});

// AdDroid OSS — improvement_pr-runtime のユニットテスト
// (Regression fix).
//
// `createImprovementPrPlanValidator` が gitops 出力を実際の fixture ops repo
// 作業 copy に適用してから `runPlanForRoot` を回し、CLI / `/api/plan` と同等の
// 検証結果を返すことを fixture-based テストで検証する。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createImprovementPrPlanValidator } from "../improvement-pr-runtime.js";

function writeFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-improvement-rt-"));
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
const BASE_BRAND = `version: 1
account:
  key: primary
  displayName: "Primary"
campaigns:
  - id: fall-promo
    name: Fall Promo
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyUsd: 50
`;

test("plan validator returns available=false when rootDir is null", async () => {
  const validator = createImprovementPrPlanValidator({ rootDir: null });
  const out = await validator.validate({ accountKey: "primary", files: [] });
  assert.equal(out.available, false);
  assert.equal(out.ok, false);
  assert.match(out.summary, /ADDROID_OPS_REPO_LOCAL_DIR not set/);
});

test("plan validator returns available=false when rootDir does not exist", async () => {
  const validator = createImprovementPrPlanValidator({
    rootDir: "/nonexistent/path/addroid-test-missing",
  });
  const out = await validator.validate({ accountKey: "primary", files: [] });
  assert.equal(out.available, false);
  assert.equal(out.ok, false);
  assert.match(out.summary, /does not exist/);
});

test("plan validator applies gitops update and runs runPlanForRoot ok", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BASE_BRAND,
  });
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    // gitops outputs a diff that lowers dailyUsd from 50 to 40.
    const newBrand = BASE_BRAND.replace("dailyUsd: 50", "dailyUsd: 40");
    const out = await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "ads/accounts/primary/brand.yaml",
          action: "update",
          diff: newBrand
            .split("\n")
            .map((l) => `+${l}`)
            .join("\n"),
        },
      ],
    });
    assert.equal(out.available, true);
    assert.equal(out.ok, true);
    assert.equal(out.risk, "ok");
    assert.equal(out.errors.length, 0);
    assert.match(out.summary, /plan ok for account=primary/);
    // 元のディレクトリには手を入れない (= 一時ディレクトリで動作する)。
    const stillOriginal = fs.readFileSync(
      path.join(dir, "ads/accounts/primary/brand.yaml"),
      "utf8"
    );
    assert.match(stillOriginal, /dailyUsd: 50/);
  } finally {
    cleanup();
  }
});

test("plan validator surfaces validation errors when applied diff is invalid", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BASE_BRAND,
  });
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    // Flip schema version to a value the Zod schema does not accept.
    const broken = BASE_BRAND.replace("version: 1", "version: 99");
    const out = await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "ads/accounts/primary/brand.yaml",
          action: "update",
          diff: broken
            .split("\n")
            .map((l) => `+${l}`)
            .join("\n"),
        },
      ],
    });
    assert.equal(out.available, true);
    assert.equal(out.ok, false);
    assert.equal(out.risk, "error");
    assert.ok(out.errors.length > 0);
  } finally {
    cleanup();
  }
});

test("plan validator confines unsafe path writes to the working copy", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BASE_BRAND,
  });
  // 一時ディレクトリの外側 (parent dir / ホームディレクトリ等) に
  // diff 内容が書き出されないことを最低限確認する。
  const parentDir = path.dirname(dir);
  const sentinelPath = path.join(parentDir, "addroid-sentinel-leak");
  const before = fs.existsSync(sentinelPath);
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "../addroid-sentinel-leak",
          action: "update",
          diff: "+pwn\n",
        },
      ],
    });
    const after = fs.existsSync(sentinelPath);
    // 親ディレクトリの sentinel は (前後で) 変化しない。
    assert.equal(after, before);
  } finally {
    cleanup();
    // 念のため後始末: ここに到達した時点でリークしていればテストは既に失敗済み。
    if (!before && fs.existsSync(sentinelPath)) {
      fs.rmSync(sentinelPath, { force: true });
    }
  }
});

test("plan validator handles delete action by removing the file", async () => {
  const { dir, cleanup } = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "ads/accounts/primary/brand.yaml": BASE_BRAND,
    "ads/accounts/primary/old-brand.yaml": BASE_BRAND.replace(
      "primary",
      "old-primary"
    ),
  });
  try {
    const validator = createImprovementPrPlanValidator({ rootDir: dir });
    const out = await validator.validate({
      accountKey: "primary",
      files: [
        {
          path: "ads/accounts/primary/old-brand.yaml",
          action: "delete",
          diff: "",
        },
      ],
    });
    // 元のディレクトリから old-brand.yaml は消えていない (作業 copy のみ削除)。
    assert.equal(
      fs.existsSync(path.join(dir, "ads/accounts/primary/old-brand.yaml")),
      true
    );
    // primary account の plan は引き続き走る。
    assert.equal(out.available, true);
  } finally {
    cleanup();
  }
});

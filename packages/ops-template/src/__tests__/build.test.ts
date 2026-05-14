import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildOpsTemplate, OPS_TEMPLATE_DIR } from "../index.js";

const SAMPLE_INPUT = {
  workspaceSlug: "default",
  workspaceDisplayName: "Default Workspace",
  initialAccountKey: "primary",
  initialAccountDisplayName: "Primary Account",
};

test("OPS_TEMPLATE_DIR points at templates/addroid-ops-template", () => {
  assert.equal(
    fs.existsSync(OPS_TEMPLATE_DIR),
    true,
    `expected template dir to exist at ${OPS_TEMPLATE_DIR}`
  );
  assert.match(OPS_TEMPLATE_DIR, /templates[\\/]addroid-ops-template$/);
});

test("buildOpsTemplate emits the required paths", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    ".addroid/project.yaml",
    ".github/workflows/addroid-validate.yml",
    "README.md",
    "ads/accounts/primary/brand.yaml",
    "workflows/automation-rules.yaml",
    "workflows/budget-guard.yaml",
    "workflows/cron.yaml",
  ]);
});

test("buildOpsTemplate substitutes the account-key directory placeholder", () => {
  const files = buildOpsTemplate({
    ...SAMPLE_INPUT,
    initialAccountKey: "acme-co",
  });
  assert.ok(
    files.some((f) => f.path === "ads/accounts/acme-co/brand.yaml"),
    "brand.yaml path should reflect the supplied account key"
  );
  assert.equal(
    files.some((f) => f.path.includes("__account_key__")),
    false,
    "no emitted path should retain the __account_key__ placeholder"
  );
});

test("buildOpsTemplate substitutes content placeholders in project.yaml", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const project = files.find((f) => f.path === ".addroid/project.yaml");
  assert.ok(project);
  assert.match(project!.content, /slug:\s+default/);
  assert.match(project!.content, /displayName:\s+"Default Workspace"/);
  assert.equal(project!.content.includes("{{"), false);
});

test("buildOpsTemplate substitutes content placeholders in brand.yaml", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const brand = files.find((f) => f.path === "ads/accounts/primary/brand.yaml");
  assert.ok(brand);
  assert.match(brand!.content, /key:\s+primary/);
  assert.match(brand!.content, /displayName:\s+"Primary Account"/);
  assert.equal(brand!.content.includes("{{"), false);
});

test("buildOpsTemplate substitutes the README workspace heading", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const readme = files.find((f) => f.path === "README.md");
  assert.ok(readme);
  assert.match(readme!.content, /^# Default Workspace — AdDroid ops repository/);
  assert.equal(readme!.content.includes("{{"), false);
});

test("buildOpsTemplate emits the user-managed cron preset list", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const cron = files.find((f) => f.path === "workflows/cron.yaml");
  assert.ok(cron);
  for (const name of [
    "daily_report",
    "today_report",
    "improvement_pr",
    "auto_creative_generation",
  ]) {
    assert.ok(
      cron!.content.includes(`name: ${name}`),
      `cron.yaml should contain preset '${name}'`
    );
  }
  assert.equal(cron!.content.includes("name: github_poll"), false);
});

test("buildOpsTemplate emits the validate workflow on PR paths", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const wf = files.find((f) => f.path === ".github/workflows/addroid-validate.yml");
  assert.ok(wf);
  assert.match(wf!.content, /name: addroid-validate/);
  assert.match(wf!.content, /pull_request:/);
  assert.match(wf!.content, /"ads\/\*\*"/);
});

test("buildOpsTemplate workflow runs a self-contained structural check without depending on @addroid/cli", () => {
  // 外部 ops repo は単体で `git clone` されるため、ここで `npx --yes addroid-cli` のような
  // 解決不能な CLI 依存を埋め込んではいけない。代わりに Node + js-yaml の構造検証を
  // workflow 内に閉じて持つ (本格的な Zod 検証はサーバーサイド worker が再実行する)。
  const files = buildOpsTemplate(SAMPLE_INPUT);
  const wf = files.find((f) => f.path === ".github/workflows/addroid-validate.yml");
  assert.ok(wf);
  assert.equal(
    /npx[^\n]*addroid-cli/.test(wf!.content),
    false,
    "workflow must not depend on resolving the private @addroid/cli package via npx"
  );
  assert.match(wf!.content, /js-yaml@/);
  assert.match(wf!.content, /Structural check \(project\.yaml, cron\.yaml, brand\.yaml\)/);
  assert.match(wf!.content, /\.addroid\/project\.yaml/);
  assert.match(wf!.content, /workflows\/cron\.yaml/);
  assert.match(wf!.content, /ads\/accounts/);
});

test("buildOpsTemplate result mirrors the on-disk template tree shape", () => {
  const files = buildOpsTemplate(SAMPLE_INPUT);
  // 各 source ファイルが output に1対1で対応する (account_key 部分を除く)。
  const onDisk = listTemplateFilesForTest(OPS_TEMPLATE_DIR);
  assert.equal(files.length, onDisk.length);
});

function listTemplateFilesForTest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(next);
    }
  };
  walk(root);
  return out;
}

// AdDroid OSS — AddroidConfigSchema unit test。
//
// the current implementation で workspace.executionMode を schema に追加した。本テストは:
//   - 旧スキーマ (workspace.{slug,displayName} のみ) でも parse 成功し、
//     既定値 "proposal" が補完されること
//   - 既知の mode 値 ("report_only" | "proposal" | "auto_apply") を受理すること
//   - 未知の文字列は parse エラーになること
//   - `defaultAddroidConfig()` が executionMode="proposal" を返すこと

import test from "node:test";
import assert from "node:assert/strict";

import {
  AddroidConfigSchema,
  ExecutionModeSchema,
  defaultAddroidConfig,
} from "../config.js";

test("AddroidConfigSchema: 旧スキーマ (executionMode 未指定) で proposal が補完される", () => {
  const r = AddroidConfigSchema.safeParse({
    version: 1,
    workspace: { slug: "default", displayName: "Default Workspace" },
    database: { urlRef: ".env.local" },
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal(r.data.workspace.executionMode, "proposal");
  }
});

test("AddroidConfigSchema: 既知の mode 値を受理する", () => {
  for (const mode of ["report_only", "proposal", "auto_apply"] as const) {
    const r = AddroidConfigSchema.safeParse({
      version: 1,
      workspace: {
        slug: "default",
        displayName: "Default Workspace",
        executionMode: mode,
      },
      database: { urlRef: ".env.local" },
    });
    assert.equal(r.success, true, `expected ${mode} to be accepted`);
    if (r.success) {
      assert.equal(r.data.workspace.executionMode, mode);
    }
  }
});

test("AddroidConfigSchema: 未知の mode 文字列は parse エラーになる", () => {
  const r = AddroidConfigSchema.safeParse({
    version: 1,
    workspace: {
      slug: "default",
      displayName: "Default Workspace",
      executionMode: "yolo_mode",
    },
    database: { urlRef: ".env.local" },
  });
  assert.equal(r.success, false);
});

test("ExecutionModeSchema: 既知/未知の値を判別する", () => {
  assert.equal(ExecutionModeSchema.safeParse("report_only").success, true);
  assert.equal(ExecutionModeSchema.safeParse("proposal").success, true);
  assert.equal(ExecutionModeSchema.safeParse("auto_apply").success, true);
  assert.equal(ExecutionModeSchema.safeParse("PROPOSAL").success, false);
  assert.equal(ExecutionModeSchema.safeParse("").success, false);
});

test("defaultAddroidConfig: workspace.executionMode は 'proposal'", () => {
  const cfg = defaultAddroidConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.workspace.executionMode, "proposal");
});

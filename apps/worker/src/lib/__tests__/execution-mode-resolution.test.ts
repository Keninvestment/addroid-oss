// AdDroid OSS — apps/worker/src/lib/execution-mode-resolution.ts unit test
//.
//
// 目的:
//   - workspace mode と ad_account.modeOverride の優先解決が
//     "override > workspace > fail-closed (report_only)" の順で正しく動くこと
//   - 既知の値はそのまま `ExecutionMode` として返すこと
//   - 不正な値 (古い null / 想定外の文字列) は黙って "proposal" に倒さず、
//     workspace 値があればそれ、無ければ "report_only" にフォールバックすること

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeExecutionMode,
  resolveExecutionMode,
} from "../execution-mode-resolution.js";

// ---------------------------------------------------------------------
// normalizeExecutionMode
// ---------------------------------------------------------------------

test("normalizeExecutionMode: 既知の値はそのまま返す", () => {
  assert.equal(normalizeExecutionMode("report_only"), "report_only");
  assert.equal(normalizeExecutionMode("proposal"), "proposal");
  assert.equal(normalizeExecutionMode("auto_apply"), "auto_apply");
});

test("normalizeExecutionMode: null/undefined/未知文字列は null を返す", () => {
  assert.equal(normalizeExecutionMode(null), null);
  assert.equal(normalizeExecutionMode(undefined), null);
  assert.equal(normalizeExecutionMode(""), null);
  assert.equal(normalizeExecutionMode("PROPOSAL"), null);
  assert.equal(normalizeExecutionMode("yolo_mode"), null);
  assert.equal(normalizeExecutionMode(42), null);
});

// ---------------------------------------------------------------------
// resolveExecutionMode
// ---------------------------------------------------------------------

test("resolveExecutionMode: account override が指定されていればそれを使う", () => {
  assert.equal(resolveExecutionMode("proposal", "report_only"), "report_only");
  assert.equal(resolveExecutionMode("proposal", "auto_apply"), "auto_apply");
  assert.equal(resolveExecutionMode("auto_apply", "report_only"), "report_only");
});

test("resolveExecutionMode: account override が null/未指定なら workspace mode を使う", () => {
  assert.equal(resolveExecutionMode("report_only", null), "report_only");
  assert.equal(resolveExecutionMode("proposal", null), "proposal");
  assert.equal(resolveExecutionMode("auto_apply", undefined), "auto_apply");
});

test("resolveExecutionMode: account override が未知文字列なら workspace に倒す", () => {
  assert.equal(resolveExecutionMode("proposal", "yolo"), "proposal");
  assert.equal(resolveExecutionMode("auto_apply", ""), "auto_apply");
});

test("resolveExecutionMode: workspace mode が不正なら fail-closed で report_only", () => {
  assert.equal(resolveExecutionMode(null, null), "report_only");
  assert.equal(resolveExecutionMode("garbage", null), "report_only");
  assert.equal(resolveExecutionMode(undefined, undefined), "report_only");
});

test("resolveExecutionMode: account override が有効なら workspace 不正でも override が勝つ", () => {
  assert.equal(resolveExecutionMode(null, "auto_apply"), "auto_apply");
  assert.equal(resolveExecutionMode("garbage", "report_only"), "report_only");
});

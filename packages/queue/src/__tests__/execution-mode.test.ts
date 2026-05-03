// AdDroid OSS — execution mode + approval policy gate tests (implementation item).
//
// `evaluateApprovalPolicy` と `combineApproval*` の純粋関数挙動を網羅する。
// LLM や Prisma 依存はないため completely in-process。

import test from "node:test";
import assert from "node:assert/strict";
import {
  combineApprovalClassifications,
  combineApprovalDecisions,
  evaluateApprovalPolicy,
  isDangerousCategory,
  unionDangerousCategories,
} from "../index.js";

// ---------------------------------------------------------------------
// isDangerousCategory
// ---------------------------------------------------------------------

test("isDangerousCategory recognises the 5 defined dangerous categories", () => {
  assert.equal(isDangerousCategory("budget_increase"), true);
  assert.equal(isDangerousCategory("new_campaign"), true);
  assert.equal(isDangerousCategory("targeting_change"), true);
  assert.equal(isDangerousCategory("monthly_budget_change"), true);
  assert.equal(isDangerousCategory("automation_rule_change"), true);
});

test("isDangerousCategory returns false for ordinary categories", () => {
  assert.equal(isDangerousCategory("copy_update"), false);
  assert.equal(isDangerousCategory("auto_pause"), false);
  assert.equal(isDangerousCategory(""), false);
  assert.equal(isDangerousCategory("Budget_Increase"), false); // case-sensitive
});

// ---------------------------------------------------------------------
// evaluateApprovalPolicy — empty candidates
// ---------------------------------------------------------------------

test("evaluateApprovalPolicy: empty candidates → auto_approved/safe in any mode", () => {
  for (const mode of ["report_only", "proposal", "auto_apply"] as const) {
    const r = evaluateApprovalPolicy({
      mode,
      candidates: [],
      safeCategories: [],
    });
    assert.equal(r.decision, "auto_approved", `mode=${mode}`);
    assert.equal(r.classification, "safe", `mode=${mode}`);
    assert.deepEqual(r.dangerousCategories, []);
  }
});

// ---------------------------------------------------------------------
// evaluateApprovalPolicy — dangerous categories
// ---------------------------------------------------------------------

test("evaluateApprovalPolicy: dangerous category in proposal mode → approval_required/dangerous", () => {
  const r = evaluateApprovalPolicy({
    mode: "proposal",
    candidates: [{ category: "budget_increase" }],
    safeCategories: [],
  });
  assert.equal(r.decision, "approval_required");
  assert.equal(r.classification, "dangerous");
  assert.deepEqual(r.dangerousCategories, ["budget_increase"]);
  assert.match(r.reasons.join(" "), /dangerous/);
});

test("evaluateApprovalPolicy: dangerous in auto_apply still requires approval", () => {
  // 契約: "Dangerous changes ... require PR approval" (regardless of mode).
  const r = evaluateApprovalPolicy({
    mode: "auto_apply",
    candidates: [{ category: "new_campaign" }],
    safeCategories: ["new_campaign"], // even if user lists it, auto_approved is forbidden
  });
  assert.equal(r.decision, "approval_required");
  assert.equal(r.classification, "dangerous");
  assert.deepEqual(r.dangerousCategories, ["new_campaign"]);
});

test("evaluateApprovalPolicy: dangerous in report_only → auto_blocked", () => {
  const r = evaluateApprovalPolicy({
    mode: "report_only",
    candidates: [{ category: "targeting_change" }],
    safeCategories: [],
  });
  assert.equal(r.decision, "auto_blocked");
  assert.equal(r.classification, "dangerous");
  assert.deepEqual(r.dangerousCategories, ["targeting_change"]);
});

test("evaluateApprovalPolicy: mixed dangerous + safe → approval_required + dedup dangerous list", () => {
  const r = evaluateApprovalPolicy({
    mode: "proposal",
    candidates: [
      { category: "copy_update" },
      { category: "budget_increase" },
      { category: "budget_increase" }, // duplicate
      { category: "new_campaign" },
    ],
    safeCategories: ["copy_update"],
  });
  assert.equal(r.decision, "approval_required");
  assert.equal(r.classification, "dangerous");
  assert.deepEqual(r.dangerousCategories, ["budget_increase", "new_campaign"]);
});

// ---------------------------------------------------------------------
// evaluateApprovalPolicy — report_only
// ---------------------------------------------------------------------

test("evaluateApprovalPolicy: report_only with non-dangerous candidates → auto_blocked", () => {
  const r = evaluateApprovalPolicy({
    mode: "report_only",
    candidates: [{ category: "copy_update" }, { category: "auto_pause" }],
    safeCategories: ["copy_update", "auto_pause"], // safe list ignored in report_only
  });
  assert.equal(r.decision, "auto_blocked");
  assert.equal(r.classification, "requires_approval");
  assert.deepEqual(r.dangerousCategories, []);
  assert.match(r.reasons.join(" "), /report_only/);
});

// ---------------------------------------------------------------------
// evaluateApprovalPolicy — proposal
// ---------------------------------------------------------------------

test("evaluateApprovalPolicy: proposal with non-dangerous candidates → approval_required", () => {
  const r = evaluateApprovalPolicy({
    mode: "proposal",
    candidates: [{ category: "copy_update" }],
    safeCategories: ["copy_update"], // safe list ignored in proposal
  });
  assert.equal(r.decision, "approval_required");
  assert.equal(r.classification, "requires_approval");
  assert.deepEqual(r.dangerousCategories, []);
});

// ---------------------------------------------------------------------
// evaluateApprovalPolicy — auto_apply
// ---------------------------------------------------------------------

test("evaluateApprovalPolicy: auto_apply + all categories in safeCategories → auto_approved", () => {
  const r = evaluateApprovalPolicy({
    mode: "auto_apply",
    candidates: [{ category: "copy_update" }, { category: "auto_pause" }],
    safeCategories: ["copy_update", "auto_pause"],
  });
  assert.equal(r.decision, "auto_approved");
  assert.equal(r.classification, "safe");
  assert.deepEqual(r.dangerousCategories, []);
});

test("evaluateApprovalPolicy: auto_apply + missing category → approval_required", () => {
  const r = evaluateApprovalPolicy({
    mode: "auto_apply",
    candidates: [{ category: "copy_update" }, { category: "auto_pause" }],
    safeCategories: ["copy_update"], // auto_pause not listed
  });
  assert.equal(r.decision, "approval_required");
  assert.equal(r.classification, "requires_approval");
  assert.match(r.reasons.join(" "), /auto_pause/);
});

test("evaluateApprovalPolicy: auto_apply + empty safeCategories → approval_required", () => {
  const r = evaluateApprovalPolicy({
    mode: "auto_apply",
    candidates: [{ category: "copy_update" }],
    safeCategories: [],
  });
  assert.equal(r.decision, "approval_required");
  assert.equal(r.classification, "requires_approval");
});

// ---------------------------------------------------------------------
// combineApprovalDecisions — fail-closed
// ---------------------------------------------------------------------

test("combineApprovalDecisions: strictest wins (auto_blocked > approval_required > auto_approved)", () => {
  // identity
  assert.equal(combineApprovalDecisions("auto_approved", "auto_approved"), "auto_approved");
  assert.equal(
    combineApprovalDecisions("approval_required", "approval_required"),
    "approval_required"
  );
  assert.equal(combineApprovalDecisions("auto_blocked", "auto_blocked"), "auto_blocked");
  // policy more strict than AI
  assert.equal(
    combineApprovalDecisions("auto_approved", "approval_required"),
    "approval_required"
  );
  assert.equal(combineApprovalDecisions("auto_approved", "auto_blocked"), "auto_blocked");
  assert.equal(
    combineApprovalDecisions("approval_required", "auto_blocked"),
    "auto_blocked"
  );
  // AI more strict than policy
  assert.equal(
    combineApprovalDecisions("approval_required", "auto_approved"),
    "approval_required"
  );
  assert.equal(combineApprovalDecisions("auto_blocked", "auto_approved"), "auto_blocked");
  assert.equal(
    combineApprovalDecisions("auto_blocked", "approval_required"),
    "auto_blocked"
  );
});

test("combineApprovalClassifications: strictest wins (dangerous > requires_approval > safe)", () => {
  assert.equal(combineApprovalClassifications("safe", "safe"), "safe");
  assert.equal(
    combineApprovalClassifications("safe", "requires_approval"),
    "requires_approval"
  );
  assert.equal(combineApprovalClassifications("safe", "dangerous"), "dangerous");
  assert.equal(
    combineApprovalClassifications("requires_approval", "dangerous"),
    "dangerous"
  );
  assert.equal(
    combineApprovalClassifications("dangerous", "safe"),
    "dangerous"
  );
});

// ---------------------------------------------------------------------
// unionDangerousCategories
// ---------------------------------------------------------------------

test("unionDangerousCategories: dedup and preserve insertion order, ignore empties", () => {
  assert.deepEqual(
    unionDangerousCategories(["budget_increase"], ["new_campaign", "budget_increase"]),
    ["budget_increase", "new_campaign"]
  );
  assert.deepEqual(unionDangerousCategories([], []), []);
  assert.deepEqual(unionDangerousCategories(["x"], [""]), ["x"]);
});

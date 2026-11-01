import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@addroid/db";
import { createApplyJobStore } from "../prisma-stores.js";

test("apply store claims queued jobs with a conditional database update", async () => {
  let state = "queued";
  const updates: unknown[] = [];
  const prisma = {
    applyJob: {
      findUnique: async () => ({ state }),
      updateMany: async (input: { where: { id: string; state: string }; data: { state: string } }) => {
        updates.push(input);
        if (state !== input.where.state) return { count: 0 };
        state = input.data.state;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const store = createApplyJobStore(prisma, "workspace-1");
  assert.equal(await store.findApplyJobState("apply-1"), "queued");
  assert.deepEqual(await Promise.all([
    store.markApplyRunning({ applyJobId: "apply-1" }),
    store.markApplyRunning({ applyJobId: "apply-1" }),
  ]), [true, false]);
  for (const update of updates) {
    assert.deepEqual((update as { where: unknown }).where, { id: "apply-1", state: "queued" });
  }
  assert.equal(state, "running");
});

test("apply store quarantines only running jobs and preserves terminal results", async () => {
  let state = "running";
  let result: unknown;
  let errorMessage: string | undefined;
  const prisma = {
    applyJob: {
      updateMany: async (input: {
        where: { id: string; state: string };
        data: { state: string; result: unknown; errorMessage: string };
      }) => {
        assert.deepEqual(input.where, { id: "apply-1", state: "running" });
        if (state !== input.where.state) return { count: 0 };
        state = input.data.state;
        result = input.data.result;
        errorMessage = input.data.errorMessage;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const store = createApplyJobStore(prisma, "workspace-1");
  await store.quarantineUncertainApply({ applyJobId: "apply-1" });
  assert.equal(state, "failed");
  assert.match(errorMessage!, /uncertain_previous_attempt/);
  assert.deepEqual(result, { reason: "uncertain_previous_attempt", needsReview: true });
  state = "succeeded";
  result = { applied: true };
  await store.quarantineUncertainApply({ applyJobId: "apply-1" });
  assert.equal(state, "succeeded");
  assert.deepEqual(result, { applied: true });
});

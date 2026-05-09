import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrReuseAgentTask,
  normalizeAgentTaskPrompt,
  type AgentTaskRow,
} from "../agent-task-store.js";

test("normalizeAgentTaskPrompt collapses whitespace", () => {
  assert.equal(
    normalizeAgentTaskPrompt("  前日分の日次レポートを\n作成して  要約する "),
    "前日分の日次レポートを 作成して 要約する"
  );
});

test("createOrReuseAgentTask reuses an enabled task with equivalent prompt and cron", async () => {
  const existing: AgentTaskRow = {
    id: "task_1",
    title: "毎朝9時の日次レポート",
    prompt: "前日分の日次レポートを作成して要約する",
    cron: "0 9 * * *",
    enabled: true,
    nextRunAt: new Date("2026-05-10T00:00:00.000Z"),
  };
  const prisma = fakePrisma([existing]);
  const out = await createOrReuseAgentTask(prisma, {
    workspaceId: "ws_1",
    title: "毎朝9時の日次レポート",
    prompt: " 前日分の日次レポートを作成して要約する ",
    cron: "0 9 * * *",
    nextRunAt: new Date("2026-05-11T00:00:00.000Z"),
    createdBy: "agent:test",
  });
  assert.equal(out.created, false);
  assert.equal(out.task.id, "task_1");
  assert.equal(prisma.created.length, 0);
});

test("createOrReuseAgentTask creates when no enabled equivalent exists", async () => {
  const prisma = fakePrisma([]);
  const out = await createOrReuseAgentTask(prisma, {
    workspaceId: "ws_1",
    title: "毎朝9時の日次レポート",
    prompt: "前日分の日次レポートを作成して要約する",
    cron: "0 9 * * *",
    nextRunAt: new Date("2026-05-10T00:00:00.000Z"),
    createdBy: "agent:test",
  });
  assert.equal(out.created, true);
  assert.equal(out.task.prompt, "前日分の日次レポートを作成して要約する");
  assert.equal(prisma.created.length, 1);
});

function fakePrisma(seed: AgentTaskRow[]) {
  const rows = [...seed];
  const created: unknown[] = [];
  return {
    created,
    agentTask: {
      async findMany() {
        return rows;
      },
      async create(args: unknown) {
        created.push(args);
        const data = (args as { data: Record<string, unknown> }).data;
        const row: AgentTaskRow = {
          id: `task_${rows.length + 1}`,
          title: String(data.title),
          prompt: String(data.prompt),
          cron: String(data.cron),
          enabled: true,
          nextRunAt: data.nextRunAt as Date,
        };
        rows.push(row);
        return row;
      },
    },
  };
}

export interface AgentTaskRow {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  nextRunAt: Date | null;
}

export interface AgentTaskStorePrisma {
  agentTask: {
    findMany(args: unknown): Promise<AgentTaskRow[]>;
    create(args: unknown): Promise<AgentTaskRow>;
  };
}

export interface CreateOrReuseAgentTaskInput {
  workspaceId: string;
  title: string;
  prompt: string;
  cron: string;
  nextRunAt: Date;
  createdBy: string;
}

export interface CreateOrReuseAgentTaskResult {
  task: AgentTaskRow;
  created: boolean;
}

export async function createOrReuseAgentTask(
  prisma: AgentTaskStorePrisma,
  input: CreateOrReuseAgentTaskInput
): Promise<CreateOrReuseAgentTaskResult> {
  const prompt = normalizeAgentTaskPrompt(input.prompt);
  const cron = input.cron.trim();
  const existing = await findEquivalentEnabledAgentTask(prisma, {
    workspaceId: input.workspaceId,
    prompt,
    cron,
  });
  if (existing) return { task: existing, created: false };
  const task = await prisma.agentTask.create({
    data: {
      workspaceId: input.workspaceId,
      title: input.title.trim() || deriveAgentTaskTitle(prompt),
      prompt,
      cron,
      enabled: true,
      nextRunAt: input.nextRunAt,
      createdBy: input.createdBy,
    },
    select: agentTaskSelect(),
  });
  return { task, created: true };
}

export async function findEquivalentEnabledAgentTask(
  prisma: AgentTaskStorePrisma,
  input: { workspaceId: string; prompt: string; cron: string }
): Promise<AgentTaskRow | null> {
  const prompt = normalizeAgentTaskPrompt(input.prompt);
  const cron = input.cron.trim();
  const candidates = await prisma.agentTask.findMany({
    where: {
      workspaceId: input.workspaceId,
      cron,
      enabled: true,
    },
    orderBy: { createdAt: "asc" },
    select: agentTaskSelect(),
  });
  return (
    candidates.find((task) => normalizeAgentTaskPrompt(task.prompt) === prompt) ??
    null
  );
}

export function normalizeAgentTaskPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function deriveAgentTaskTitle(prompt: string): string {
  const first = normalizeAgentTaskPrompt(prompt);
  return first.length <= 40 ? first : `${first.slice(0, 39)}…`;
}

function agentTaskSelect() {
  return {
    id: true,
    title: true,
    prompt: true,
    cron: true,
    enabled: true,
    nextRunAt: true,
  };
}

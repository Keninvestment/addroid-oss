import type { SlackCommandBoss } from "./slack-command.js";

export const SLACK_AGENT_JOB_NAME = "slack_agent" as const;

export type SlackAgentEventType = "app_mention" | "message.im" | "message.file_share";

export interface SlackAgentFileReference {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
}

export interface SlackAgentJobPayload {
  text: string;
  slackUserId: string;
  slackUserName?: string;
  slackChannelId: string;
  slackTeamId?: string;
  threadTs: string;
  eventTs: string;
  eventType: SlackAgentEventType;
  files?: SlackAgentFileReference[];
  enqueuedAt: string;
}

export interface EnqueueSlackAgentJobOptions {
  boss: SlackCommandBoss;
  payload: Omit<SlackAgentJobPayload, "enqueuedAt">;
  singletonKey?: string;
  now?: () => Date;
}

export interface EnqueueSlackAgentJobResult {
  jobId: string | null;
  singletonKey: string;
  payload: SlackAgentJobPayload;
}

export function buildSlackAgentSingletonKey(
  payload: Omit<SlackAgentJobPayload, "enqueuedAt">
): string {
  const team = payload.slackTeamId?.trim() || "team";
  const channel = payload.slackChannelId.trim() || "channel";
  const ts = payload.eventTs.trim() || payload.threadTs.trim() || "event";
  return `slack_agent:${team}:${channel}:${ts}`;
}

export async function enqueueSlackAgentJob(
  opts: EnqueueSlackAgentJobOptions
): Promise<EnqueueSlackAgentJobResult> {
  const payload: SlackAgentJobPayload = {
    ...opts.payload,
    enqueuedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  const singletonKey = opts.singletonKey ?? buildSlackAgentSingletonKey(opts.payload);
  const jobId = await opts.boss.send(SLACK_AGENT_JOB_NAME, payload, {
    singletonKey,
  });
  return { jobId, singletonKey, payload };
}

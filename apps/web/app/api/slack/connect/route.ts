import { NextResponse } from "next/server";
import { Prisma } from "@addroid/db";
import {
  buildSlackInstallationMetadata,
  getCryptoBoundary,
  openSocketModeConnection,
  postSlackMessage,
  SlackApiError,
  validateSlackInputs,
  verifyBotToken,
} from "@addroid/config";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../lib/github-runtime";

export const dynamic = "force-dynamic";

interface Body {
  botToken?: unknown;
  appToken?: unknown;
  channelId?: unknown;
  sendTestMessage?: unknown;
}

const TEST_MESSAGE =
  "AdDroid 接続テスト — Web UI から Slack 接続を保存しました。";

type SlackConnectStage =
  | "prepare"
  | "workspace"
  | "auth.test"
  | "apps.connections.open"
  | "chat.postMessage"
  | "persist"
  | "audit";

function slackConnectErrorPayload(stage: SlackConnectStage, err: unknown) {
  const message = (err as Error).message || "unknown error";
  if (err instanceof SlackApiError) {
    const suffix = err.slackError ? ` (${err.slackError})` : "";
    return {
      ok: false,
      stage,
      error: `${stage} に失敗しました${suffix}: ${message}`,
      slackError: err.slackError,
      httpStatus: err.status,
    };
  }
  return { ok: false, stage, error: `${stage} に失敗しました: ${message}` };
}

function logSlackConnectFailure(stage: SlackConnectStage, err: unknown) {
  if (err instanceof SlackApiError) {
    console.error("[slack-connect] failed", {
      stage,
      endpoint: err.endpoint,
      httpStatus: err.status,
      slackError: err.slackError,
      message: err.message,
    });
    return;
  }
  console.error("[slack-connect] failed", {
    stage,
    name: (err as Error).name,
    message: (err as Error).message,
  });
}

export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }

  let normalized;
  try {
    normalized = validateSlackInputs({
      botToken: typeof payload.botToken === "string" ? payload.botToken : "",
      appToken: typeof payload.appToken === "string" ? payload.appToken : "",
      notificationChannelId:
        typeof payload.channelId === "string" ? payload.channelId : "",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 }
    );
  }

  let stage: SlackConnectStage = "prepare";
  try {
    const crypto = getCryptoBoundary(process.env);
    stage = "workspace";
    const workspace = await ensureWebWorkspace();
    stage = "auth.test";
    const authTest = await verifyBotToken(normalized.botToken);
    stage = "apps.connections.open";
    await openSocketModeConnection(normalized.appToken);
    let testMessageOkAt: Date | null = null;
    if (payload.sendTestMessage === true) {
      stage = "chat.postMessage";
      await postSlackMessage(
        normalized.botToken,
        normalized.notificationChannelId,
        TEST_MESSAGE
      );
      testMessageOkAt = new Date();
    }
    const connectedAt = new Date();
    const metadata = buildSlackInstallationMetadata({
      authTest,
      notificationChannelId: normalized.notificationChannelId,
      socketModeOkAt: connectedAt,
      testMessageOkAt,
    }) as unknown as Prisma.InputJsonValue;
    stage = "persist";
    await prisma.oAuthToken.upsert({
      where: {
        provider_accountIdentifier: {
          provider: "slack",
          accountIdentifier: authTest.team_id,
        },
      },
      update: {
        scopes: ["bot", "socket_mode"],
        accessTokenCiphertext: crypto.encrypt(normalized.botToken),
        refreshTokenCiphertext: crypto.encrypt(normalized.appToken),
        expiresAt: null,
        connectedAt,
        metadata,
      },
      create: {
        provider: "slack",
        accountIdentifier: authTest.team_id,
        scopes: ["bot", "socket_mode"],
        accessTokenCiphertext: crypto.encrypt(normalized.botToken),
        refreshTokenCiphertext: crypto.encrypt(normalized.appToken),
        expiresAt: null,
        connectedAt,
        metadata,
      },
    });
    stage = "audit";
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:slack-ui",
        action: "oauth.slack.connected_via_web",
        target: `oauth_tokens:slack:${authTest.team_id}`,
        ref: authTest.team_id,
        metadata: {
          teamId: authTest.team_id,
          teamName: authTest.team,
          botUserId: authTest.user_id,
          notificationChannelId: normalized.notificationChannelId,
          testMessageSent: testMessageOkAt !== null,
        },
      },
    });
    return NextResponse.json({
      ok: true,
      teamId: authTest.team_id,
      teamName: authTest.team,
      notificationChannelId: normalized.notificationChannelId,
      connectedAt: connectedAt.toISOString(),
      testMessageSent: testMessageOkAt !== null,
    });
  } catch (err) {
    logSlackConnectFailure(stage, err);
    return NextResponse.json(
      slackConnectErrorPayload(stage, err),
      { status: 502 }
    );
  }
}

export async function DELETE() {
  try {
    const workspace = await ensureWebWorkspace();
    const result = await prisma.oAuthToken.deleteMany({ where: { provider: "slack" } });
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:slack-ui",
        action: "oauth.slack.disconnected_via_web",
        target: "oauth_tokens:slack",
        ref: "slack",
        metadata: { removed: result.count },
      },
    });
    return NextResponse.json({ ok: true, removed: result.count });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

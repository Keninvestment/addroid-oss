import { NextResponse } from "next/server";
import { Prisma } from "@addroid/db";
import {
  buildSlackInstallationMetadata,
  getCryptoBoundary,
  openSocketModeConnection,
  postSlackMessage,
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

  try {
    const crypto = getCryptoBoundary(process.env);
    const workspace = await ensureWebWorkspace();
    const [authTest] = await Promise.all([
      verifyBotToken(normalized.botToken),
      openSocketModeConnection(normalized.appToken),
    ]);
    let testMessageOkAt: Date | null = null;
    if (payload.sendTestMessage === true) {
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
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
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

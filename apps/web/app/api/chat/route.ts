import { NextResponse } from "next/server";
import path from "node:path";
import { LocalDiskStorage } from "@addroid/config";
import {
  listWebChatSessions,
  loadWebChatSessionMessages,
  runWebAgentChat,
} from "../../../lib/agent-chat";
import { requireTrustedWebAction } from "../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  input?: unknown;
  sessionId?: unknown;
  surface?: unknown;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) {
    const result = await loadWebChatSessionMessages(sessionId).catch((err) => ({
      ok: false,
      error: (err as Error).message,
    }));
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json({ ok: true, ...result });
  }
  const sessions = await listWebChatSessions({
    surface: url.searchParams.get("surface"),
    limit: Number.parseInt(url.searchParams.get("limit") ?? "30", 10),
  });
  return NextResponse.json({ ok: true, sessions });
}

export async function POST(request: Request) {
  const denied = requireTrustedWebAction(request, {
    allowedMediaTypes: ["application/json", "multipart/form-data"],
  });
  if (denied) return denied;

  const parsed = await parseChatRequest(request).catch((err) => ({
    error: (err as Error).message,
  }));
  if ("error" in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const input = parsed.input;
  const result = await runWebAgentChat(input, {
    userInput: parsed.userInput,
    referenceImagePaths: parsed.referenceImagePaths,
    sessionId: parsed.sessionId,
    surface: parsed.surface,
  }).catch((err) => ({
    ok: false,
    message: "",
    executions: [],
    error: (err as Error).message,
  }));
  if ("error" in result) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

async function parseChatRequest(request: Request): Promise<{
  input: string;
  userInput: string;
  referenceImagePaths?: string[];
  sessionId?: string;
  surface?: string;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const rawInput = form.get("input");
    const rawContext = form.get("contextPrefix");
    const rawSessionId = form.get("sessionId");
    const rawSurface = form.get("surface");
    const input = typeof rawInput === "string" ? rawInput : "";
    const contextPrefix = typeof rawContext === "string" ? rawContext : "";
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    const storedPaths = await storeChatAttachments(files);
    const attachmentContext = storedPaths.length > 0
      ? [
          "",
          "添付素材はサーバー側で以下のローカルパスに保存済みです。",
          "参考画像として新しい画像生成に使う場合は referenceImagePaths にこの配列をそのまま指定してください。",
          "添付そのものを最終広告素材として入稿する場合だけ localMediaPaths に指定してください。",
          JSON.stringify(storedPaths),
        ].join("\n")
      : "";
    return {
      input: [contextPrefix, input, attachmentContext].filter(Boolean).join("\n\n"),
      userInput: input,
      referenceImagePaths: storedPaths,
      sessionId: typeof rawSessionId === "string" ? rawSessionId : undefined,
      surface: typeof rawSurface === "string" ? rawSurface : undefined,
    };
  }
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    throw new Error("Request body must be JSON or multipart/form-data.");
  }
  const input = typeof payload.input === "string" ? payload.input : "";
  return {
    input,
    userInput: input,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    surface: typeof payload.surface === "string" ? payload.surface : undefined,
  };
}

async function storeChatAttachments(files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const storage = new LocalDiskStorage({ env: process.env });
  await storage.ensureRoot();
  const dir = `creative-chat-uploads/${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const paths: string[] = [];
  for (const file of files) {
    const safe = safeFilename(file.name);
    const key = `${dir}/${safe}`;
    const written = await storage.write(key, new Uint8Array(await file.arrayBuffer()));
    paths.push(written.path);
  }
  return paths;
}

function safeFilename(value: string): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!base || base === "." || base === ".." || base.includes(path.sep)) {
    throw new Error(`Invalid attachment filename: ${value}`);
  }
  return base;
}

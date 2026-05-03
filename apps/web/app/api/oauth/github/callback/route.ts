// AdDroid OSS — GitHub OAuth callback endpoint.
//
// 1) adapter.completeOAuth(code, state) で access token を交換し、暗号化境界
//    越しに oauth_tokens に upsert する。state 不一致は CSRF として弾く。
// 2) 既に Workspace.opsRepoId が紐付いていなければ、ops repository を自動的に
//    bootstrap し `persistOpsRepoBootstrap` で github_repos / Workspace.opsRepoId /
//    audit_logs に書き込む (regression fix の acceptance)。
// 3) /github へ ?oauth=connected[&bootstrap=ok|skipped|error&reason=...] 付きで
//    302 リダイレクトし、UI 側でバナー表示する。

import { NextResponse } from "next/server";
import {
  GithubAdapterUnauthenticatedError,
  GithubOAuthStateMismatchError,
} from "@addroid/github-adapter";
import { prisma } from "../../../../../lib/prisma";
import {
  ensureWebWorkspace,
  getActiveGithubAdapter,
  persistOpsRepoBootstrap,
  resolveDesiredOpsRepo,
} from "../../../../../lib/github-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return errorRedirect(url, "Missing code or state in callback URL.");
  }

  try {
    const { adapter } = await getActiveGithubAdapter();
    await adapter.completeOAuth({ code, state });
  } catch (err) {
    const reason =
      err instanceof GithubOAuthStateMismatchError
        ? "OAuth state mismatch (possible CSRF)."
        : (err as Error).message;
    return errorRedirect(url, reason);
  }

  // Auto-bootstrap ops repo if not already linked.
  let bootstrap: "ok" | "skipped" | "error" = "ok";
  let bootstrapReason: string | null = null;
  try {
    const ws = await ensureWebWorkspace();
    const existing = await prisma.workspace.findUnique({
      where: { id: ws.id },
      select: { opsRepoId: true },
    });
    if (existing?.opsRepoId) {
      bootstrap = "skipped";
    } else {
      const desired = await resolveDesiredOpsRepo();
      const { adapter } = await getActiveGithubAdapter();
      const result = await adapter.bootstrapOpsRepo({
        workspaceSlug: desired.workspaceSlug,
        workspaceDisplayName: desired.workspaceDisplayName,
        initialAccountKey: "default",
        initialAccountDisplayName: "Default Account",
        desiredName: desired.desiredName,
        defaultBranch: desired.defaultBranch,
        visibility: "private",
      });
      await persistOpsRepoBootstrap({
        workspaceId: ws.id,
        owner: result.owner,
        name: result.name,
        defaultBranch: result.defaultBranch,
        bootstrappedAt: new Date(result.bootstrappedAt),
        filesCommitted: result.filesCommitted,
        branchProtectionApplied: result.branchProtectionApplied,
      });
    }
  } catch (err) {
    bootstrap = "error";
    bootstrapReason =
      err instanceof GithubAdapterUnauthenticatedError
        ? "Adapter is not authenticated even after OAuth completed."
        : (err as Error).message;
  }

  const next = new URL("/github", url);
  next.searchParams.set("oauth", "connected");
  next.searchParams.set("bootstrap", bootstrap);
  if (bootstrapReason) next.searchParams.set("reason", bootstrapReason);
  return NextResponse.redirect(next, { status: 302 });
}

function errorRedirect(base: URL, reason: string): NextResponse {
  const next = new URL("/github", base);
  next.searchParams.set("oauth", "error");
  next.searchParams.set("reason", reason);
  return NextResponse.redirect(next, { status: 302 });
}

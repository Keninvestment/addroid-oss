// AdDroid OSS — ops repository bootstrap (manual retry endpoint).
//
// 通常 OAuth callback が自動的に bootstrap するが、その時点で失敗した場合や、
// すでに OAuth は接続済みだが ops repo がまだ無い場合のために、UI から POST で
// 再実行できるようにする。
// ops repo が既に Workspace に紐付いていれば 200 + ok=false で no-op を返し、
// 副作用を伴わない。

import { NextResponse } from "next/server";
import { GithubAdapterUnauthenticatedError } from "@addroid/github-adapter";
import { prisma } from "../../../../lib/prisma";
import {
  ensureWebOpsRepoCheckout,
  ensureWebWorkspace,
  getActiveGithubAdapter,
  persistOpsRepoBootstrap,
  resolveDesiredOpsRepo,
  resolveDefaultOpsTemplateAccount,
} from "../../../../lib/github-runtime";
import { requireTrustedJsonWebAction } from "../../../../lib/request-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const untrustedResponse = requireTrustedJsonWebAction(request);
  if (untrustedResponse) return untrustedResponse;

  try {
    const ws = await ensureWebWorkspace();
    const existing = await prisma.workspace.findUnique({
      where: { id: ws.id },
      select: {
        opsRepoId: true,
        opsRepo: { select: { owner: true, name: true } },
      },
    });
    if (existing?.opsRepoId) {
      const checkout = await ensureWebOpsRepoCheckout(ws.id);
      return NextResponse.json({
        ok: false,
        already: true,
        owner: existing.opsRepo?.owner ?? null,
        name: existing.opsRepo?.name ?? null,
        localDir: checkout.rootDir,
      });
    }
    const desired = await resolveDesiredOpsRepo();
    const account = await resolveDefaultOpsTemplateAccount(ws.id);
    const { adapter, choice } = await getActiveGithubAdapter();
    if (choice === "stub") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "GitHub adapter is not configured. Set ADDROID_GITHUB_OAUTH_MOCK=1 or fill secrets.local.yaml.",
        },
        { status: 400 }
      );
    }
    const result = await adapter.bootstrapOpsRepo({
      workspaceSlug: desired.workspaceSlug,
      workspaceDisplayName: desired.workspaceDisplayName,
      initialAccountKey: account.primary.key,
      initialAccountDisplayName: account.primary.displayName,
      initialAccounts: account.accounts,
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
    const checkout = await ensureWebOpsRepoCheckout(ws.id);
    return NextResponse.json({
      ok: true,
      owner: result.owner,
      name: result.name,
      defaultBranch: result.defaultBranch,
      filesCommitted: result.filesCommitted,
      branchProtectionApplied: result.branchProtectionApplied,
      localDir: checkout.rootDir,
    });
  } catch (err) {
    const status = err instanceof GithubAdapterUnauthenticatedError ? 401 : 500;
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status }
    );
  }
}

import { prisma } from "./prisma";

export function approvalRequiresAction(decision: string | null): boolean {
  return decision === null || decision === "approval_required";
}

export function approvalStateLabel(decision: string | null): string {
  if (decision === "approved") return "承認済み";
  if (decision === "auto_approved") return "自動承認済み";
  if (decision === "approval_required") return "承認が必要";
  if (decision === "auto_blocked") return "自動ブロック";
  if (decision === "rejected") return "却下";
  return "承認が必要";
}

export function approvalStateBadge(
  decision: string | null
): "ok" | "warn" | "error" | "idle" {
  if (decision === "approved" || decision === "auto_approved") return "ok";
  if (decision === "auto_blocked" || decision === "rejected") return "error";
  return "warn";
}

export async function countApprovalRequiredPrs(workspaceId: string): Promise<number> {
  const openPrs = await prisma.githubPullRequest.findMany({
    where: { state: "open", repo: { workspace: { is: { id: workspaceId } } } },
    select: {
      approvalRecords: {
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { decision: true },
      },
    },
  });

  return openPrs.filter((pr) =>
    approvalRequiresAction(pr.approvalRecords[0]?.decision ?? null)
  ).length;
}

import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace, getActiveGithubAdapter } from "../../../../lib/github-runtime";
import {
  createCreativeSubmissionProposal,
  normalizeCreativeSubmissionInput,
  type UploadedCreativeMedia,
} from "../../../../../worker/src/lib/creative-submission-runtime";
import { selectLLMProviderForWorker } from "../../../../../worker/src/lib/llm-runtime";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const workspace = await ensureWebWorkspace();
    const form = await req.formData();
    const uploadedMedia: UploadedCreativeMedia[] = [];
    const uploadedReferenceMedia: UploadedCreativeMedia[] = [];
    for (const value of form.getAll("media")) {
      if (!(value instanceof File) || value.size === 0) continue;
      uploadedMedia.push({
        filename: value.name,
        mimeType: value.type || null,
        bytes: new Uint8Array(await value.arrayBuffer()),
      });
    }
    for (const value of form.getAll("referenceMedia")) {
      if (!(value instanceof File) || value.size === 0) continue;
      uploadedReferenceMedia.push({
        filename: value.name,
        mimeType: value.type || null,
        bytes: new Uint8Array(await value.arrayBuffer()),
      });
    }
    const args: Record<string, unknown> = {
      accountKey: formString(form, "accountKey"),
      creativeName: formString(form, "creativeName"),
      adName: formString(form, "adName"),
      prompt: formString(form, "prompt"),
      headline: formString(form, "headline"),
      primaryText: formString(form, "primaryText"),
      callToAction: formString(form, "callToAction"),
      linkUrl: formString(form, "linkUrl"),
      mediaType: formString(form, "mediaType"),
      generateImage: form.get("generateImage") === "on",
      campaignId: formString(form, "campaignId"),
      adsetId: formString(form, "adsetId"),
      campaignName: formString(form, "campaignName"),
      adsetName: formString(form, "adsetName"),
      objective: formString(form, "objective"),
      dailyBudget: formNumber(form, "dailyBudget"),
      optimizationGoal: formString(form, "optimizationGoal"),
      billingEvent: formString(form, "billingEvent"),
      countries: formString(form, "countries")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      rationale: formString(form, "rationale"),
    };
    const input = {
      ...normalizeCreativeSubmissionInput(args),
      ...(uploadedMedia.length > 0 ? { uploadedMedia } : {}),
      ...(uploadedReferenceMedia.length > 0 ? { uploadedReferenceMedia, generateImage: true } : {}),
    };
    const github = await getActiveGithubAdapter();
    const llm = await selectLLMProviderForWorker(process.env, { prisma }).catch(() => null);
    const result = await createCreativeSubmissionProposal({
      prisma,
      githubAdapter: github.adapter,
      workspaceId: workspace.id,
      input,
      actor: "user:web-ui",
      source: "web",
      llmProvider: llm?.provider ?? null,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formNumber(form: FormData, key: string): number | undefined {
  const value = formString(form, key);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

import type { ImageReferenceInput, LLMProvider } from "@addroid/llm-provider";
import type { ImprovementPrCreativeGenerationContext } from "@addroid/queue";
import { addCreativeImageUnderstanding } from "./creative-image-understanding.js";
import { addLandingPageBriefToCreativeContext } from "./creative-landing-page-context.js";
import { loadCreativeReferenceImages } from "./creative-reference-images.js";

interface CreativeReferenceStorage {
  read(key: string): Promise<Buffer>;
  readText(key: string): Promise<string>;
  resolve?(key: string): string;
}

interface LandingPageUrlCandidate {
  label: string;
  url: string | null | undefined;
}

export interface EnrichCreativeGenerationContextInput {
  provider?: LLMProvider | null;
  storage?: CreativeReferenceStorage | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  userReferenceImages?: ImageReferenceInput[];
  explicitUrls?: LandingPageUrlCandidate[];
  referenceImageLimit?: number;
}

export interface EnrichCreativeGenerationContextResult {
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  referenceImages: ImageReferenceInput[];
  creativeReferenceImages: ImageReferenceInput[];
}

export async function enrichCreativeGenerationContext(
  input: EnrichCreativeGenerationContextInput
): Promise<EnrichCreativeGenerationContextResult> {
  const creativeReferenceImages = input.storage
    ? await loadCreativeReferenceImages(input.storage, input.creativeContext)
    : [];
  const referenceImages = mergeReferenceImages(
    [...(input.userReferenceImages ?? []), ...creativeReferenceImages],
    input.referenceImageLimit ?? 4
  );
  const withVision = await addCreativeImageUnderstanding(
    input.provider ?? null,
    input.creativeContext,
    referenceImages
  );
  const withLanding = await addLandingPageBriefToCreativeContext(
    input.provider ?? null,
    withVision,
    input.explicitUrls ?? []
  );
  return {
    creativeContext: withLanding,
    referenceImages,
    creativeReferenceImages,
  };
}

export function mergeReferenceImages(
  images: ImageReferenceInput[],
  limit = 4
): ImageReferenceInput[] {
  const out: ImageReferenceInput[] = [];
  const seen = new Set<string>();
  for (const image of images) {
    const key =
      image.sourceRef ??
      image.localPath ??
      image.filename ??
      `${image.mimeType}:${image.bytes.byteLength}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(image);
    if (out.length >= limit) break;
  }
  return out;
}

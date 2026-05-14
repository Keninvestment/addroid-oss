import type { ImageReferenceInput, LLMProvider } from "@addroid/llm-provider";
import type { ImprovementPrCreativeGenerationContext } from "@addroid/queue";

export async function addCreativeImageUnderstanding(
  provider: LLMProvider | null | undefined,
  context: ImprovementPrCreativeGenerationContext | null,
  referenceImages: readonly ImageReferenceInput[]
): Promise<ImprovementPrCreativeGenerationContext | null> {
  if (!provider || referenceImages.length === 0) return context;
  const summaries: string[] = [];
  for (const image of referenceImages.slice(0, 3)) {
    const summary = await summarizeReferenceImage(provider, image).catch(() => null);
    if (summary) summaries.push(`${image.sourceRef ?? image.filename ?? "reference"}: ${summary}`);
  }
  if (summaries.length === 0) return context;
  const base = context ?? {
    strategy: "scale_winner" as const,
    target: null,
    references: [],
    brandProfile: null,
    notes: [],
  };
  return {
    ...base,
    notes: [
      ...(base.notes ?? []),
      "Reference image visual analysis for generation planning:",
      ...summaries,
    ],
  };
}

async function summarizeReferenceImage(
  provider: LLMProvider,
  image: ImageReferenceInput
): Promise<string | null> {
  const dataBase64 = Buffer.from(image.bytes).toString("base64");
  const result = await provider.complete({
    purpose: "creative:reference_image_understanding",
    maxOutputTokens: 300,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You analyze Meta ad reference images for creative generation. Return concise Japanese text only. Focus on layout, subject, composition, colors, style, text placement, product treatment, emotional hook, and what should be preserved as abstract cues. Also state what must be changed so the next image is not a copy. Do not identify people.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "この参考クリエイティブ画像を読み取り、次の画像生成で参考にすべき視覚要素を要約してください。同一画像のコピーではなく、勝ち要素の抽象化に使います。保持すべき抽象要素と、必ず変えるべき要素を分けてください。",
          },
          {
            type: "image",
            mimeType: image.mimeType,
            dataBase64,
            localPath: image.localPath,
            sourceRef: image.sourceRef,
          },
        ],
      },
    ],
  });
  const text = result.content.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 900) : null;
}

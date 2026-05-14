import net from "node:net";
import type { LLMProvider } from "@addroid/llm-provider";
import type { ImprovementPrCreativeGenerationContext } from "@addroid/queue";

interface UrlCandidate {
  label: string;
  url: string | null | undefined;
}

interface LandingPageBrief {
  label: string;
  url: string;
  displayUrl: string;
  brief: string | null;
  skippedReason?: string;
}

const MAX_URLS = 3;
const MAX_BRIEF_CHARS = 1800;

export async function addLandingPageBriefToCreativeContext(
  provider: LLMProvider | null,
  context: ImprovementPrCreativeGenerationContext | null,
  explicitUrls: UrlCandidate[] = []
): Promise<ImprovementPrCreativeGenerationContext | null> {
  const briefs = await buildLandingPageBriefs(provider, [
    ...explicitUrls,
    ...landingPageUrlsFromCreativeContext(context),
  ]);
  if (briefs.length === 0) return context;

  const notes = briefs.map(formatLandingPageBriefNote);
  const base = context ?? {
    strategy: "refresh_underperformer" as const,
    target: null,
    references: [],
    brandProfile: null,
    notes: [],
  };
  return {
    ...base,
    notes: [...(base.notes ?? []), ...notes],
  };
}

export function landingPageUrlForPrompt(raw: string | null | undefined): string | null {
  const safe = safeLandingPageUrl(raw);
  return safe.ok ? safe.displayUrl : null;
}

function landingPageUrlsFromCreativeContext(
  context: ImprovementPrCreativeGenerationContext | null
): UrlCandidate[] {
  if (!context) return [];
  return [
    {
      label: "target creative landing page",
      url: context.target?.creative?.linkUrl,
    },
    ...context.references.map((reference, index) => ({
      label: `reference creative ${index + 1} landing page`,
      url: reference.creative?.linkUrl,
    })),
  ];
}

async function buildLandingPageBriefs(
  provider: LLMProvider | null,
  candidates: UrlCandidate[]
): Promise<LandingPageBrief[]> {
  const selected = dedupeCandidates(candidates).slice(0, MAX_URLS);
  const out: LandingPageBrief[] = [];
  for (const candidate of selected) {
    const safe = safeLandingPageUrl(candidate.url);
    if (!safe.ok) {
      out.push({
        label: candidate.label,
        url: String(candidate.url ?? ""),
        displayUrl: String(candidate.url ?? ""),
        brief: null,
        skippedReason: safe.reason,
      });
      continue;
    }
    if (!provider || provider.name !== "codex") {
      out.push({
        label: candidate.label,
        url: safe.url,
        displayUrl: safe.displayUrl,
        brief: null,
        skippedReason: "LLM provider cannot reliably browse URLs; content was not checked",
      });
      continue;
    }
    out.push({
      label: candidate.label,
      url: safe.url,
      displayUrl: safe.displayUrl,
      brief: await readLandingPageWithLlm(provider, candidate.label, safe.url),
    });
  }
  return out;
}

function dedupeCandidates(candidates: UrlCandidate[]): UrlCandidate[] {
  const seen = new Set<string>();
  const out: UrlCandidate[] = [];
  for (const candidate of candidates) {
    const raw = candidate.url?.trim();
    if (!raw) continue;
    const key = raw.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: candidate.label, url: raw });
  }
  return out;
}

async function readLandingPageWithLlm(
  provider: LLMProvider,
  label: string,
  url: string
): Promise<string | null> {
  try {
    const result = await provider.complete({
      purpose: "creative:landing_page_understanding",
      maxOutputTokens: 700,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You inspect landing page URLs for Meta ad creative generation.",
            "Actually open the URL if the runtime allows it.",
            "If you cannot verify the page content, say so clearly and do not guess.",
            "Return concise Japanese text only. Do not include secrets, cookies, forms, or long quotations.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `URL label: ${label}`,
            `URL: ${url}`,
            "この遷移先ページを確認し、改善クリエイティブ生成に使える情報だけを要約してください。",
            "出力項目: 商品/サービス、主な訴求、CTA、画像に反映できる視覚ヒント、広告で避けるべき未確認主張。",
            "確認できない場合は「確認不可」と理由だけを書いてください。",
          ].join("\n"),
        },
      ],
    });
    const text = result.content.trim();
    return text ? truncateText(text, MAX_BRIEF_CHARS) : null;
  } catch (err) {
    return `確認不可: ${(err as Error).message}`;
  }
}

function formatLandingPageBriefNote(brief: LandingPageBrief): string {
  const prefix = `Landing page context (${brief.label}): ${brief.displayUrl}`;
  if (brief.brief) return `${prefix}\n${brief.brief}`;
  return `${prefix}\n確認不可: ${brief.skippedReason ?? "unknown reason"}`;
}

function safeLandingPageUrl(raw: string | null | undefined):
  | { ok: true; url: string; displayUrl: string }
  | { ok: false; reason: string } {
  const value = raw?.trim();
  if (!value) return { ok: false, reason: "URL is empty" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "URL is invalid" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "only http/https URLs are allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with credentials are not allowed" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHost(host)) {
    return { ok: false, reason: "local/private network URLs are not allowed" };
  }
  parsed.hash = "";
  const display = new URL(parsed.toString());
  display.search = "";
  return { ok: true, url: parsed.toString(), displayUrl: display.toString() };
}

function isBlockedHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 20).trimEnd()}... [truncated]`;
}

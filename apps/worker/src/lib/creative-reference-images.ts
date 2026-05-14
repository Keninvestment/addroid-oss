import path from "node:path";
import type { ImageReferenceInput } from "@addroid/llm-provider";
import type { ImprovementPrCreativeGenerationContext } from "@addroid/queue";

const STORAGE_PREFIX = "storage://";
const MAX_REFERENCE_IMAGES = 3;
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;

interface ReferenceImageStorage {
  read(key: string): Promise<Buffer>;
  readText(key: string): Promise<string>;
  resolve?(key: string): string;
}

export async function loadCreativeReferenceImages(
  storage: ReferenceImageStorage,
  context: ImprovementPrCreativeGenerationContext | null,
  limit = MAX_REFERENCE_IMAGES
): Promise<ImageReferenceInput[]> {
  if (!context || limit <= 0) return [];
  const refs: ImageReferenceInput[] = [];
  const seen = new Set<string>();
  const nodes = [...context.references, context.target].filter(
    (node): node is NonNullable<typeof node> => node !== null
  );
  for (const node of nodes) {
    const creative = node.creative;
    if (!creative || creative.mediaType === "video") continue;
    const candidates = [
      ...(creative.images ?? []),
      ...(creative.storageRef ? [creative.storageRef] : []),
    ];
    for (const candidate of candidates) {
      for (const loaded of await loadReferenceCandidate(storage, candidate)) {
        if (seen.has(loaded.sourceRef ?? loaded.filename ?? "")) continue;
        seen.add(loaded.sourceRef ?? loaded.filename ?? "");
        refs.push(loaded);
        if (refs.length >= limit) return refs;
      }
    }
  }
  return refs;
}

async function loadReferenceCandidate(
  storage: ReferenceImageStorage,
  value: string
): Promise<ImageReferenceInput[]> {
  const key = storageKeyFromRef(value);
  if (!key) return [];
  const directMime = mimeTypeFromKey(key);
  if (directMime) {
    const direct = await readReferenceImage(storage, key, directMime, value);
    return direct ? [direct] : [];
  }
  const metadata = await readMetadata(storage, `${key.replace(/\/$/, "")}/metadata.json`);
  const assets = Array.isArray(metadata?.assets) ? metadata.assets : [];
  const out: ImageReferenceInput[] = [];
  for (const asset of assets) {
    if (!isRecord(asset)) continue;
    const ref = typeof asset.storageRef === "string" ? asset.storageRef : null;
    const assetKey = ref ? storageKeyFromRef(ref) : null;
    if (!assetKey) continue;
    const mime = mimeTypeFromKey(assetKey) ?? mimeTypeFromString(asset.mimeType);
    if (!mime) continue;
    const loaded = await readReferenceImage(storage, assetKey, mime, ref ?? assetKey);
    if (loaded) out.push(loaded);
  }
  return out;
}

async function readReferenceImage(
  storage: ReferenceImageStorage,
  key: string,
  mimeType: ImageReferenceInput["mimeType"],
  sourceRef: string
): Promise<ImageReferenceInput | null> {
  try {
    const bytes = await storage.read(key);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES) return null;
    return {
      bytes: new Uint8Array(bytes),
      mimeType,
      filename: path.posix.basename(key),
      sourceRef,
      ...(typeof storage.resolve === "function" ? { localPath: storage.resolve(key) } : {}),
    };
  } catch {
    return null;
  }
}

async function readMetadata(
  storage: ReferenceImageStorage,
  key: string
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await storage.readText(key)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storageKeyFromRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(STORAGE_PREFIX)) return trimmed.slice(STORAGE_PREFIX.length);
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  return trimmed;
}

function mimeTypeFromKey(key: string): ImageReferenceInput["mimeType"] | null {
  const ext = path.posix.extname(key).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return null;
}

function mimeTypeFromString(value: unknown): ImageReferenceInput["mimeType"] | null {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

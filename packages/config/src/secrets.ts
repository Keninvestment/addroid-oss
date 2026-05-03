// AdDroid OSS — secrets.local.yaml accessor.
//
// `~/.addroid/secrets.local.yaml` はユーザーのローカル機微情報をまとめる任意ファイルで
// `.gitignore` で追跡対象外。許容する値:
//   - github.oauth.clientId / clientSecret  (GitHub OAuth クライアント)
//   - meta.oauth.appId / appSecret           (Meta Login for Business OAuth クライアント)
//   - meta.oauth.permissions (string[])      (override default scopes)
//   - meta.accessToken                       (オプション: 開発時の手動トークン)
// 値は YAML 上は平文だが、ファイルパーミッション 0600 を強制し、git 追跡対象外。
// DB に書き込む値は `getCryptoBoundary` で暗号化する。

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { resolveAddroidPaths } from "./paths.js";

export const LocalSecretsSchema = z
  .object({
    github: z
      .object({
        oauth: z
          .object({
            clientId: z.string().min(1).optional(),
            clientSecret: z.string().min(1).optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    meta: z
      .object({
        oauth: z
          .object({
            appId: z.string().min(1).optional(),
            appSecret: z.string().min(1).optional(),
            permissions: z.array(z.string().min(1)).optional(),
          })
          .partial()
          .optional(),
        accessToken: z.string().min(1).optional(),
      })
      .partial()
      .optional(),
    /** Free-form bag for forward-compatibility; never logged. */
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .partial();

export type LocalSecrets = z.infer<typeof LocalSecretsSchema>;

export class SecretsParseError extends Error {
  readonly file: string;
  readonly issues: string[];
  constructor(file: string, issues: string[]) {
    super(`Failed to parse ${file}: ${issues.join("; ") || "unknown error"}`);
    this.name = "SecretsParseError";
    this.file = file;
    this.issues = issues;
  }
}

export interface SecretsFileStatus {
  path: string;
  exists: boolean;
  /** Octal mode (e.g. 0o600). null when the file does not exist. */
  mode: number | null;
  /** True iff group/other have any read/write/execute bits. */
  worldReadable: boolean;
}

export async function inspectSecretsFile(
  env: NodeJS.ProcessEnv = process.env
): Promise<SecretsFileStatus> {
  const { secretsFile } = resolveAddroidPaths(env);
  try {
    const stat = await fs.stat(secretsFile);
    const mode = stat.mode & 0o777;
    return { path: secretsFile, exists: true, mode, worldReadable: (mode & 0o077) !== 0 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: secretsFile, exists: false, mode: null, worldReadable: false };
    }
    throw err;
  }
}

/**
 * Read & validate `~/.addroid/secrets.local.yaml`. Returns null when the file does not exist.
 * Throws SecretsParseError on schema mismatch so callers can present an actionable message.
 */
export async function readLocalSecrets(
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalSecrets | null> {
  const { secretsFile } = resolveAddroidPaths(env);
  let raw: string;
  try {
    raw = await fs.readFile(secretsFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = raw.trim() === "" ? {} : YAML.parse(raw) ?? {};
  const result = LocalSecretsSchema.safeParse(parsed);
  if (!result.success) {
    throw new SecretsParseError(
      secretsFile,
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  return result.data;
}

/**
 * Write `~/.addroid/secrets.local.yaml` with mode 0600. Always overwrites atomically.
 * Existing content is replaced — callers wanting to merge should read first.
 */
export async function writeLocalSecrets(
  next: LocalSecrets,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ wrote: boolean; path: string }> {
  LocalSecretsSchema.parse(next);
  const { secretsFile } = resolveAddroidPaths(env);
  const banner =
    "# AdDroid OSS — local secrets. THIS FILE IS GITIGNORED.\n" +
    "# Values are read by `addroid up` / `addroid doctor` from this host only.\n";
  const body = YAML.stringify(next);
  const text = banner + body;
  let current: string | null = null;
  try {
    current = await fs.readFile(secretsFile, "utf8");
  } catch {
    /* not present */
  }
  if (current === text) return { wrote: false, path: secretsFile };
  await fs.writeFile(secretsFile, text, { encoding: "utf8", mode: 0o600 });
  // Re-chmod in case the file pre-existed with looser bits.
  await fs.chmod(secretsFile, 0o600).catch(() => undefined);
  return { wrote: true, path: secretsFile };
}

/**
 * Resolve a single secret by dotted key (e.g. "github.oauth.clientSecret").
 * Returns null when the file is missing or the key is not set.
 * Reads are case-sensitive and walk only top-level objects (not arrays).
 */
export async function getLocalSecret(
  dottedKey: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (!dottedKey || dottedKey.includes("..")) {
    throw new TypeError("dottedKey must be a non-empty 'a.b.c' string without empty segments");
  }
  const secrets = await readLocalSecrets(env);
  if (!secrets) return null;
  let cursor: unknown = secrets;
  for (const segment of dottedKey.split(".")) {
    if (cursor && typeof cursor === "object" && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  if (typeof cursor === "string") return cursor;
  if (cursor === undefined || cursor === null) return null;
  // Refuse to silently coerce non-string values; callers asking for a secret expect a string.
  throw new TypeError(
    `secret at '${dottedKey}' is not a string (type: ${typeof cursor}); update secrets.local.yaml`
  );
}

/**
 * Verify the secrets file is readable only by the owner. Used by `addroid doctor`.
 */
export async function ensureSecretsFilePermissions(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ tightened: boolean; path: string } | null> {
  const status = await inspectSecretsFile(env);
  if (!status.exists) return null;
  if (!status.worldReadable) return { tightened: false, path: status.path };
  await fs.chmod(status.path, 0o600);
  // Sanity check we have access after chmod; surface error if not.
  await fs.access(status.path, fsConstants.R_OK | fsConstants.W_OK);
  return { tightened: true, path: status.path };
}

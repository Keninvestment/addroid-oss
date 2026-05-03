// AdDroid OSS — encryption boundary (AES-256-GCM).
//
// `oauth_tokens.access_token_ciphertext` 等の機微情報は本モジュール経由でのみ
// 平文 ↔ 暗号文を変換します。ENCRYPTION_KEY は環境変数で渡され、ローカル外には出ません。
// 詳細: docs/SECURITY.md §3

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Ciphertext format prefix; bumped when the wire format changes so old rows can be migrated.
export const CIPHERTEXT_FORMAT = "v1.aes256gcm";

export class CryptoNotConfiguredError extends Error {
  constructor(message?: string) {
    super(message ?? "ENCRYPTION_KEY is not configured. See docs/SECURITY.md §3.");
    this.name = "CryptoNotConfiguredError";
  }
}

export class CiphertextFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiphertextFormatError";
  }
}

export interface CryptoBoundary {
  /** Encrypt a UTF-8 plaintext into the canonical wire format. */
  encrypt(plaintext: string): string;
  /** Decrypt a wire-format ciphertext. Throws on tamper, missing key, or format mismatch. */
  decrypt(ciphertext: string): string;
}

export type EncryptionKeyValidation =
  | { ok: true; bytes: number; encoding: "base64" | "hex" | "raw" }
  | { ok: false; reason: string; hint?: string };

/**
 * Validate ENCRYPTION_KEY without instantiating the crypto boundary.
 * Returns a structured result so `addroid doctor` can render an actionable error.
 */
export function validateEncryptionKey(env: NodeJS.ProcessEnv = process.env): EncryptionKeyValidation {
  const raw = env.ENCRYPTION_KEY?.trim();
  if (!raw) {
    return {
      ok: false,
      reason: "ENCRYPTION_KEY が設定されていません。",
      hint: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" で生成し .env.local に設定。',
    };
  }
  // base64 with padding (Node accepts both with/without padding; require length >= 44 for 32 bytes).
  if (/^[A-Za-z0-9+/]+=*$/.test(raw)) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === KEY_BYTES) {
      return { ok: true, bytes: KEY_BYTES, encoding: "base64" };
    }
  }
  // hex (exactly 64 chars).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return { ok: true, bytes: KEY_BYTES, encoding: "hex" };
  }
  // Raw entropy: require >=32 bytes when UTF-8 encoded so weak keys are rejected.
  const utf8 = Buffer.byteLength(raw, "utf8");
  if (utf8 >= KEY_BYTES) {
    return { ok: true, bytes: utf8, encoding: "raw" };
  }
  return {
    ok: false,
    reason: `ENCRYPTION_KEY が短すぎます (${utf8} byte)。32 byte 以上が必要です。`,
    hint: "32 byte 以上のランダム値 (base64 / hex / raw) を設定してください。",
  };
}

/**
 * Decode the configured ENCRYPTION_KEY into a 32-byte buffer.
 * - base64 (44 chars padded) → decoded directly
 * - hex (64 chars)         → decoded directly
 * - raw UTF-8 (>=32 bytes) → SHA-256(value) to derive a uniform 32-byte key
 */
export function deriveEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const v = validateEncryptionKey(env);
  if (!v.ok) throw new CryptoNotConfiguredError(`${v.reason}${v.hint ? " " + v.hint : ""}`);
  const raw = (env.ENCRYPTION_KEY as string).trim();
  switch (v.encoding) {
    case "base64": {
      const buf = Buffer.from(raw, "base64");
      return buf.subarray(0, KEY_BYTES);
    }
    case "hex":
      return Buffer.from(raw, "hex");
    case "raw":
      return createHash("sha256").update(Buffer.from(raw, "utf8")).digest();
  }
}

/**
 * Returns the canonical encryption boundary backed by ENCRYPTION_KEY.
 * Throws CryptoNotConfiguredError if the key is missing or too short.
 */
export function getCryptoBoundary(env: NodeJS.ProcessEnv = process.env): CryptoBoundary {
  const key = deriveEncryptionKey(env);
  return {
    encrypt(plaintext: string): string {
      if (typeof plaintext !== "string") {
        throw new TypeError("CryptoBoundary.encrypt: plaintext must be a string");
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        CIPHERTEXT_FORMAT,
        iv.toString("base64"),
        tag.toString("base64"),
        enc.toString("base64"),
      ].join(".");
    },
    decrypt(ciphertext: string): string {
      if (typeof ciphertext !== "string" || !ciphertext) {
        throw new CiphertextFormatError("ciphertext must be a non-empty string");
      }
      const parts = ciphertext.split(".");
      if (parts.length !== 5 || `${parts[0]}.${parts[1]}` !== CIPHERTEXT_FORMAT) {
        throw new CiphertextFormatError(
          `unsupported ciphertext format (expected '${CIPHERTEXT_FORMAT}.iv.tag.payload')`
        );
      }
      const iv = Buffer.from(parts[2]!, "base64");
      const tag = Buffer.from(parts[3]!, "base64");
      const enc = Buffer.from(parts[4]!, "base64");
      if (iv.length !== IV_BYTES) {
        throw new CiphertextFormatError(`iv length=${iv.length}, expected ${IV_BYTES}`);
      }
      if (tag.length !== TAG_BYTES) {
        throw new CiphertextFormatError(`tag length=${tag.length}, expected ${TAG_BYTES}`);
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
      } catch (err) {
        // GCM auth-tag mismatch surfaces as a generic error; rewrap so callers can detect tampering.
        throw new CiphertextFormatError(
          `ciphertext authentication failed (tampered or wrong key): ${(err as Error).message}`
        );
      }
    },
  };
}

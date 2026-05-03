import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CIPHERTEXT_FORMAT,
  CiphertextFormatError,
  CryptoNotConfiguredError,
  deriveEncryptionKey,
  getCryptoBoundary,
  validateEncryptionKey,
} from "../crypto.js";

function envWithKey(key: string): NodeJS.ProcessEnv {
  return { ENCRYPTION_KEY: key };
}

test("validateEncryptionKey rejects missing key with actionable hint", () => {
  const v = validateEncryptionKey({});
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.match(v.reason, /設定されていません/);
  assert.ok(v.hint && v.hint.includes("randomBytes"));
});

test("validateEncryptionKey rejects short raw keys", () => {
  const v = validateEncryptionKey({ ENCRYPTION_KEY: "tiny-key" });
  assert.equal(v.ok, false);
});

test("validateEncryptionKey accepts base64 / hex / raw 32+ byte keys", () => {
  const b64 = randomBytes(32).toString("base64");
  const hex = randomBytes(32).toString("hex");
  const raw = "x".repeat(32);

  const a = validateEncryptionKey(envWithKey(b64));
  assert.equal(a.ok, true);
  if (a.ok) assert.equal(a.encoding, "base64");

  const b = validateEncryptionKey(envWithKey(hex));
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.encoding, "hex");

  const c = validateEncryptionKey(envWithKey(raw));
  assert.equal(c.ok, true);
  if (c.ok) assert.equal(c.encoding, "raw");
});

test("deriveEncryptionKey returns 32 bytes for every accepted format", () => {
  const samples = [
    randomBytes(32).toString("base64"),
    randomBytes(32).toString("hex"),
    "x".repeat(40),
  ];
  for (const s of samples) {
    const buf = deriveEncryptionKey(envWithKey(s));
    assert.equal(buf.length, 32);
  }
});

test("deriveEncryptionKey throws CryptoNotConfiguredError when missing", () => {
  assert.throws(() => deriveEncryptionKey({}), CryptoNotConfiguredError);
});

test("getCryptoBoundary round-trips plaintext", () => {
  const env = envWithKey(randomBytes(32).toString("base64"));
  const c = getCryptoBoundary(env);
  const plain = "hello-トークン-🔐";
  const ct = c.encrypt(plain);
  assert.ok(ct.startsWith(`${CIPHERTEXT_FORMAT}.`));
  assert.equal(c.decrypt(ct), plain);
});

test("ciphertexts are non-deterministic (fresh IV per call)", () => {
  const env = envWithKey(randomBytes(32).toString("base64"));
  const c = getCryptoBoundary(env);
  const a = c.encrypt("same plaintext");
  const b = c.encrypt("same plaintext");
  assert.notEqual(a, b);
  assert.equal(c.decrypt(a), "same plaintext");
  assert.equal(c.decrypt(b), "same plaintext");
});

test("decrypt rejects tampered ciphertext", () => {
  const env = envWithKey(randomBytes(32).toString("base64"));
  const c = getCryptoBoundary(env);
  const ct = c.encrypt("payload");
  // Flip one base64 char in the payload section.
  const parts = ct.split(".");
  const last = parts[parts.length - 1]!;
  const flipped = last[0] === "A" ? "B" + last.slice(1) : "A" + last.slice(1);
  parts[parts.length - 1] = flipped;
  const tampered = parts.join(".");
  assert.throws(() => c.decrypt(tampered), CiphertextFormatError);
});

test("decrypt rejects ciphertext encrypted with a different key", () => {
  const a = getCryptoBoundary(envWithKey(randomBytes(32).toString("base64")));
  const b = getCryptoBoundary(envWithKey(randomBytes(32).toString("base64")));
  const ct = a.encrypt("payload");
  assert.throws(() => b.decrypt(ct), CiphertextFormatError);
});

test("decrypt rejects malformed ciphertext", () => {
  const c = getCryptoBoundary(envWithKey(randomBytes(32).toString("base64")));
  assert.throws(() => c.decrypt(""), CiphertextFormatError);
  assert.throws(() => c.decrypt("not.a.valid.ciphertext"), CiphertextFormatError);
  assert.throws(() => c.decrypt("v1.aes256gcm.AAA.BBB"), CiphertextFormatError);
});

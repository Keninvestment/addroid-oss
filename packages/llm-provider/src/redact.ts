// Shared redaction helpers for provider errors.

const SECRET_KEY_RE = /(access_token|refresh_token|id_token|client_secret|api_key|authorization)["']?\s*[:=]\s*["']?([^"',\s}]+)/gi;

export function redactPayloadForError(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text
    .replace(SECRET_KEY_RE, (_m, key) => `${key}=[REDACTED]`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]");
}

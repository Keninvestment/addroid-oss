// AdDroid OSS — DATABASE_URL helper.
//
// CLI / Web / Worker のすべてが本モジュール経由で DATABASE_URL を読み出すことで、
// 「postgres:// で始まっていない」「未設定」「localhost 以外なのに警告できない」等の
// 状態を 1 か所で検証する。

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export type DatabaseUrlValidation =
  | {
      ok: true;
      url: URL;
      hostname: string;
      port: number;
      database: string;
      isLocal: boolean;
    }
  | { ok: false; reason: string; hint?: string };

/**
 * Read & validate process.env.DATABASE_URL. Pure function, never connects.
 * Returns a structured result so doctor / CLI can render an actionable error.
 */
export function parseDatabaseUrl(env: NodeJS.ProcessEnv = process.env): DatabaseUrlValidation {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) {
    return {
      ok: false,
      reason: "DATABASE_URL が設定されていません。",
      hint:
        "リポジトリ root の `.env` (推奨: Prisma `db:*` / Next.js / addroid CLI が auto-load) " +
        "もしくは `.env.local` (Next.js / addroid CLI のみ auto-load) に `cp .env.example` で値を書くか、" +
        "shell で `export DATABASE_URL=...` してください。",
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `DATABASE_URL を URL として解釈できません: ${(err as Error).message}`,
      hint: "例: postgresql://USER:PASSWORD@localhost:5432/addroid",
    };
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      reason: `DATABASE_URL の protocol が postgres:// / postgresql:// ではありません (got '${url.protocol}')。`,
      hint: "例: postgresql://USER:PASSWORD@localhost:5432/addroid",
    };
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    return {
      ok: false,
      reason: "DATABASE_URL に database 名が含まれていません。",
      hint: "URL 末尾に '/<database>' を追加してください (例: …/addroid)。",
    };
  }
  const hostname = url.hostname || "localhost";
  const port = url.port ? Number.parseInt(url.port, 10) : 5432;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      reason: `DATABASE_URL の port が不正です (got '${url.port}')。`,
    };
  }
  const isLocal =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return { ok: true, url, hostname, port, database, isLocal };
}

/**
 * Convenience: returns the DATABASE_URL string only if it parses; otherwise throws.
 * Used by Prisma client setup paths that prefer to fail fast.
 */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = parseDatabaseUrl(env);
  if (!v.ok) {
    const hint = v.hint ? ` (${v.hint})` : "";
    throw new Error(`DATABASE_URL invalid: ${v.reason}${hint}`);
  }
  return v.url.toString();
}

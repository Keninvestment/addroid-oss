// AdDroid OSS — Prisma client singleton.
//
// Web / worker / CLI のすべてが本モジュール経由で `prisma` を共有します。
// 多重インスタンス化 (Next.js dev での HMR 等) を避けるため globalThis にキャッシュします。
//
// Compatibility note:
// `export * from "@prisma/client"` is intentionally broad. Workspace packages
// import generated Prisma enums/types through `@addroid/db`, so narrowing this
// barrel is a breaking internal API change and needs a migration plan first.

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __addroidPrisma__: PrismaClient | undefined;
}

const prisma =
  globalThis.__addroidPrisma__ ??
  new PrismaClient({
    log: process.env.ADDROID_PRISMA_LOG ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__addroidPrisma__ = prisma;
}

export { prisma };
export type { PrismaClient } from "@prisma/client";
export * from "@prisma/client";

// Re-export the shared Prisma singleton from @addroid/db so apps/web has a single
// import path even if the underlying location changes.
export { prisma } from "@addroid/db";
export type { PrismaClient } from "@addroid/db";

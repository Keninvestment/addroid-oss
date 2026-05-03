import { NextResponse } from "next/server";
import { resolveWebBinding } from "@addroid/config";
import { prisma } from "../../../lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const binding = (() => {
    try {
      return resolveWebBinding();
    } catch {
      return { hostname: "127.0.0.1", port: 3000 };
    }
  })();

  let database: "ok" | "warn" | "error" = "ok";
  let databaseDetail = "SELECT 1 succeeded";
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    try {
      await prisma.workspace.count();
    } catch (err) {
      database = "warn";
      databaseDetail = `Prisma schema not pushed: ${(err as Error).message.split("\n")[0]}`;
    }
  } catch (err) {
    database = "error";
    databaseDetail = `Cannot reach PostgreSQL: ${(err as Error).message.split("\n")[0]}`;
  }

  return NextResponse.json(
    {
      service: "addroid-web",
      version: process.env.npm_package_version ?? "0.0.0",
      binding,
      database: { state: database, detail: databaseDetail },
      time: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

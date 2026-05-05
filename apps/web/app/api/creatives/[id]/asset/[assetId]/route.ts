// AdDroid OSS — GET /api/creatives/[id]/asset/[assetId] (this implementation).
//
// 生成 creative 画像バイナリの **唯一の配信経路**。
//
// 設計原則:
//   - LocalDisk Storage Adapter から bytes を読み出す。Provider が返した
//     remote URL を fetch しない (outbound-only / SSRF 防止)。
//   - URL パラメータ ((id, assetId)) のみで resolve する。client から file
//     path / storage scheme を受け付けない。
//   - tenant 境界: creative_id を引き、creative.accountId が現 workspace の
//     active な ad_account に属することを確認してから配信する。
//   - assetId は metadata.json (= persistCreativeAssets が書いた既知 set)
//     の中にしか無いものを許可する。フォーマットは `asset_<12 hex>`。
//   - 404 / 410 を決定的に返し、broken image アイコンを呼び出し元に出させない
//     (UI 側はプレースホルダ + StatusBadge "storage 未到達" を出す責務)。

import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/prisma";
import {
  readCreativeAssetByMetadata,
  readCreativeMetadataByRef,
} from "../../../../../../lib/creative-helpers";

export const dynamic = "force-dynamic";

const ASSET_ID_PATTERN = /^asset_[a-f0-9]{12}$/;
const CREATIVE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id: creativeId, assetId } = await params;

  if (!CREATIVE_ID_PATTERN.test(creativeId) || !ASSET_ID_PATTERN.test(assetId)) {
    return new NextResponse("Not found", { status: 404 });
  }

  let row: {
    id: string;
    storageRef: string | null;
    accountId: string;
    account: { active: boolean; workspaceId: string } | null;
  } | null = null;
  try {
    row = await prisma.creative.findUnique({
      where: { id: creativeId },
      select: {
        id: true,
        storageRef: true,
        accountId: true,
        account: {
          select: { active: true, workspaceId: true },
        },
      },
    });
  } catch {
    return new NextResponse("Service unavailable", { status: 503 });
  }

  if (!row || !row.storageRef || !row.account || !row.account.active) {
    return new NextResponse("Not found", { status: 404 });
  }

  // workspace tenant check — single-workspace 前提だが、active な ad_account
  // と workspace の関係が実際に張られていることを確認する。
  let workspaceMatches = false;
  try {
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    workspaceMatches = ws !== null && ws.id === row.account.workspaceId;
  } catch {
    return new NextResponse("Service unavailable", { status: 503 });
  }
  if (!workspaceMatches) {
    return new NextResponse("Not found", { status: 404 });
  }

  const metadata = await readCreativeMetadataByRef(row.storageRef);
  if (!metadata) {
    return new NextResponse("Storage metadata missing", { status: 410 });
  }

  const asset = await readCreativeAssetByMetadata(metadata, assetId);
  if (!asset) {
    return new NextResponse("Asset not found", { status: 404 });
  }

  // Buffer → ArrayBuffer slice でレスポンス body にする。
  const slice = asset.bytes.buffer.slice(
    asset.bytes.byteOffset,
    asset.bytes.byteOffset + asset.bytes.byteLength
  ) as ArrayBuffer;

  return new NextResponse(slice, {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      // SSRF/embed の悪用を避けるため referrer policy も明示。
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

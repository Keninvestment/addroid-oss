import { NextResponse } from "next/server";

export const TRUSTED_WEB_ACTION_HEADER = "X-AdDroid-Web-Action";

const TRUSTED_WEB_ACTION_HEADER_NAME = TRUSTED_WEB_ACTION_HEADER.toLowerCase();
const TRUSTED_WEB_ACTION_VALUE = "1";

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function forwardedRequestOrigin(request: Request): string | null {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return normalizeOrigin(`${forwardedProto}://${forwardedHost}`);
  }

  const host = request.headers.get("host")?.split(",")[0]?.trim();
  if (host) {
    return normalizeOrigin(`${new URL(request.url).protocol}//${host}`);
  }

  return normalizeOrigin(request.url);
}

function requestSourceOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return normalizeOrigin(origin);

  const referer = request.headers.get("referer");
  if (referer) return normalizeOrigin(referer);

  return null;
}

export function requireTrustedJsonWebAction(request: Request): NextResponse | null {
  if (request.headers.get(TRUSTED_WEB_ACTION_HEADER_NAME) !== TRUSTED_WEB_ACTION_VALUE) {
    return NextResponse.json(
      { ok: false, error: "This action must be submitted from the AdDroid Web UI." },
      { status: 403 }
    );
  }

  const mediaType = ((request.headers.get("content-type") ?? "").split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return NextResponse.json(
      { ok: false, error: "This action must use application/json." },
      { status: 415 }
    );
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
    return NextResponse.json(
      { ok: false, error: "Cross-site Web action rejected." },
      { status: 403 }
    );
  }

  const expectedOrigin = forwardedRequestOrigin(request);
  const actualOrigin = requestSourceOrigin(request);
  if (!expectedOrigin || actualOrigin !== expectedOrigin) {
    return NextResponse.json(
      { ok: false, error: "Cross-origin Web action rejected." },
      { status: 403 }
    );
  }

  return null;
}

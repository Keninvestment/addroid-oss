// AdDroid OSS — Codex app-server login begin endpoint.
//
// `/ai` ページの "Connect Codex" 導線から GET される。
// 採用された LLMProvider 実装 (mock / codex / stub) によって挙動を切り替える:
//   - mock : `addroid.invalid` の URL は実在しないので、内部 callback に
//            code=mock-<state> でループバックさせ、ローカルだけで OAuth が完結する。
//   - codex: local app-server の ChatGPT login URL に 302 する。
//     callback は Codex app-server が受けるため、AdDroid は token を保存しない。

import { NextResponse } from "next/server";
import { getActiveCodexProviderSelection } from "../../../../../lib/codex-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const { provider, choice } = getActiveCodexProviderSelection();
    if (choice === "stub") {
      return NextResponse.redirect(
        new URL(
          `/ai?oauth=error&reason=${encodeURIComponent(
            "Codex app-server is not configured. Install Codex CLI or set CODEX_APP_SERVER_URL to a local app-server."
          )}`,
          url
        ),
        { status: 302 }
      );
    }
    const { authorizationUrl, state } = await provider.beginOAuth();
    if (choice === "mock") {
      await provider.completeOAuth({ code: `mock-${state}`, state });
      const next = new URL("/ai", url);
      next.searchParams.set("oauth", "connected");
      next.searchParams.set("provider", "mock");
      return NextResponse.redirect(next, { status: 302 });
    }
    return NextResponse.redirect(authorizationUrl, { status: 302 });
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/ai?oauth=error&reason=${encodeURIComponent(
          (err as Error).message
        )}`,
        url
      ),
      { status: 302 }
    );
  }
}

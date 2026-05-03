// AdDroid OSS — GitHub OAuth begin endpoint.
//
// `/github` ページの "Connect GitHub" 導線から GET される。
// 採用された adapter (mock / octokit / stub) によって挙動を切り替える:
//   - mock   : `addroid.invalid` の URL は実在しないので、内部 callback に
//              code=mock-<state> でループバックさせ、ローカルだけで OAuth が完結する。
//   - octokit: 実 GitHub の authorize URL に 302 リダイレクトする。
//   - stub   : OAuth client / 暗号化境界が未設定。/github へエラー理由付きで戻す。

import { NextResponse } from "next/server";
import { getActiveGithubAdapter } from "../../../../../lib/github-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const { adapter, choice } = await getActiveGithubAdapter();
    if (choice === "stub") {
      return NextResponse.redirect(
        new URL(
          `/github?oauth=error&reason=${encodeURIComponent(
            "GitHub OAuth client is not configured. Set ADDROID_GITHUB_OAUTH_MOCK=1, or place clientId/clientSecret in ~/.addroid/secrets.local.yaml and ensure ENCRYPTION_KEY is set."
          )}`,
          url
        ),
        { status: 302 }
      );
    }
    const { authorizationUrl, state } = await adapter.beginOAuth();
    if (choice === "mock") {
      const callback = new URL(`/api/oauth/github/callback`, url);
      callback.searchParams.set("code", `mock-${state}`);
      callback.searchParams.set("state", state);
      return NextResponse.redirect(callback, { status: 302 });
    }
    return NextResponse.redirect(authorizationUrl, { status: 302 });
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/github?oauth=error&reason=${encodeURIComponent((err as Error).message)}`,
        url
      ),
      { status: 302 }
    );
  }
}

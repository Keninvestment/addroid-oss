// AdDroid OSS — Meta OAuth begin endpoint.
//
// `/accounts` ページの "Connect Meta" 導線から GET される。
// 採用された adapter (mock / real / stub) によって挙動を切り替える:
//   - mock : `addroid.invalid` の URL は実在しないので、内部 callback に code=mock-<state>
//            でループバックさせ、ローカルだけで OAuth が完結する。
//   - real : Facebook の authorize URL に 302 リダイレクトする。
//   - stub : OAuth client / 暗号化境界が未設定。`/accounts` へ理由付きで戻す。

import { NextResponse } from "next/server";
import { getActiveMetaAdapter } from "../../../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const { adapter, choice } = await getActiveMetaAdapter();
    if (choice === "stub") {
      return NextResponse.redirect(
        new URL(
          `/accounts?oauth=error&reason=${encodeURIComponent(
            "Meta OAuth client is not configured. Run addroid init to store encrypted meta.oauth.appIdCiphertext / appSecretCiphertext, and ensure ENCRYPTION_KEY is set."
          )}`,
          url
        ),
        { status: 302 }
      );
    }
    const { authorizationUrl, state } = await adapter.beginOAuth();
    if (choice === "mock") {
      const callback = new URL(`/api/oauth/meta/callback`, url);
      callback.searchParams.set("code", `mock-${state}`);
      callback.searchParams.set("state", state);
      return NextResponse.redirect(callback, { status: 302 });
    }
    return NextResponse.redirect(authorizationUrl, { status: 302 });
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/accounts?oauth=error&reason=${encodeURIComponent((err as Error).message)}`,
        url
      ),
      { status: 302 }
    );
  }
}

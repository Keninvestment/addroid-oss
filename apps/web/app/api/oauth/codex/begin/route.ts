// AdDroid OSS — Codex OAuth begin endpoint.
//
// `/ai` ページの "Connect Codex" 導線から GET される。
// 採用された LLMProvider 実装 (mock / codex / stub) によって挙動を切り替える:
//   - mock : `addroid.invalid` の URL は実在しないので、内部 callback に
//            code=mock-<state> でループバックさせ、ローカルだけで OAuth が完結する。
//   - codex: Codex / OpenAI 互換 OAuth provider の authorize URL に 302 する。
//   - stub : runtime 設定 / 暗号化境界が未設定。`/ai` へ理由付きで戻す。

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
            "Codex OAuth runtime is not configured. Set ADDROID_LLM_MOCK=1, or set ADDROID_CODEX_CHAT_COMPLETIONS_URL / ADDROID_CODEX_DEFAULT_MODEL and ENCRYPTION_KEY in the environment. ADDROID_CODEX_CLIENT_ID / ADDROID_CODEX_AUTHORIZATION_URL / ADDROID_CODEX_TOKEN_URL are optional overrides."
          )}`,
          url
        ),
        { status: 302 }
      );
    }
    const { authorizationUrl, state } = await provider.beginOAuth();
    if (choice === "mock") {
      const callback = new URL(`/api/oauth/codex/callback`, url);
      callback.searchParams.set("code", `mock-${state}`);
      callback.searchParams.set("state", state);
      return NextResponse.redirect(callback, { status: 302 });
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

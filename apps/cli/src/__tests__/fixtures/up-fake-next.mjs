// `addroid up` smoke-test 用の Next.js factory mock。
//
// 本物の `next` パッケージを呼ばずに `addroid up` から動的 import される
// (`ADDROID_TEST_NEXT_FACTORY_PATH` で差し替え)。`addroid up` 側は
// `prepare()` → `getRequestHandler()` → http.createServer に渡して listen、の
// 順に呼ぶので、その shape を満たす最小実装を返す。
//
// HTTP request が来たら 200 OK で `addroid up fake next` を返し、ヘルスチェック
// (テストが `/` を fetch してもよい) を成立させる。

export default function nextFactory(_opts) {
  return {
    async prepare() {
      // noop — 本物の Next は ここで .next/* を読むが mock では不要。
    },
    getRequestHandler() {
      return async (_req, res) => {
        // 最小限のレスポンス。テストは pid file の存在で startup を判定するため、
        // 実際にこのハンドラに HTTP request が届かなくても test は green になる。
        try {
          if (res && typeof res.statusCode !== "undefined") {
            res.statusCode = 200;
            res.setHeader?.("Content-Type", "text/plain");
            res.end?.("addroid up fake next");
          }
        } catch {
          /* best-effort — テストは HTTP body には依存しない */
        }
      };
    },
    async close() {
      // noop
    },
  };
}

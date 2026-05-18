import assert from "node:assert/strict";
import test from "node:test";
import { extractMetaAdsReadOnlyRows } from "../meta-ads-readonly-runtime.js";

test("extractMetaAdsReadOnlyRows keeps list-style array payloads", () => {
  assert.deepEqual(extractMetaAdsReadOnlyRows([{ id: "1" }, { id: "2" }]), [
    { id: "1" },
    { id: "2" },
  ]);
  assert.deepEqual(extractMetaAdsReadOnlyRows({ data: [{ id: "1" }] }), [{ id: "1" }]);
  assert.deepEqual(extractMetaAdsReadOnlyRows({ rows: [{ id: "2" }] }), [{ id: "2" }]);
  assert.deepEqual(extractMetaAdsReadOnlyRows({ results: [{ id: "3" }] }), [{ id: "3" }]);
});

test("extractMetaAdsReadOnlyRows treats get/current object payloads as one row", () => {
  assert.deepEqual(
    extractMetaAdsReadOnlyRows({
      id: "120228334025200756",
      creative: { id: "1740324726689527" },
    }),
    [
      {
        id: "120228334025200756",
        creative: { id: "1740324726689527" },
      },
    ]
  );
});

test("extractMetaAdsReadOnlyRows ignores empty or unparsable payloads", () => {
  assert.deepEqual(extractMetaAdsReadOnlyRows({}), []);
  assert.deepEqual(extractMetaAdsReadOnlyRows(null), []);
});

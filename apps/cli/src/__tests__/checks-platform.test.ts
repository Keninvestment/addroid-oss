// `checkPlatform` 単体検証。
//
// AdDroid OSS は macOS / Linux / WSL2 を公式サポートし、Windows native は非対応とする
// 契約の最小ガード。runtime での platform 検出が「darwin → ok / linux → ok / win32 →
// error / その他 → warn」の 4 分岐を返すことを assert する。

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkPlatform } from "../lib/checks.js";

describe("checkPlatform", () => {
  it("darwin は ok を返す", () => {
    const r = checkPlatform("darwin");
    assert.equal(r.state, "ok");
    assert.match(r.message, /macOS/);
    assert.equal(r.hint, undefined);
  });

  it("linux は ok を返す (WSL 検出は副作用なし)", () => {
    const r = checkPlatform("linux");
    assert.equal(r.state, "ok");
    assert.match(r.message, /Linux/);
  });

  it("win32 は error を返し WSL2 推奨の hint を含む", () => {
    const r = checkPlatform("win32");
    assert.equal(r.state, "error");
    assert.match(r.message, /Windows native/);
    assert.match(r.message, /非対応/);
    assert.ok(r.hint, "actionable hint must be present");
    assert.match(r.hint!, /WSL2/);
  });

  it("未検証 platform は warn を返す", () => {
    const r = checkPlatform("freebsd" as NodeJS.Platform);
    assert.equal(r.state, "warn");
    assert.match(r.message, /freebsd/);
    assert.match(r.message, /未検証/);
    assert.ok(r.hint, "actionable hint must be present");
  });
});

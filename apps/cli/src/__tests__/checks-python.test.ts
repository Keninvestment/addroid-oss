// Python 3.12+ 検出の境界条件を、実ホストの Python に依存せず検証する。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkMetaAdsCli, checkPython312 } from "../lib/checks.js";

function withPath<T>(pathValue: string, fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o755 });
}

describe("checkPython312", () => {
  it("python3 が 3.13 の場合も Python 3.12+ として ok を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-check-python-"));
    try {
      writeExecutable(path.join(dir, "python3"), "#!/bin/sh\necho 'Python 3.13.1'\n");
      const result = withPath(dir, () => checkPython312());
      assert.equal(result.state, "ok");
      assert.match(result.message, /Python 3\.13\.1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("python3 が 3.11 でも uv-managed Python 3.12 があれば ok を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-check-python-"));
    try {
      writeExecutable(path.join(dir, "python3"), "#!/bin/sh\necho 'Python 3.11.9'\n");
      writeExecutable(path.join(dir, "uv"), "#!/bin/sh\nif [ \"$1 $2\" = 'python find' ]; then echo '/tmp/python-3.13/bin/python3'; exit 0; fi\nexit 1\n");
      const result = withPath(dir, () => checkPython312());
      assert.equal(result.state, "ok");
      assert.match(result.message, /uv-managed Python 3\.12\+/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkMetaAdsCli", () => {
  it("ADDROID_META_CLI_BIN の meta ads subcommand を優先して検出する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-check-meta-"));
    try {
      const meta = path.join(dir, "meta");
      writeExecutable(
        meta,
        "#!/bin/sh\nif [ \"$1 $2\" = 'ads --help' ]; then echo 'Usage: meta ads'; exit 0; fi\nexit 1\n"
      );
      const result = checkMetaAdsCli({ ADDROID_META_CLI_BIN: meta } as unknown as NodeJS.ProcessEnv);
      assert.equal(result.state, "ok");
      assert.match(result.message, /ADDROID_META_CLI_BIN meta ads/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

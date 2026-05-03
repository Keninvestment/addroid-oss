import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadEnvFilesFromRepoRoot, parseEnvFile } from "../env-files.js";

test("parseEnvFile reads simple KEY=value pairs", () => {
  const out = parseEnvFile(
    [
      "DATABASE_URL=postgresql://addroid:addroid@localhost:5432/addroid", // oss-hygiene-allow: env-file parser test fixture, never connects.
      "ENCRYPTION_KEY=abc123",
      "",
    ].join("\n")
  );
  assert.equal(
    out.DATABASE_URL,
    "postgresql://addroid:addroid@localhost:5432/addroid" // oss-hygiene-allow: env-file parser test fixture, never connects.
  );
  assert.equal(out.ENCRYPTION_KEY, "abc123");
});

test("parseEnvFile ignores comments and blank lines", () => {
  const out = parseEnvFile(
    [
      "# top comment",
      "",
      "FOO=bar",
      "  # indented comment",
      "BAZ=qux",
    ].join("\n")
  );
  assert.deepEqual(out, { FOO: "bar", BAZ: "qux" });
});

test("parseEnvFile strips trailing inline `# comment` only when whitespace-separated", () => {
  const out = parseEnvFile(
    [
      "WITH_COMMENT=value # trailing note",
      "URL_WITH_HASH=https://example.com/#anchor",
      "QUOTED=\"value # inside quotes\"",
    ].join("\n")
  );
  assert.equal(out.WITH_COMMENT, "value");
  assert.equal(out.URL_WITH_HASH, "https://example.com/#anchor");
  assert.equal(out.QUOTED, "value # inside quotes");
});

test("parseEnvFile unquotes single and double quoted values", () => {
  const out = parseEnvFile(
    [
      "DOUBLE=\"hello world\"",
      "SINGLE='hello world'",
      "EMPTY=\"\"",
    ].join("\n")
  );
  assert.equal(out.DOUBLE, "hello world");
  assert.equal(out.SINGLE, "hello world");
  assert.equal(out.EMPTY, "");
});

test("parseEnvFile rejects invalid keys silently", () => {
  const out = parseEnvFile(
    [
      "valid=ok",
      "1INVALID=skipped",
      "WITH-DASH=skipped",
      "lower_ok=yes",
    ].join("\n")
  );
  assert.equal(out.valid, "ok");
  assert.equal(out.lower_ok, "yes");
  assert.equal(out["1INVALID"], undefined);
  assert.equal(out["WITH-DASH"], undefined);
});

test("loadEnvFilesFromRepoRoot prefers .env.local over .env and never overrides target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-env-files-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".env"),
      "FROM_ENV=base\nSHARED=from-env\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, ".env.local"),
      "FROM_LOCAL=override\nSHARED=from-local\n",
      "utf8"
    );

    const target: NodeJS.ProcessEnv = { ALREADY_SET: "shell-wins" };
    const result = loadEnvFilesFromRepoRoot(dir, target);

    assert.equal(target.FROM_ENV, "base");
    assert.equal(target.FROM_LOCAL, "override");
    // .env.local must take precedence over .env on shared keys.
    assert.equal(target.SHARED, "from-local");
    // process.env values must always win (caller's explicit shell export).
    assert.equal(target.ALREADY_SET, "shell-wins");

    assert.equal(result.loaded.length, 2);
    assert.ok(result.loaded.some((p) => p.endsWith(".env.local")));
    assert.ok(result.loaded.some((p) => p.endsWith(".env")));
    assert.ok(result.applied.includes("FROM_ENV"));
    assert.ok(result.applied.includes("FROM_LOCAL"));
    assert.ok(result.applied.includes("SHARED"));
    assert.ok(!result.applied.includes("ALREADY_SET"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFilesFromRepoRoot is a no-op when neither file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-env-files-"));
  try {
    const target: NodeJS.ProcessEnv = {};
    const result = loadEnvFilesFromRepoRoot(dir, target);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(target, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseDatabaseUrl, requireDatabaseUrl } from "../database.js";

test("parseDatabaseUrl rejects missing env", () => {
  const v = parseDatabaseUrl({});
  assert.equal(v.ok, false);
});

test("parseDatabaseUrl rejects non-postgres protocol", () => {
  const v = parseDatabaseUrl({ DATABASE_URL: "mysql://x:y@localhost:3306/db" });
  assert.equal(v.ok, false);
});

test("parseDatabaseUrl rejects URL without database name", () => {
  const v = parseDatabaseUrl({ DATABASE_URL: "postgresql://x:y@localhost:5432/" });
  assert.equal(v.ok, false);
});

test("parseDatabaseUrl accepts postgres:// and postgresql:// with explicit port", () => {
  const a = parseDatabaseUrl({ DATABASE_URL: "postgres://u:p@localhost:5432/addroid" });
  const b = parseDatabaseUrl({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/addroid" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok) {
    assert.equal(a.hostname, "localhost");
    assert.equal(a.port, 5432);
    assert.equal(a.database, "addroid");
    assert.equal(a.isLocal, true);
  }
  if (b.ok) {
    assert.equal(b.port, 5433);
    assert.equal(b.isLocal, true);
  }
});

test("parseDatabaseUrl detects non-local host", () => {
  const v = parseDatabaseUrl({
    DATABASE_URL: "postgresql://u:p@db.example.com:5432/addroid",
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.isLocal, false);
    assert.equal(v.hostname, "db.example.com");
  }
});

test("requireDatabaseUrl returns the string when valid, throws otherwise", () => {
  const url = "postgresql://u:p@localhost:5432/addroid";
  assert.equal(requireDatabaseUrl({ DATABASE_URL: url }), url);
  assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL invalid/);
});

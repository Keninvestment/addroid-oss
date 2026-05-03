import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDiskStorage, StoragePathError } from "../storage.js";

async function tempStore(): Promise<{ store: LocalDiskStorage; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addroid-storage-"));
  const store = new LocalDiskStorage({ root: dir });
  await store.ensureRoot();
  return { store, dir };
}

test("write/readText round-trip and exists/stat", async () => {
  const { store, dir } = await tempStore();
  try {
    const w = await store.write("ops/template/README.md", "# hi\n");
    assert.ok(w.path.startsWith(dir));
    assert.equal(w.bytes, "# hi\n".length);
    assert.equal(await store.readText("ops/template/README.md"), "# hi\n");
    assert.equal(await store.exists("ops/template/README.md"), true);
    const stat = await store.stat("ops/template/README.md");
    assert.ok(stat);
    assert.equal(stat?.isFile, true);
    assert.equal(stat?.size, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("write supports binary Uint8Array", async () => {
  const { store, dir } = await tempStore();
  try {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await store.write("blob.bin", bytes);
    const buf = await store.read("blob.bin");
    assert.equal(buf.length, 4);
    assert.equal(buf[0], 0xde);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolve rejects path traversal and absolute keys", () => {
  const store = new LocalDiskStorage({ root: "/tmp/example" });
  assert.throws(() => store.resolve("../etc/passwd"), StoragePathError);
  assert.throws(() => store.resolve("a/../../b"), StoragePathError);
  assert.throws(() => store.resolve("/etc/passwd"), StoragePathError);
  assert.throws(() => store.resolve(""), StoragePathError);
});

test("delete removes files and is no-op for missing keys", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.write("a.txt", "x");
    assert.equal(await store.delete("a.txt"), true);
    assert.equal(await store.exists("a.txt"), false);
    assert.equal(await store.delete("a.txt"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("list returns POSIX-style relative keys recursively, sorted", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.write("a/one.txt", "1");
    await store.write("a/two.txt", "2");
    await store.write("b/three.txt", "3");
    const all = await store.list();
    assert.deepEqual(all, ["a/one.txt", "a/two.txt", "b/three.txt"]);
    const onlyA = await store.list("a");
    assert.deepEqual(onlyA, ["a/one.txt", "a/two.txt"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("list returns [] when prefix does not exist", async () => {
  const { store, dir } = await tempStore();
  try {
    const got = await store.list("never-created");
    assert.deepEqual(got, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

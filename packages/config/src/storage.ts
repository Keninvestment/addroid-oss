// AdDroid OSS — LocalDisk storage.
//
// `~/.addroid/storage/` 配下を path-traversal 安全に読み書きする小さな store。
// 用途: ops repo のローカルクローン、AI 生成成果物の中間ファイル、export ファイル等。
// DB に保存しない大きめのバイナリ / テキストはここに置く。
//
// API は意図的に小さく保つ:
//   - resolve(key)  → 安全な絶対パス
//   - write/read/exists/delete/list
// バックエンドを将来 S3 互換 / GCS 等に差し替えられるよう、key は `/` 区切りの POSIX 風。

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { resolveAddroidPaths } from "./paths.js";

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoragePathError";
  }
}

export interface LocalDiskStorageOptions {
  /** Override the storage root. Defaults to `<addroid home>/storage`. */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

export class LocalDiskStorage {
  readonly root: string;

  constructor(opts: LocalDiskStorageOptions = {}) {
    if (opts.root) {
      this.root = path.resolve(opts.root);
    } else {
      const env = opts.env ?? process.env;
      this.root = resolveAddroidPaths(env).storageDir;
    }
  }

  /**
   * Resolve a relative POSIX-style key to an absolute path inside the root.
   * Throws StoragePathError on traversal or absolute keys.
   */
  resolve(key: string): string {
    if (typeof key !== "string" || key.length === 0) {
      throw new StoragePathError("storage key must be a non-empty string");
    }
    if (key.startsWith("/") || /^[A-Za-z]:[\\/]/.test(key)) {
      throw new StoragePathError(`storage key must be relative (got '${key}')`);
    }
    const normalised = path.posix.normalize(key.replace(/\\/g, "/"));
    if (
      normalised === ".." ||
      normalised.startsWith("../") ||
      normalised.includes("/../") ||
      normalised.endsWith("/..")
    ) {
      throw new StoragePathError(`storage key traverses outside root: '${key}'`);
    }
    const abs = path.resolve(this.root, normalised);
    const rel = path.relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new StoragePathError(`resolved key escapes storage root: '${key}'`);
    }
    return abs;
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async write(key: string, data: string | Uint8Array): Promise<{ path: string; bytes: number }> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (typeof data === "string") {
      await fs.writeFile(abs, data, { encoding: "utf8", mode: 0o600 });
      return { path: abs, bytes: Buffer.byteLength(data, "utf8") };
    }
    await fs.writeFile(abs, data, { mode: 0o600 });
    return { path: abs, bytes: data.byteLength };
  }

  async read(key: string): Promise<Buffer> {
    const abs = this.resolve(key);
    return fs.readFile(abs);
  }

  async readText(key: string): Promise<string> {
    const abs = this.resolve(key);
    return fs.readFile(abs, "utf8");
  }

  async exists(key: string): Promise<boolean> {
    const abs = this.resolve(key);
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number; isFile: boolean } | null> {
    const abs = this.resolve(key);
    try {
      const s = await fs.stat(abs);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const abs = this.resolve(key);
    try {
      await fs.rm(abs, { recursive: true, force: false });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * List file keys under `prefix` (POSIX-style). Recurses through subdirectories.
   * Empty prefix lists everything under the root. Directories are not returned.
   */
  async list(prefix = ""): Promise<string[]> {
    const startAbs = prefix ? this.resolve(prefix) : this.root;
    const out: string[] = [];
    await walk(startAbs, this.root, out);
    return out.sort();
  }
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    const abs = path.join(dir, name);
    if (entry.isDirectory()) {
      await walk(abs, root, out);
    } else if (entry.isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      out.push(rel);
    }
  }
}

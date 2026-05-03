// AdDroid OSS — `@prisma/client` の lazy ESM ファサード (npm 配布用バンドル専用)。
//
// 背景:
//   `@prisma/client` の本体は `module.exports = { ...require('.prisma/client/default') }`
//   という形で生成済み Prisma client を spread する CJS モジュールである。
//   ESM 経由で `import { PrismaClient } from "@prisma/client"` と書くと、Node ESM の
//   cjs-module-lexer が named export を静的解決できず、`prisma generate` を未実行の
//   フレッシュ install (= 本 OSS の npm install 直後) では SyntaxError になる。
//
// 解決:
//   `apps/cli/build.mjs` から esbuild の `alias` で `@prisma/client` を本ファイルに
//   差し替え、CLI バンドル内の `@prisma/client` 参照はすべてここを経由させる。
//   実 CJS の解決は `createRequire` 越しに **遅延** で行うため、`addroid doctor` が
//   `@addroid/db` を import しない限り Prisma client 本体は一切ロードされない。
//
// 影響範囲:
//   本シムは CLI バンドルの中だけで使われる。`apps/web` / `apps/worker` は通常の
//   `@prisma/client` を直接 import するため影響を受けない。

import { createRequire as __addroidCreateRequire } from "node:module";

const __addroidRequire = __addroidCreateRequire(import.meta.url);

let __cachedModule;
function __loadPrismaClient() {
  if (__cachedModule === undefined) {
    __cachedModule = __addroidRequire("@prisma/client");
  }
  return __cachedModule;
}

// `new PrismaClient(...)` を呼んでも実 CJS は読み込まない。`prisma.foo.bar(...)` の
// ように property を実際にアクセスした時点で初めて real client を生成する。
// CLI バンドルは `@addroid/db` の top-level で `new PrismaClient(...)` を実行するが、
// `addroid --help` 等 DB を触らないコマンドでは Proxy が解決されないので
// `.prisma/client/default` 未生成環境でも safe に通る。
function PrismaClient(...args) {
  let __real;
  const __resolve = () => {
    if (__real === undefined) {
      const Real = __loadPrismaClient().PrismaClient;
      __real = new Real(...args);
    }
    return __real;
  };
  return new Proxy(function () {}, {
    get(_t, prop) {
      return __resolve()[prop];
    },
    has(_t, prop) {
      return prop in __resolve();
    },
    apply(_t, _self, callArgs) {
      return __resolve()(...callArgs);
    },
    construct(_t, callArgs) {
      const Real = __loadPrismaClient().PrismaClient;
      return new Real(...callArgs);
    },
  });
}

// `Prisma` namespace (Prisma.JsonNull / PrismaClientKnownRequestError 等) も
// 同様に遅延 Proxy として公開する。worker 側コードからの named import を満たす。
const Prisma = new Proxy(
  {},
  {
    get(_t, prop) {
      const mod = __loadPrismaClient();
      return mod.Prisma ? mod.Prisma[prop] : undefined;
    },
    has(_t, prop) {
      const mod = __loadPrismaClient();
      return mod.Prisma ? prop in mod.Prisma : false;
    },
    ownKeys() {
      const mod = __loadPrismaClient();
      return mod.Prisma ? Reflect.ownKeys(mod.Prisma) : [];
    },
    getOwnPropertyDescriptor(_t, prop) {
      const mod = __loadPrismaClient();
      const ns = mod && mod.Prisma;
      const desc = ns && Object.getOwnPropertyDescriptor(ns, prop);
      if (desc) return { ...desc, configurable: true };
      return undefined;
    },
  }
);

const __defaultProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      const mod = __loadPrismaClient();
      return mod[prop];
    },
    has(_target, prop) {
      const mod = __loadPrismaClient();
      return prop in mod;
    },
    ownKeys() {
      const mod = __loadPrismaClient();
      return Reflect.ownKeys(mod);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const mod = __loadPrismaClient();
      const desc = Object.getOwnPropertyDescriptor(mod, prop);
      if (desc) {
        return { ...desc, configurable: true };
      }
      return undefined;
    },
  }
);

export { PrismaClient, Prisma };
export default __defaultProxy;

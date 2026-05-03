// `addroid backup` / `addroid restore` の境界条件とハッピーパスを検証する。
//
// 実 `pg_dump` / `pg_restore` を CI で起動するのは現実的でないため、
// `runBackupCommand` / `runRestoreCommand` が公開する `BackupRuntimeOverrides`
// 経由で spawn / 確認プロンプト / バイナリ存在判定を fake に差し替え、以下を
// 検証する:
//   - --help / 未知引数 / 引数不足のエラーパス
//   - DATABASE_URL 未設定で exit 2
//   - pg_dump / pg_restore がない環境で actionable error
//   - backup が ~/.addroid/backups/ を作成し pg_dump を期待引数で呼ぶ
//   - restore が --yes なしで confirm プロンプトを出す / "no" で中断する
//   - restore が --no-pgboss / --force-while-up を pg_restore へ伝搬する

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runBackupCommand,
  runRestoreCommand,
  type BackupRuntimeOverrides,
} from "../commands/backup.js";

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture(
  fn: () => Promise<number>
): Promise<{ code: number; out: Captured }> {
  const out: Captured = { stdout: "", stderr: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    out.stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    out.stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function withCleanHome<T>(
  overrides: Record<string, string | undefined>,
  fn: (home: string) => Promise<T>
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-backup-"));
  const keys = ["ADDROID_HOME", "DATABASE_URL", ...Object.keys(overrides)];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.ADDROID_HOME = dir;
  delete process.env.DATABASE_URL;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn(dir);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function makeOverrides(opts: {
  hasBinary?: (cmd: string) => boolean;
  spawnStatus?: number;
  confirm?: boolean;
  onSpawn?: (call: SpawnCall) => Promise<void> | void;
}): { overrides: BackupRuntimeOverrides; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const overrides: BackupRuntimeOverrides = {
    hasBinary: opts.hasBinary ?? (() => true),
    spawn: async (cmd, args, runtimeOpts) => {
      const call: SpawnCall = { cmd, args, env: runtimeOpts.env };
      calls.push(call);
      if (opts.onSpawn) await opts.onSpawn(call);
      return { status: opts.spawnStatus ?? 0 };
    },
    confirm: async () => opts.confirm ?? true,
  };
  return { overrides, calls };
}

describe("addroid backup", () => {
  it("--help は Usage を表示して 0", async () => {
    const { overrides } = makeOverrides({});
    const { code, out } = await capture(() => runBackupCommand(["--help"], overrides));
    assert.equal(code, 0);
    assert.match(out.stdout, /addroid backup/);
    assert.match(out.stdout, /--no-pgboss/);
  });

  it("未知の引数で exit 2", async () => {
    const { overrides } = makeOverrides({});
    const { code, out } = await capture(() => runBackupCommand(["--bogus"], overrides));
    assert.equal(code, 2);
    assert.match(out.stderr, /未知の引数/);
  });

  it("DATABASE_URL 未設定で exit 2", async () => {
    const { overrides } = makeOverrides({});
    await withCleanHome({ DATABASE_URL: undefined }, async () => {
      const { code, out } = await capture(() => runBackupCommand([], overrides));
      assert.equal(code, 2);
      assert.match(out.stderr, /DATABASE_URL/);
    });
  });

  it("pg_dump 不在で actionable error", async () => {
    const { overrides } = makeOverrides({ hasBinary: (cmd) => cmd !== "pg_dump" });
    await withCleanHome(
      { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
      async () => {
        const { code, out } = await capture(() => runBackupCommand([], overrides));
        assert.equal(code, 1);
        assert.match(out.stderr, /pg_dump が見つかりません/);
        assert.match(out.stderr, /postgresql-client/);
      }
    );
  });

  it("既定パスに dump を作成し pg_dump を期待引数で呼ぶ", async () => {
    const { overrides, calls } = makeOverrides({
      onSpawn: async (call) => {
        // pg_dump --file=PATH を fake で 1 byte 書き出して size 表示を成立させる。
        const fileArg = call.args.find((a) => a.startsWith("--file="));
        if (fileArg) {
          const out = fileArg.slice("--file=".length);
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await fs.promises.writeFile(out, "fake dump");
        }
      },
    });
    await withCleanHome(
      { DATABASE_URL: "postgres://addroid:s%40fe@localhost:5432/addroid" },
      async (home) => {
        const { code, out } = await capture(() => runBackupCommand([], overrides));
        assert.equal(code, 0, out.stderr);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.cmd, "pg_dump");
        assert.ok(calls[0]!.args.includes("--format=custom"));
        assert.ok(calls[0]!.args.includes("--host=localhost"));
        assert.ok(calls[0]!.args.includes("--port=5432"));
        assert.ok(calls[0]!.args.includes("--username=addroid"));
        assert.ok(calls[0]!.args.includes("--dbname=addroid"));
        // password は env 経由 (PGPASSWORD)。percent-decode された値であること。
        assert.equal(calls[0]!.env?.PGPASSWORD, "s@fe");
        // 既定では pg-boss を除外しない。
        assert.ok(!calls[0]!.args.some((a) => a === "--exclude-schema=pgboss"));
        // 出力先は ~/.addroid/backups 配下。
        const fileArg = calls[0]!.args.find((a) => a.startsWith("--file="))!;
        const outFile = fileArg.slice("--file=".length);
        assert.ok(outFile.startsWith(path.join(home, "backups")));
        assert.ok(fs.existsSync(outFile));
        assert.match(out.stdout, /\[addroid backup\] 完了/);
      }
    );
  });

  it("--no-pgboss は pg_dump に --exclude-schema=pgboss を追加", async () => {
    const { overrides, calls } = makeOverrides({
      onSpawn: async (call) => {
        const fileArg = call.args.find((a) => a.startsWith("--file="));
        if (fileArg) {
          const out = fileArg.slice("--file=".length);
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await fs.promises.writeFile(out, "fake");
        }
      },
    });
    await withCleanHome(
      { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
      async () => {
        const { code } = await capture(() =>
          runBackupCommand(["--no-pgboss"], overrides)
        );
        assert.equal(code, 0);
        assert.ok(calls[0]!.args.includes("--exclude-schema=pgboss"));
      }
    );
  });

  it("--out で出力先を上書きできる", async () => {
    const { overrides, calls } = makeOverrides({
      onSpawn: async (call) => {
        const fileArg = call.args.find((a) => a.startsWith("--file="));
        if (fileArg) {
          const out = fileArg.slice("--file=".length);
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await fs.promises.writeFile(out, "fake");
        }
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-backup-out-"));
    try {
      const target = path.join(tmp, "custom.dump");
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async () => {
          const { code } = await capture(() =>
            runBackupCommand(["--out", target], overrides)
          );
          assert.equal(code, 0);
          assert.ok(calls[0]!.args.includes(`--file=${target}`));
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pg_dump 失敗時は exit code を伝搬する", async () => {
    const { overrides } = makeOverrides({ spawnStatus: 1 });
    await withCleanHome(
      { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
      async () => {
        const { code, out } = await capture(() => runBackupCommand([], overrides));
        assert.equal(code, 1);
        assert.match(out.stderr, /pg_dump が失敗しました/);
      }
    );
  });
});

describe("addroid restore", () => {
  it("--help は Usage を表示して 0", async () => {
    const { overrides } = makeOverrides({});
    const { code, out } = await capture(() => runRestoreCommand(["--help"], overrides));
    assert.equal(code, 0);
    assert.match(out.stdout, /addroid restore/);
    assert.match(out.stdout, /--force-while-up/);
  });

  it("ファイル指定なしは Usage を表示して 2", async () => {
    const { overrides } = makeOverrides({});
    const { code, out } = await capture(() => runRestoreCommand([], overrides));
    assert.equal(code, 2);
    assert.match(out.stdout, /addroid restore/);
  });

  it("存在しないファイルで exit 1", async () => {
    const { overrides } = makeOverrides({});
    await withCleanHome(
      { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
      async () => {
        const { code, out } = await capture(() =>
          runRestoreCommand(["/nonexistent/dump.dump", "--yes"], overrides)
        );
        assert.equal(code, 1);
        assert.match(out.stderr, /見つかりません/);
      }
    );
  });

  it("--yes なしは confirm を呼び、no で中断する", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-restore-"));
    const dumpFile = path.join(tmp, "test.dump");
    fs.writeFileSync(dumpFile, "fake");
    try {
      const { overrides, calls } = makeOverrides({ confirm: false });
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async () => {
          const { code, out } = await capture(() =>
            runRestoreCommand([dumpFile], overrides)
          );
          assert.equal(code, 1);
          assert.match(out.stdout, /中断しました/);
          assert.equal(calls.length, 0, "pg_restore は呼ばれない");
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--yes は confirm をスキップして pg_restore を呼ぶ", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-restore-"));
    const dumpFile = path.join(tmp, "test.dump");
    fs.writeFileSync(dumpFile, "fake");
    try {
      const { overrides, calls } = makeOverrides({});
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async () => {
          const { code, out } = await capture(() =>
            runRestoreCommand([dumpFile, "--yes"], overrides)
          );
          assert.equal(code, 0, out.stderr);
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.cmd, "pg_restore");
          assert.ok(calls[0]!.args.includes("--clean"));
          assert.ok(calls[0]!.args.includes("--if-exists"));
          assert.ok(calls[0]!.args.includes("--dbname=addroid"));
          assert.ok(calls[0]!.args.includes(dumpFile));
          assert.equal(calls[0]!.env?.PGPASSWORD, "secret");
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--no-pgboss は pg_restore に --exclude-schema=pgboss を追加", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-restore-"));
    const dumpFile = path.join(tmp, "test.dump");
    fs.writeFileSync(dumpFile, "fake");
    try {
      const { overrides, calls } = makeOverrides({});
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async () => {
          const { code } = await capture(() =>
            runRestoreCommand([dumpFile, "--yes", "--no-pgboss"], overrides)
          );
          assert.equal(code, 0);
          assert.ok(calls[0]!.args.includes("--exclude-schema=pgboss"));
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("addroid up 起動中は --force-while-up なしで拒否する", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-restore-"));
    const dumpFile = path.join(tmp, "test.dump");
    fs.writeFileSync(dumpFile, "fake");
    try {
      const { overrides, calls } = makeOverrides({});
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async (home) => {
          // pid file を fake で書き出し parentPid を現在プロセスに (= isProcessAlive=true)
          const runDir = path.join(home, "run");
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(
            path.join(runDir, "up.json"),
            JSON.stringify({
              startedAt: new Date().toISOString(),
              parentPid: process.pid,
              webUrl: "http://127.0.0.1:3000",
              cwd: home,
              mode: "shared",
            })
          );

          const { code, out } = await capture(() =>
            runRestoreCommand([dumpFile, "--yes"], overrides)
          );
          assert.equal(code, 1);
          assert.match(out.stderr, /addroid up が起動中/);
          assert.equal(calls.length, 0);
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--force-while-up は up 中でも pg_restore を起動する", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-restore-"));
    const dumpFile = path.join(tmp, "test.dump");
    fs.writeFileSync(dumpFile, "fake");
    try {
      const { overrides, calls } = makeOverrides({});
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async (home) => {
          const runDir = path.join(home, "run");
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(
            path.join(runDir, "up.json"),
            JSON.stringify({
              startedAt: new Date().toISOString(),
              parentPid: process.pid,
              webUrl: "http://127.0.0.1:3000",
              cwd: home,
              mode: "shared",
            })
          );
          const { code } = await capture(() =>
            runRestoreCommand([dumpFile, "--yes", "--force-while-up"], overrides)
          );
          assert.equal(code, 0);
          assert.equal(calls.length, 1);
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pg_restore 不在で actionable error", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-restore-"));
    const dumpFile = path.join(tmp, "test.dump");
    fs.writeFileSync(dumpFile, "fake");
    try {
      const { overrides } = makeOverrides({
        hasBinary: (cmd) => cmd !== "pg_restore",
      });
      await withCleanHome(
        { DATABASE_URL: "postgres://addroid:secret@localhost:5432/addroid" },
        async () => {
          const { code, out } = await capture(() =>
            runRestoreCommand([dumpFile, "--yes"], overrides)
          );
          assert.equal(code, 1);
          assert.match(out.stderr, /pg_restore が見つかりません/);
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

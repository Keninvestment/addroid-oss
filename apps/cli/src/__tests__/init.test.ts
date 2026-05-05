// `addroid init` の冪等性と境界条件を検証する。
//
// すべて ADDROID_HOME を一時ディレクトリに切り替えて実行し、ユーザーの本物の
// ~/.addroid を一切触らない。E2E smoke-test の前提となる「クリーンな $HOME で
// init が壊れず、繰り返しても破壊しない」ことの自動検証である。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInit } from "../commands/init.js";

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

async function withTempHome<T>(
  fn: (home: string) => Promise<T>
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-init-"));
  const prev = process.env.ADDROID_HOME;
  process.env.ADDROID_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.ADDROID_HOME;
    else process.env.ADDROID_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("init は ADDROID_HOME 配下に storage / logs / run を作成し config / secrets stub を生成する", async () => {
  await withTempHome(async (home) => {
    const { code, out } = await capture(() => runInit([]));
    assert.equal(code, 0, out.stdout + out.stderr);

    for (const sub of ["storage", "logs", "run"]) {
      const stat = fs.statSync(path.join(home, sub));
      assert.ok(stat.isDirectory(), `${sub} should be a directory`);
    }

    const configRaw = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    assert.match(configRaw, /version: 1/);
    assert.match(configRaw, /slug: default/);
    assert.match(configRaw, /executionMode: proposal/);

    const secretsPath = path.join(home, "secrets.local.yaml");
    const secretsStat = fs.statSync(secretsPath);
    assert.ok(secretsStat.isFile());
    if (process.platform !== "win32") {
      // POSIX 上では secrets stub は 0600 で書かれる。
      assert.equal(secretsStat.mode & 0o777, 0o600);
    }

    assert.match(out.stdout, /\[addroid init\]/);
    assert.match(out.stdout, /config 0040.*\(updated\)|config\s+: .*\(updated\)/);
    assert.match(out.stdout, /secrets file/);
  });
});

test("init は二回目の実行で破壊的更新を行わない (config / secrets を保持)", async () => {
  await withTempHome(async (home) => {
    {
      const { code } = await capture(() => runInit([]));
      assert.equal(code, 0);
    }

    // ユーザーが手で値を書き換えたと仮定して上書きする。
    const configPath = path.join(home, "config.yaml");
    const original = fs.readFileSync(configPath, "utf8");
    const edited = original.replace("slug: default", "slug: my-team");
    fs.writeFileSync(configPath, edited, "utf8");
    const editedStat = fs.statSync(configPath);

    const secretsPath = path.join(home, "secrets.local.yaml");
    fs.writeFileSync(secretsPath, "github_oauth_client_secret: redacted\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const secretsContent = fs.readFileSync(secretsPath, "utf8");

    const { code, out } = await capture(() => runInit([]));
    assert.equal(code, 0, out.stdout + out.stderr);

    const after = fs.readFileSync(configPath, "utf8");
    assert.match(after, /slug: my-team/, "user-edited slug must be preserved");

    const afterStat = fs.statSync(configPath);
    // unchanged の場合 mtime はそのままだが、別の事情で書き換わっても致命的ではない。
    // ここでは「内容が保持されていること」を主張するに留める。
    void editedStat;

    const secretsAfter = fs.readFileSync(secretsPath, "utf8");
    assert.equal(secretsAfter, secretsContent, "existing secrets file must be left as-is");
    assert.match(out.stdout, /\(left as-is\)/);

    void afterStat;
  });
});

test("init は executionMode を再 init で黙って戻さない", async () => {
  await withTempHome(async (home) => {
    {
      const { code } = await capture(() => runInit([]));
      assert.equal(code, 0);
    }
    const configPath = path.join(home, "config.yaml");
    const original = fs.readFileSync(configPath, "utf8");
    const edited = original.replace("executionMode: proposal", "executionMode: auto_apply");
    fs.writeFileSync(configPath, edited, "utf8");

    const { code, out } = await capture(() => runInit([]));
    assert.equal(code, 0, out.stdout + out.stderr);
    const after = fs.readFileSync(configPath, "utf8");
    assert.match(after, /executionMode: auto_apply/);
  });
});

test("init は不正な config.yaml を検出して exit 1 で停止し、ファイルを破壊しない", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(home, { recursive: true });
    const configPath = path.join(home, "config.yaml");
    const broken = "version: 1\nworkspace:\n  slug: 1\n"; // slug は string 必須
    fs.writeFileSync(configPath, broken, "utf8");

    const { code, out } = await capture(() => runInit([]));
    assert.equal(code, 1);
    assert.match(out.stderr, /config\.yaml がスキーマと一致しません|スキーマと一致しません/);

    // 元のファイルは破壊されない (init は読めない config を上書きしない契約)。
    const after = fs.readFileSync(configPath, "utf8");
    assert.equal(after, broken);
  });
});

test("init は DATABASE_URL の有無で database.urlRef を再評価する", async () => {
  await withTempHome(async (home) => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { code } = await capture(() => runInit([]));
      assert.equal(code, 0);
      const config = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
      assert.match(config, /urlRef: \.env\.local/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }

    process.env.DATABASE_URL = "postgres://localhost:5432/addroid_test";
    try {
      const { code } = await capture(() => runInit([]));
      assert.equal(code, 0);
      const config = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
      assert.match(config, /urlRef: \(env\)/);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

test("init --non-interactive --yes は .env と workspace 名を初期化する", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    const prevDb = process.env.DATABASE_URL;
    const prevKey = process.env.ENCRYPTION_KEY;
    const prevMetaMock = process.env.ADDROID_META_ADS_CLI_MOCK;
    const prevGithubMock = process.env.ADDROID_GITHUB_OAUTH_MOCK;
    delete process.env.DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ADDROID_META_ADS_CLI_MOCK;
    delete process.env.ADDROID_GITHUB_OAUTH_MOCK;
    try {
      const { code, out } = await capture(() =>
        runInit(
          [
            "--non-interactive",
            "--yes",
            "--project-name",
            "Client Ads",
            "--database-url",
            "postgresql://addroid@localhost:5432/addroid",
            "--env-file",
            envFile,
            "--skip-db-create",
            "--skip-db-push",
            "--skip-deps",
            "--mock-integrations",
          ],
          {
            isTTY: false,
            randomBytes: () => Buffer.alloc(32, 1),
          }
        )
      );
      assert.equal(code, 0, out.stdout + out.stderr);

      const envRaw = fs.readFileSync(envFile, "utf8");
      assert.match(envRaw, /DATABASE_URL=postgresql:\/\/addroid@localhost:5432\/addroid/);
      assert.match(envRaw, /ENCRYPTION_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=/);
      assert.match(envRaw, /ADDROID_META_ADS_CLI_MOCK=1/);

      const configRaw = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
      assert.match(configRaw, /slug: client-ads/);
      assert.match(configRaw, /displayName: Client Ads/);
      assert.match(configRaw, /urlRef: \(env\)/);
      assert.match(out.stdout, /env\s+:/);
      assert.match(out.stdout, /updated: DATABASE_URL, ENCRYPTION_KEY/);
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevKey;
      if (prevMetaMock === undefined) delete process.env.ADDROID_META_ADS_CLI_MOCK;
      else process.env.ADDROID_META_ADS_CLI_MOCK = prevMetaMock;
      if (prevGithubMock === undefined) delete process.env.ADDROID_GITHUB_OAUTH_MOCK;
      else process.env.ADDROID_GITHUB_OAUTH_MOCK = prevGithubMock;
    }
  });
});

test("init --interactive は prompt の回答で .env / config を作る", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    const prevDb = process.env.DATABASE_URL;
    const prevKey = process.env.ENCRYPTION_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;
    const answers = ["Agency Ops", "postgresql://addroid@localhost:5432/addroid"];
    try {
      const { code, out } = await capture(() =>
        runInit(
          [
            "--interactive",
            "--skip-deps",
            "--skip-db-create",
            "--skip-db-push",
            "--env-file",
            envFile,
          ],
          {
            isTTY: true,
            prompt: async () => answers.shift() ?? "",
            confirm: async () => false,
            randomBytes: () => Buffer.alloc(32, 2),
          }
        )
      );
      assert.equal(code, 0, out.stdout + out.stderr);

      const envRaw = fs.readFileSync(envFile, "utf8");
      assert.match(envRaw, /DATABASE_URL=postgresql:\/\/addroid@localhost:5432\/addroid/);
      assert.match(envRaw, /ENCRYPTION_KEY=AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=/);
      const configRaw = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
      assert.match(configRaw, /slug: agency-ops/);
      assert.match(configRaw, /displayName: Agency Ops/);
      assert.match(out.stdout, /Meta Access Token setup:/);
      assert.match(out.stdout, /実際の Meta 広告アカウント.*必須/);
      assert.match(out.stdout, /OAuth callback ではなく Access Token 入力方式/);
      assert.match(out.stdout, /HTTPS callback URL を用意する必要はありません/);
      assert.match(out.stdout, /token 入力後.*Ad Account.*選択/);
      assert.match(out.stdout, /Ready\./);
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevKey;
    }
  });
});

test("init --interactive は Meta Access Token 入力方式を案内し OAuth secret を要求しない", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    const env = {
      ...process.env,
      ADDROID_HOME: home,
    } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    delete env.ENCRYPTION_KEY;
    const answers = [
      "Agency Ops",
      "postgresql://addroid:secret@localhost:5432/addroid",
    ];

    const { code, out } = await capture(() =>
      runInit(
        [
          "--interactive",
          "--skip-deps",
          "--skip-db-create",
          "--skip-db-push",
          "--env-file",
          envFile,
        ],
        {
          env,
          isTTY: true,
          prompt: async () => answers.shift() ?? "",
          confirm: async () => false,
          randomBytes: () => Buffer.alloc(32, 8),
        }
      )
    );

    assert.equal(code, 0, out.stdout + out.stderr);
    const raw = fs.readFileSync(path.join(home, "secrets.local.yaml"), "utf8");
    assert.doesNotMatch(raw, /appId:/);
    assert.doesNotMatch(raw, /appSecret:/);
    assert.doesNotMatch(raw, /appIdCiphertext:/);
    assert.doesNotMatch(raw, /appSecretCiphertext:/);
    assert.match(out.stdout, /Meta Access Token setup:/);
    assert.match(out.stdout, /addroid auth meta/);
    assert.doesNotMatch(out.stdout, /Valid OAuth Redirect URIs/);
  });
});

test("init --non-interactive --db-push は Prisma setup を実行できる", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    const calls: string[] = [];
    const prevDb = process.env.DATABASE_URL;
    const prevKey = process.env.ENCRYPTION_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;
    try {
      const { code, out } = await capture(() =>
        runInit(
          [
            "--non-interactive",
            "--yes",
            "--env-file",
            envFile,
            "--skip-db-create",
            "--skip-deps",
            "--db-push",
          ],
          {
            isTTY: false,
            randomBytes: () => Buffer.alloc(32, 3),
            runCommand: (cmd, args) => {
              calls.push([cmd, ...args].join(" "));
              return { status: 0, stdout: "", stderr: "" };
            },
          }
        )
      );
      assert.equal(code, 0, out.stdout + out.stderr);
      assert.deepEqual(calls.filter((c) => c.startsWith("npm ")), [
        "npm run db:generate",
        "npm run db:push -- --accept-data-loss",
      ]);
      assert.match(out.stdout, /Prisma schema\s+: ok/);
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevKey;
    }
  });
});

test("init --non-interactive --yes は --install-deps なしでは依存インストールを実行しない", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    const calls: string[] = [];
    const env = {
      ...process.env,
      ADDROID_HOME: home,
      HOME: home,
      PATH: "/nonexistent-empty-path-9999",
    } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    delete env.ENCRYPTION_KEY;
    delete env.ADDROID_META_ADS_CLI_MOCK;
    delete env.ADDROID_GITHUB_OAUTH_MOCK;
    delete env.ADDROID_META_CLI_BIN;

    const { code, out } = await capture(() =>
      runInit(
        [
          "--non-interactive",
          "--yes",
          "--env-file",
          envFile,
          "--skip-db-create",
          "--skip-db-push",
        ],
        {
          env,
          isTTY: false,
          randomBytes: () => Buffer.alloc(32, 4),
          runCommand: (cmd, args) => {
            const line = [cmd, ...args].join(" ");
            calls.push(line);
            if (line.includes("curl -LsSf https://astral.sh/uv/install.sh")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (line.includes("uv python install 3.13")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (line.includes("uv tool install meta-ads --python 3.13")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (line.includes("command -v meta")) {
              return { status: 1, stdout: "", stderr: "" };
            }
            if (cmd === "psql") {
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 1, stdout: "", stderr: "not found" };
          },
        }
      )
    );

    assert.equal(code, 0, out.stdout + out.stderr);
    assert.ok(!calls.some((c) => c.includes("uv tool install meta-ads --python 3.13")));
    const envRaw = fs.readFileSync(envFile, "utf8");
    assert.doesNotMatch(envRaw, /ADDROID_META_CLI_BIN=/);
    assert.doesNotMatch(out.stdout, /Meta Ads CLI\s+: ok - Meta Ads CLI installed/);
  });
});

test("init --non-interactive --install-deps は --yes なしでも不足 Meta Ads CLI をセットアップする", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    const calls: string[] = [];
    const env = {
      ...process.env,
      ADDROID_HOME: home,
      HOME: home,
      PATH: "/nonexistent-empty-path-9999",
    } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    delete env.ENCRYPTION_KEY;
    delete env.ADDROID_META_ADS_CLI_MOCK;
    delete env.ADDROID_META_CLI_BIN;

    const { code, out } = await capture(() =>
      runInit(
        [
          "--non-interactive",
          "--install-deps",
          "--env-file",
          envFile,
          "--skip-db-create",
          "--skip-db-push",
        ],
        {
          env,
          isTTY: false,
          randomBytes: () => Buffer.alloc(32, 5),
          runCommand: (cmd, args) => {
            const line = [cmd, ...args].join(" ");
            calls.push(line);
            if (line.includes("curl -LsSf https://astral.sh/uv/install.sh")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (line.includes("uv python install 3.13")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (line.includes("uv tool install meta-ads --python 3.13")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (line.includes("command -v meta")) {
              return { status: 0, stdout: path.join(home, ".local/bin/meta"), stderr: "" };
            }
            return { status: 1, stdout: "", stderr: "not found" };
          },
        }
      )
    );

    assert.equal(code, 0, out.stdout + out.stderr);
    assert.ok(calls.some((c) => c.includes("uv tool install meta-ads --python 3.13")));
    assert.match(out.stdout, /Dependency setup:/);
    assert.match(out.stdout, /Meta Ads CLI\s+: ok - Meta Ads CLI installed/);
    assert.match(fs.readFileSync(envFile, "utf8"), /ADDROID_META_CLI_BIN=.*\/\.local\/bin\/meta/);
  });
});

test("init --non-interactive --yes は既定 DATABASE_URL にランダム password を入れ DB role に設定する", async () => {
  await withTempHome(async (home) => {
    const envFile = path.join(home, ".env");
    let psqlInput = "";
    const env = {
      ...process.env,
      ADDROID_HOME: home,
      HOME: home,
    } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    delete env.ENCRYPTION_KEY;
    delete env.ADDROID_META_ADS_CLI_MOCK;
    delete env.ADDROID_META_CLI_BIN;

    const { code, out } = await capture(() =>
      runInit(
        [
          "--non-interactive",
          "--yes",
          "--env-file",
          envFile,
          "--skip-deps",
          "--skip-db-push",
        ],
        {
          env,
          isTTY: false,
          randomBytes: (size) => Buffer.alloc(size, 6),
          runCommand: (cmd, args, opts) => {
            if ([cmd, ...args].join(" ").includes("command -v meta")) {
              return { status: 1, stdout: "", stderr: "" };
            }
            if (cmd === "psql") {
              psqlInput = opts?.input ?? "";
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 1, stdout: "", stderr: "not found" };
          },
        }
      )
    );

    assert.equal(code, 0, out.stdout + out.stderr);
    const envRaw = fs.readFileSync(envFile, "utf8");
    assert.match(envRaw, /DATABASE_URL=postgresql:\/\/addroid:[A-Za-z0-9_-]+@localhost:5432\/addroid/);
    assert.match(psqlInput, /CREATE ROLE addroid LOGIN PASSWORD '[A-Za-z0-9_-]+'/);
    assert.match(psqlInput, /ALTER ROLE addroid WITH LOGIN PASSWORD '[A-Za-z0-9_-]+'/);
    assert.match(psqlInput, /ALTER SCHEMA public OWNER TO addroid/);
    assert.doesNotMatch(psqlInput, /CREATE ROLE addroid LOGIN;/);
  });
});

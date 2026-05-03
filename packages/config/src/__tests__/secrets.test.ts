import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureSecretsFilePermissions,
  getLocalSecret,
  inspectSecretsFile,
  readLocalSecrets,
  SecretsParseError,
  writeLocalSecrets,
} from "../secrets.js";

async function tempHome(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addroid-secrets-"));
  return { env: { ADDROID_HOME: dir }, dir };
}

test("readLocalSecrets returns null when file is absent", async () => {
  const { env, dir } = await tempHome();
  try {
    const got = await readLocalSecrets(env);
    assert.equal(got, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeLocalSecrets persists a 0600 file and re-reads identical content", async () => {
  const { env, dir } = await tempHome();
  try {
    await fs.mkdir(dir, { recursive: true });
    const wrote = await writeLocalSecrets(
      { github: { oauth: { clientId: "abc", clientSecret: "shh" } } },
      env
    );
    assert.equal(wrote.wrote, true);

    const status = await inspectSecretsFile(env);
    assert.equal(status.exists, true);
    assert.equal(status.worldReadable, false);

    const round = await readLocalSecrets(env);
    assert.deepEqual(round, {
      github: { oauth: { clientId: "abc", clientSecret: "shh" } },
    });

    const second = await writeLocalSecrets(
      { github: { oauth: { clientId: "abc", clientSecret: "shh" } } },
      env
    );
    assert.equal(second.wrote, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("getLocalSecret resolves dotted keys and returns null for missing branches", async () => {
  const { env, dir } = await tempHome();
  try {
    await writeLocalSecrets(
      { github: { oauth: { clientSecret: "topsecret" } } },
      env
    );
    assert.equal(await getLocalSecret("github.oauth.clientSecret", env), "topsecret");
    assert.equal(await getLocalSecret("github.oauth.clientId", env), null);
    assert.equal(await getLocalSecret("meta.accessToken", env), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalSecretsSchema accepts meta.oauth.{appIdCiphertext,appSecretCiphertext,permissions}", async () => {
  const { env, dir } = await tempHome();
  try {
    await writeLocalSecrets(
      {
        meta: {
          oauth: {
            appIdCiphertext: "v1.aes256gcm.fake.iv.tag.app-id",
            appSecretCiphertext: "v1.aes256gcm.fake.iv.tag.payload",
            permissions: ["ads_management", "ads_read", "business_management"],
          },
        },
      },
      env
    );
    const round = await readLocalSecrets(env);
    assert.equal(round?.meta?.oauth?.appIdCiphertext, "v1.aes256gcm.fake.iv.tag.app-id");
    assert.equal(round?.meta?.oauth?.appSecretCiphertext, "v1.aes256gcm.fake.iv.tag.payload");
    assert.deepEqual(round?.meta?.oauth?.permissions, [
      "ads_management",
      "ads_read",
      "business_management",
    ]);
    assert.equal(
      await getLocalSecret("meta.oauth.appIdCiphertext", env),
      "v1.aes256gcm.fake.iv.tag.app-id"
    );
    assert.equal(
      await getLocalSecret("meta.oauth.appSecretCiphertext", env),
      "v1.aes256gcm.fake.iv.tag.payload"
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSecrets surfaces SecretsParseError on bad shape", async () => {
  const { env, dir } = await tempHome();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "secrets.local.yaml"),
      "github:\n  oauth:\n    clientId: 12345\n", // number, schema demands string
      { encoding: "utf8", mode: 0o600 }
    );
    await assert.rejects(() => readLocalSecrets(env), SecretsParseError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalSecretsSchema rejects plaintext meta.oauth.appId / appSecret", async () => {
  const { env, dir } = await tempHome();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "secrets.local.yaml"),
      "meta:\n  oauth:\n    appId: '100000000000001'\n    appSecret: 'plaintext-secret'\n",
      { encoding: "utf8", mode: 0o600 }
    );
    await assert.rejects(() => readLocalSecrets(env), SecretsParseError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ensureSecretsFilePermissions tightens world-readable files", async () => {
  const { env, dir } = await tempHome();
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "secrets.local.yaml");
    await fs.writeFile(file, "{}\n", { encoding: "utf8", mode: 0o644 });
    // writeFile honors umask, so chmod explicitly to guarantee world-readable precondition.
    await fs.chmod(file, 0o644);
    const result = await ensureSecretsFilePermissions(env);
    assert.ok(result);
    assert.equal(result?.tightened, true);
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

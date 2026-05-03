import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_LOCALHOST_HOSTNAMES,
  homeAnchorPath,
  resolveWebBinding,
} from "../paths.js";

test("resolveWebBinding defaults to 127.0.0.1:3000 when env is empty", () => {
  const binding = resolveWebBinding({});
  assert.equal(binding.hostname, "127.0.0.1");
  assert.equal(binding.port, 3000);
});

test("resolveWebBinding accepts 127.0.0.1 / localhost / ::1", () => {
  for (const host of ALLOWED_LOCALHOST_HOSTNAMES) {
    const binding = resolveWebBinding({ ADDROID_WEB_HOSTNAME: host });
    assert.equal(binding.hostname, host);
  }
});

test("resolveWebBinding trims surrounding whitespace before validating", () => {
  const binding = resolveWebBinding({ ADDROID_WEB_HOSTNAME: "  127.0.0.1  " });
  assert.equal(binding.hostname, "127.0.0.1");
});

test("resolveWebBinding rejects 0.0.0.0 (public-interface bind)", () => {
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_HOSTNAME: "0.0.0.0" }),
    /Invalid ADDROID_WEB_HOSTNAME/
  );
});

test("resolveWebBinding rejects arbitrary public hostnames", () => {
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_HOSTNAME: "example.com" }),
    /localhost-bound/
  );
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_HOSTNAME: "10.0.0.5" }),
    /localhost-bound/
  );
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_HOSTNAME: "::" }),
    /localhost-bound/
  );
});

test("resolveWebBinding still rejects invalid ports", () => {
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_PORT: "not-a-number" }),
    /Invalid ADDROID_WEB_PORT/
  );
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_PORT: "0" }),
    /Invalid ADDROID_WEB_PORT/
  );
  assert.throws(
    () => resolveWebBinding({ ADDROID_WEB_PORT: "70000" }),
    /Invalid ADDROID_WEB_PORT/
  );
});

test("resolveWebBinding parses a custom valid port", () => {
  const binding = resolveWebBinding({
    ADDROID_WEB_HOSTNAME: "localhost",
    ADDROID_WEB_PORT: "3100",
  });
  assert.equal(binding.hostname, "localhost");
  assert.equal(binding.port, 3100);
});

test("homeAnchorPath rewrites paths under $HOME to ~/...", () => {
  const home = os.homedir();
  const abs = path.join(home, ".addroid", "config.yaml");
  assert.equal(homeAnchorPath(abs, {}), "~/.addroid/config.yaml");
});

test("homeAnchorPath returns ~ when the path equals $HOME exactly", () => {
  const home = os.homedir();
  assert.equal(homeAnchorPath(home, {}), "~");
});

test("homeAnchorPath anchors ~/.addroid storage paths to $HOME", () => {
  const home = os.homedir();
  const abs = path.join(home, ".addroid", "storage", "creatives", "x.png");
  assert.equal(homeAnchorPath(abs, {}), "~/.addroid/storage/creatives/x.png");
});

test("homeAnchorPath leaves paths outside $HOME untouched", () => {
  const outside = "/var/log/system.log";
  assert.equal(homeAnchorPath(outside, {}), outside);
});

test("homeAnchorPath does not partially match a home-prefixed sibling directory", () => {
  // A sibling directory that shares a prefix but is not under $HOME must NOT
  // be rewritten (e.g., HOME=/tmp/anchor must not turn /tmp/anchor-other into ~/...).
  const fakeHome = path.join(os.tmpdir(), "addroid-anchor-test");
  const sibling = path.join(os.tmpdir(), "addroid-anchor-test-sibling", "file.txt");
  assert.equal(homeAnchorPath(sibling, { HOME: fakeHome }), sibling);
});

test("homeAnchorPath returns the original value for empty input", () => {
  assert.equal(homeAnchorPath("", {}), "");
});

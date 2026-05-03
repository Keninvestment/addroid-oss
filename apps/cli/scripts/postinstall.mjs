#!/usr/bin/env node

if (process.env.ADDROID_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

process.stdout.write(
  [
    "",
    "AdDroid OSS CLI installed.",
    "Next: run `addroid init` to create .env, ~/.addroid/config.yaml, and the local setup checklist.",
    "For CI or scripted setup: `addroid init --non-interactive --yes --skip-deps --skip-db-push`.",
    "To install missing local tools explicitly: `addroid init --install-deps`.",
    "",
  ].join("\n")
);

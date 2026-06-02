#!/usr/bin/env node

if (process.env.ADDROID_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

process.stdout.write(
  [
    "",
    "AdDroid OSS CLI installed.",
    "Global install: run `addroid init` to create .env, ~/.addroid/config.yaml, and the local setup checklist.",
    "Repository checkout: run `npm run addroid -- init` once, then use `addroid <command>` directly.",
    "For CI or scripted setup: `npm run addroid -- init --non-interactive --yes --skip-deps --skip-db-push`.",
    "To install missing local tools explicitly: `npm run addroid -- init --install-deps`.",
    "",
  ].join("\n")
);

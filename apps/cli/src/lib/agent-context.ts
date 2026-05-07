import fs from "node:fs/promises";
import path from "node:path";
import { resolveWebBinding } from "@addroid/config";
import { resolveRepoRoot } from "./paths.js";

const DOC_FILES = [
  "AGENTS.md",
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/SETUP.md",
  "docs/GITOPS.md",
  "docs/META.md",
  "docs/LLM_PROVIDER.md",
  "docs/SECURITY.md",
  "docs/TROUBLESHOOTING.md",
  "docs/SLACK.md",
];

const FALLBACK_AGENT_GUIDE = [
  "# AdDroid Agent Guide",
  "",
  "AdDroid is a localhost-bound, outbound-only operator console for GitOps-driven Meta ad operations.",
  "Use AdDroid tools for status, doctor, auth, accounts, cron, logs, validate, dry-run plan, activate, backup, and down.",
  "Actual ad submission follows ops repo changes, validation, dry-run plan, GitHub PR review/merge, and worker apply.",
  "Never reveal secrets. Never run arbitrary shell. Never restore DBs or mutate Meta outside the audited apply/activate paths.",
].join("\n");

export interface AgentContext {
  content: string;
  webUrl: string;
  loadedDocs: string[];
}

export async function buildAgentContext(
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentContext> {
  const binding = resolveWebBinding(env);
  const webUrl = `http://${binding.hostname}:${binding.port}`;
  const runtime = [
    "# Runtime Snapshot",
    `- Web UI URL: ${webUrl}`,
    `- DATABASE_URL configured: ${env.DATABASE_URL ? "yes" : "no"}`,
    `- ENCRYPTION_KEY configured: ${env.ENCRYPTION_KEY ? "yes" : "no"}`,
    `- ADDROID_LLM_PROVIDER: ${env.ADDROID_LLM_PROVIDER ?? "auto"}`,
    `- Current working directory: ${process.cwd()}`,
  ].join("\n");

  const { sections, loadedDocs } = await loadDocs();
  return {
    webUrl,
    loadedDocs,
    content: [runtime, ...sections].join("\n\n---\n\n"),
  };
}

async function loadDocs(): Promise<{ sections: string[]; loadedDocs: string[] }> {
  const root = resolveRootOrCwd();
  const sections: string[] = [];
  const loadedDocs: string[] = [];
  for (const file of DOC_FILES) {
    const fullPath = path.join(root, file);
    const text = await readText(fullPath);
    if (!text) continue;
    loadedDocs.push(file);
    const limit = file === "AGENTS.md" ? 8_000 : 2_000;
    sections.push(`# ${file}\n${truncate(text, limit)}`);
  }
  if (sections.length === 0) {
    sections.push(FALLBACK_AGENT_GUIDE);
    loadedDocs.push("fallback-agent-guide");
  }
  return { sections, loadedDocs };
}

function resolveRootOrCwd(): string {
  try {
    return resolveRepoRoot();
  } catch {
    return process.cwd();
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n[truncated]`;
}

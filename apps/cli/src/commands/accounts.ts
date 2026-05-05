// `addroid accounts` — Meta Ad Account registration, refresh, and default selection.

import readline from "node:readline/promises";
import {
  MetaAdapterUnauthenticatedError,
  MetaAdapterNotImplementedError,
} from "@addroid/meta-adapter";
import { buildPrismaMetaAdapterSelection } from "../../../worker/src/lib/meta-runtime.js";
import {
  addManualAdAccount,
  ensureCliWorkspace,
  formatAccountLine,
  listRegisteredAccounts,
  normalizeMetaAccountId,
  setDefaultAccount,
  syncMetaAdAccounts,
  type MetaAccountsPrisma,
  type RegisteredAccount,
} from "../lib/meta-accounts.js";

type AccountsAction =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "list"; json: boolean }
  | { kind: "refresh"; json: boolean; selectDefault: boolean }
  | {
      kind: "add";
      json: boolean;
      all: boolean;
      selectDefault: boolean;
      metaAccountId?: string;
      key?: string;
      name?: string;
    }
  | {
      kind: "select";
      json: boolean;
      adAccountId?: string;
      key?: string;
      yes: boolean;
    };

export async function runAccountsCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.kind === "help") {
    printAccountsHelp();
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`[addroid accounts] ${parsed.message}\n\n`);
    printAccountsHelp();
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid accounts] DATABASE_URL が設定されていません。先に `addroid init` を実行してください。\n"
    );
    return 2;
  }

  const { prisma } = await import("@addroid/db");
  try {
    const workspace = await ensureCliWorkspace(prisma);
    if (parsed.kind === "list") {
      const accounts = await listRegisteredAccounts(prisma as MetaAccountsPrisma, workspace.id);
      const defaultId = await loadDefaultId(prisma as MetaAccountsPrisma, workspace.id);
      printAccountList(accounts, defaultId, parsed.json);
      return 0;
    }
    if (parsed.kind === "refresh") {
      const result = await fetchAndSync(prisma as MetaAccountsPrisma, workspace.id);
      const defaultAccount = parsed.selectDefault
        ? await chooseAndSetDefault(prisma as MetaAccountsPrisma, workspace.id, result.accounts, {
            yes: false,
          })
        : result.accounts.length === 1
          ? await setDefaultAccount(
              prisma as MetaAccountsPrisma,
              workspace.id,
              result.accounts[0]!.id,
              "system:accounts-sync"
            )
          : await loadDefaultAccount(prisma as MetaAccountsPrisma, workspace.id);
      printRefreshResult(result, defaultAccount, parsed.json);
      return 0;
    }
    if (parsed.kind === "add") {
      if (parsed.metaAccountId) {
        const row = await addManualAdAccount(prisma as MetaAccountsPrisma, workspace.id, {
          metaAccountId: parsed.metaAccountId,
          key: parsed.key ?? null,
          displayName: parsed.name ?? null,
        });
        const defaultAccount = parsed.selectDefault
          ? await setDefaultAccount(prisma as MetaAccountsPrisma, workspace.id, row.id, "user:cli")
          : await loadDefaultAccount(prisma as MetaAccountsPrisma, workspace.id);
        printAddResult([row], defaultAccount, parsed.json);
        return 0;
      }
      const result = await fetchAndSync(prisma as MetaAccountsPrisma, workspace.id);
      const selected = parsed.all
        ? result.accounts
        : [await chooseOneAccount(result.accounts, { yes: false })];
      let defaultAccount: RegisteredAccount | null = null;
      if (parsed.selectDefault || selected.length === 1) {
        defaultAccount = await setDefaultAccount(
          prisma as MetaAccountsPrisma,
          workspace.id,
          selected[0]!.id,
          "user:cli"
        );
      } else {
        defaultAccount = await loadDefaultAccount(prisma as MetaAccountsPrisma, workspace.id);
      }
      printAddResult(selected, defaultAccount, parsed.json);
      return 0;
    }
    if (parsed.kind === "select") {
      const accounts = await listRegisteredAccounts(prisma as MetaAccountsPrisma, workspace.id);
      const target = resolveSelection(accounts, parsed);
      const selected =
        target ??
        (await chooseOneAccount(accounts, { yes: parsed.yes, promptLabel: "Default account" }));
      const row = await setDefaultAccount(
        prisma as MetaAccountsPrisma,
        workspace.id,
        selected.id,
        "user:cli"
      );
      printSelectResult(row, parsed.json);
      return 0;
    }
    return 2;
  } catch (err) {
    process.stderr.write(`[addroid accounts] ${(err as Error).message}\n`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

export async function fetchAndSync(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<{ registered: number; updated: number; accounts: RegisteredAccount[] }> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma: prisma as never });
  if (selection.choice === "stub") {
    throw new Error(
      `Meta access token support is not configured: ${selection.reason}. Run \`addroid auth meta\` first.`
    );
  }
  try {
    const accounts = await selection.adapter.fetchAdAccounts();
    return syncMetaAdAccounts(prisma, workspaceId, accounts);
  } catch (err) {
    if (
      err instanceof MetaAdapterUnauthenticatedError ||
      err instanceof MetaAdapterNotImplementedError
    ) {
      throw new Error("Meta is not connected. Run `addroid auth meta` first.");
    }
    throw err;
  }
}

async function loadDefaultId(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<string | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultAdAccountId: true },
  });
  return ws?.defaultAdAccountId ?? null;
}

async function loadDefaultAccount(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<RegisteredAccount | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultAdAccountId: true },
  });
  if (!ws?.defaultAdAccountId) return null;
  return prisma.adAccount.findFirst({
    where: { id: ws.defaultAdAccountId, workspaceId },
    select: {
      id: true,
      key: true,
      displayName: true,
      metaAccountId: true,
      businessId: true,
      businessName: true,
      currency: true,
      timezoneName: true,
      accountStatus: true,
    },
  });
}

async function chooseAndSetDefault(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  accounts: RegisteredAccount[],
  opts: { yes: boolean }
): Promise<RegisteredAccount | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1 || opts.yes) {
    return setDefaultAccount(prisma, workspaceId, accounts[0]!.id, "user:cli");
  }
  const selected = await chooseOneAccount(accounts, { yes: false });
  return setDefaultAccount(prisma, workspaceId, selected.id, "user:cli");
}

function resolveSelection(
  accounts: RegisteredAccount[],
  parsed: Extract<AccountsAction, { kind: "select" }>
): RegisteredAccount | null {
  if (accounts.length === 0) {
    throw new Error("No registered ad accounts. Run `addroid accounts add` first.");
  }
  if (parsed.adAccountId) {
    const meta = normalizeMetaAccountId(parsed.adAccountId);
    const found = accounts.find((a) => a.metaAccountId === meta);
    if (!found) throw new Error(`Ad account ${meta} is not registered.`);
    return found;
  }
  if (parsed.key) {
    const found = accounts.find((a) => a.key === parsed.key);
    if (!found) throw new Error(`Ad account key ${parsed.key} is not registered.`);
    return found;
  }
  return null;
}

async function chooseOneAccount(
  accounts: RegisteredAccount[],
  opts: { yes: boolean; promptLabel?: string }
): Promise<RegisteredAccount> {
  if (accounts.length === 0) {
    throw new Error("No ad accounts are available.");
  }
  if (accounts.length === 1 || opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return accounts[0]!;
  }
  process.stdout.write("\n");
  accounts.forEach((a, i) => {
    process.stdout.write(`  ${String(i + 1).padStart(2)}. ${formatAccountLine(a)}\n`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`? ${opts.promptLabel ?? "Ad account"} [1]: `);
    const n = answer.trim() ? Number(answer.trim()) : 1;
    if (!Number.isInteger(n) || n < 1 || n > accounts.length) {
      throw new Error("Invalid selection.");
    }
    return accounts[n - 1]!;
  } finally {
    rl.close();
  }
}

function printAccountList(
  accounts: RegisteredAccount[],
  defaultId: string | null,
  json: boolean
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, defaultAdAccountId: defaultId, accounts }, null, 2)}\n`
    );
    return;
  }
  process.stdout.write("[addroid accounts]\n\n");
  if (accounts.length === 0) {
    process.stdout.write("  No registered ad accounts. Run `addroid accounts add`.\n");
    return;
  }
  for (const account of accounts) {
    process.stdout.write(
      `${formatAccountLine(account, { default: account.id === defaultId })}\n`
    );
  }
}

function printRefreshResult(
  result: { registered: number; updated: number; accounts: RegisteredAccount[] },
  defaultAccount: RegisteredAccount | null,
  json: boolean
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, defaultAccount }, null, 2)}\n`);
    return;
  }
  process.stdout.write("[addroid accounts refresh]\n\n");
  process.stdout.write(`  fetched       : ${result.accounts.length}\n`);
  process.stdout.write(`  registered    : ${result.registered}\n`);
  process.stdout.write(`  updated       : ${result.updated}\n`);
  process.stdout.write(`  default       : ${defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "unset"}\n`);
}

function printAddResult(
  accounts: RegisteredAccount[],
  defaultAccount: RegisteredAccount | null,
  json: boolean
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, accounts, defaultAccount }, null, 2)}\n`);
    return;
  }
  process.stdout.write("[addroid accounts add]\n\n");
  for (const account of accounts) process.stdout.write(`  added/kept     : ${formatAccountLine(account)}\n`);
  process.stdout.write(`  default       : ${defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "unset"}\n`);
}

function printSelectResult(account: RegisteredAccount, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, account }, null, 2)}\n`);
    return;
  }
  process.stdout.write("[addroid accounts select]\n\n");
  process.stdout.write(`  default       : ${account.metaAccountId ?? account.key} (${account.displayName})\n`);
}

function parseArgs(args: string[]): AccountsAction {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return { kind: "help" };
  }
  let json = false;
  let all = false;
  let selectDefault = false;
  let yes = false;
  let metaAccountId: string | undefined;
  let key: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    const next = () => {
      const v = rest[++i];
      if (!v) throw new Error(`${a} requires a value`);
      return v;
    };
    try {
      if (a === "--json") json = true;
      else if (a === "--all") all = true;
      else if (a === "--select-default") selectDefault = true;
      else if (a === "--yes" || a === "-y") yes = true;
      else if (a === "--ad-account-id") metaAccountId = next();
      else if (a.startsWith("--ad-account-id=")) metaAccountId = a.slice("--ad-account-id=".length);
      else if (a === "--key") key = next();
      else if (a.startsWith("--key=")) key = a.slice("--key=".length);
      else if (a === "--name") name = next();
      else if (a.startsWith("--name=")) name = a.slice("--name=".length);
      else return { kind: "error", message: `unknown option: ${a}` };
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
  }
  if (subcommand === "list") return { kind: "list", json };
  if (subcommand === "refresh") return { kind: "refresh", json, selectDefault };
  if (subcommand === "add") {
    return {
      kind: "add",
      json,
      all,
      selectDefault,
      ...(metaAccountId ? { metaAccountId } : {}),
      ...(key ? { key } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (subcommand === "select") {
    return {
      kind: "select",
      json,
      ...(metaAccountId ? { adAccountId: metaAccountId } : {}),
      ...(key ? { key } : {}),
      yes,
    };
  }
  return { kind: "error", message: `unknown subcommand: ${subcommand}` };
}

function printAccountsHelp(): void {
  process.stdout.write(
    [
      "addroid accounts — Meta Ad Account selection",
      "",
      "Usage:",
      "  addroid accounts list [--json]",
      "  addroid accounts refresh [--select-default] [--json]",
      "  addroid accounts add [--all] [--select-default] [--json]",
      "  addroid accounts add --ad-account-id act_123 [--key primary] [--name NAME]",
      "  addroid accounts select [--ad-account-id act_123 | --key primary] [--yes] [--json]",
      "",
    ].join("\n")
  );
}

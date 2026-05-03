// `addroid accounts` の Meta Ad Account 正規化・同期ヘルパーを検証する。

import test from "node:test";
import assert from "node:assert/strict";
import {
  addManualAdAccount,
  normalizeMetaAccountId,
  syncMetaAdAccounts,
  type MetaAccountsPrisma,
  type RegisteredAccount,
} from "../lib/meta-accounts.js";

test("normalizeMetaAccountId は digits を act_ 形式に正規化する", () => {
  assert.equal(normalizeMetaAccountId("1234567890"), "act_1234567890");
  assert.equal(normalizeMetaAccountId("act_1234567890"), "act_1234567890");
  assert.throws(() => normalizeMetaAccountId("abc"), /act_<digits>/);
});

test("syncMetaAdAccounts は OAuth で取得した account metadata を登録・更新する", async () => {
  const prisma = createFakeAccountsPrisma();
  const first = await syncMetaAdAccounts(prisma, "ws_1", [
    {
      accountId: "111",
      metaAccountId: "act_111",
      name: "Main Account",
      businessId: "biz_1",
      businessName: "Main Business",
      currency: "JPY",
      timezoneName: "Asia/Tokyo",
      accountStatus: 1,
    },
  ]);
  assert.equal(first.registered, 1);
  assert.equal(first.updated, 0);
  assert.equal(first.accounts[0]?.businessName, "Main Business");
  assert.equal(first.accounts[0]?.currency, "JPY");

  const second = await syncMetaAdAccounts(prisma, "ws_1", [
    {
      accountId: "111",
      metaAccountId: "act_111",
      name: "Renamed Account",
      businessId: "biz_2",
      businessName: "New Business",
      currency: "USD",
      timezoneName: "America/Los_Angeles",
      accountStatus: 2,
    },
  ]);
  assert.equal(second.registered, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.accounts[0]?.displayName, "Main Account");
  assert.equal(second.accounts[0]?.businessId, "biz_2");
  assert.equal(second.accounts[0]?.accountStatus, 2);
});

test("addManualAdAccount は act_ なしの ID を正規化して登録する", async () => {
  const prisma = createFakeAccountsPrisma();
  const row = await addManualAdAccount(prisma, "ws_1", {
    metaAccountId: "222",
    key: "secondary",
    displayName: "Secondary",
  });
  assert.equal(row.metaAccountId, "act_222");
  assert.equal(row.key, "secondary");
  assert.equal(row.displayName, "Secondary");
});

function createFakeAccountsPrisma(): MetaAccountsPrisma {
  const rows: Array<RegisteredAccount & { workspaceId: string; active: boolean; createdAt: Date }> =
    [];
  const workspace = { id: "ws_1", defaultAdAccountId: null as string | null };
  const selectRow = (row: (typeof rows)[number]): RegisteredAccount => ({
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    metaAccountId: row.metaAccountId,
    businessId: row.businessId,
    businessName: row.businessName,
    currency: row.currency,
    timezoneName: row.timezoneName,
    accountStatus: row.accountStatus,
  });
  return {
    workspace: {
      async findFirst() {
        return { defaultAdAccountId: workspace.defaultAdAccountId };
      },
      async findUnique() {
        return { defaultAdAccountId: workspace.defaultAdAccountId };
      },
      async update(args: unknown) {
        const data = (args as { data: { defaultAdAccountId: string } }).data;
        workspace.defaultAdAccountId = data.defaultAdAccountId;
        return { defaultAdAccountId: workspace.defaultAdAccountId };
      },
    },
    adAccount: {
      async findMany() {
        return rows.map(selectRow);
      },
      async findFirst(args: unknown) {
        const where = (args as { where?: Record<string, unknown> }).where ?? {};
        const found = rows.find((row) => {
          if (where.workspaceId && row.workspaceId !== where.workspaceId) return false;
          if (where.id && row.id !== where.id) return false;
          if (where.metaAccountId && row.metaAccountId !== where.metaAccountId) return false;
          if (where.OR && Array.isArray(where.OR)) {
            return where.OR.some((cond) =>
              Object.entries(cond as Record<string, unknown>).every(
                ([key, value]) => row[key as keyof typeof row] === value
              )
            );
          }
          if (where.active !== undefined && row.active !== where.active) return false;
          return true;
        });
        return found ? selectRow(found) : null;
      },
      async findUnique(args: unknown) {
        const id = (args as { where: { id?: string } }).where.id;
        const found = rows.find((row) => row.id === id);
        return found ? selectRow(found) : null;
      },
      async create(args: unknown) {
        const data = (args as { data: Record<string, unknown> }).data;
        const row = {
          id: `ad_${rows.length + 1}`,
          workspaceId: String(data.workspaceId),
          key: String(data.key),
          displayName: String(data.displayName),
          metaAccountId: data.metaAccountId ? String(data.metaAccountId) : null,
          businessId: data.businessId ? String(data.businessId) : null,
          businessName: data.businessName ? String(data.businessName) : null,
          currency: data.currency ? String(data.currency) : null,
          timezoneName: data.timezoneName ? String(data.timezoneName) : null,
          accountStatus:
            typeof data.accountStatus === "number" ? data.accountStatus : null,
          active: data.active !== false,
          createdAt: new Date(rows.length + 1),
        };
        rows.push(row);
        return selectRow(row);
      },
      async update(args: unknown) {
        const { where, data } = args as {
          where: { id: string };
          data: Partial<(typeof rows)[number]>;
        };
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return selectRow(row);
      },
    },
    auditLog: {
      async create() {
        return {};
      },
    },
  };
}

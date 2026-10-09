/**
 * Integration coverage for the per-key wallet balance feature:
 *   - balance columns persist and read back through getApiKeyMetadata
 *   - getBalanceStatus computes remaining = granted - spent (tokens currency)
 *   - a depleted wallet reports depleted=true
 *
 * Bootstrap mirrors tests/unit/db/api-keys.test.ts (isolated DATA_DIR, fresh DB).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-key-balance-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const balanceStatus = await import("../../../src/lib/db/apiKeyBalanceStatus.ts");

const MACHINE_ID = "machine1234567890";

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function rawRow(id: string): Record<string, unknown> | undefined {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { get: (id: string) => Record<string, unknown> | undefined };
  };
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id);
}

async function insertUsage(apiKeyId: string, tokens: number) {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
  };
  db.prepare(
    `INSERT INTO usage_history
       (provider, model, api_key_id, tokens_input, tokens_output, success, timestamp)
     VALUES ('testprovider', 'testmodel', ?, ?, 0, 1, ?)`
  ).run(apiKeyId, tokens, new Date().toISOString());
}

test("balance columns exist and default to disabled", async () => {
  const created = await apiKeysDb.createApiKey("no-balance", MACHINE_ID);
  const row = rawRow(created.id);
  assert.equal(row?.balance_enabled, 0);
  assert.equal(row?.balance_currency, "usd");
});

test("getApiKeyMetadata surfaces balance fields after enablement", async () => {
  const created = await apiKeysDb.createApiKey("with-balance", MACHINE_ID);
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
  };
  db.prepare(
    `UPDATE api_keys SET balance_enabled = 1, balance_value = 100, balance_currency = 'tokens',
       balance_window_start = '1970-01-01T00:00:00.000Z' WHERE id = ?`
  ).run(created.id);

  const meta = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(meta);
  assert.equal(meta!.balanceEnabled, true);
  assert.equal(meta!.balanceValue, 100);
  assert.equal(meta!.balanceCurrency, "tokens");
});

test("getBalanceStatus: remaining = granted - spent, depleted at <= 0", async () => {
  const created = await apiKeysDb.createApiKey("tokens-wallet", MACHINE_ID);
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
  };
  db.prepare(
    `UPDATE api_keys SET balance_enabled = 1, balance_value = 5000, balance_currency = 'tokens',
       balance_window_start = '1970-01-01T00:00:00.000Z' WHERE id = ?`
  ).run(created.id);

  await insertUsage(created.id, 1200);

  let status = await balanceStatus.getBalanceStatus({
    id: created.id,
    balanceEnabled: true,
    balanceValue: 5000,
    balanceCurrency: "tokens",
    balanceWindowStart: "1970-01-01T00:00:00.000Z",
  });
  assert.ok(status);
  assert.equal(status!.spent, 1200);
  assert.equal(status!.remaining, 3800);
  assert.equal(status!.depleted, false);

  await insertUsage(created.id, 4000);
  status = await balanceStatus.getBalanceStatus({
    id: created.id,
    balanceEnabled: true,
    balanceValue: 5000,
    balanceCurrency: "tokens",
    balanceWindowStart: "1970-01-01T00:00:00.000Z",
  });
  assert.ok(status);
  assert.equal(status!.remaining, -200);
  assert.equal(status!.depleted, true);
});

test("getBalanceStatus returns null when balance is disabled", async () => {
  const created = await apiKeysDb.createApiKey("wallet-off", MACHINE_ID);
  const status = await balanceStatus.getBalanceStatus({
    id: created.id,
    balanceEnabled: false,
    balanceValue: 100,
    balanceCurrency: "usd",
  });
  assert.equal(status, null);
});

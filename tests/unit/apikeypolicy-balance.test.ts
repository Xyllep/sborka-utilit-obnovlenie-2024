/**
 * Integration coverage: enforceApiKeyPolicy blocks a depleted wallet with 402
 * and passes a funded one. Uses the real DB layer (mirrors
 * apikeypolicy-quota-only.test.ts bootstrap).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-apikeypolicy-balance-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "balance-policy-test-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");

rateLimiter.setRateLimiterTestMode(true);

async function loadPolicy(label: string) {
  const modulePath = path.join(process.cwd(), "src/shared/utils/apiKeyPolicy.ts");
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}`);
}

test.after(() => {
  coreDb.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function makeKey(opts: {
  balanceEnabled: boolean;
  balanceValue: number | null;
  currency: string;
}) {
  const created = await apiKeysDb.createApiKey("balance-policy-key", "machine1234567890");
  const db = coreDb.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
  };
  db.prepare(
    `UPDATE api_keys SET balance_enabled = ?, balance_value = ?, balance_currency = ?,
       balance_window_start = '1970-01-01T00:00:00.000Z' WHERE id = ?`
  ).run(opts.balanceEnabled ? 1 : 0, opts.balanceValue, opts.currency, created.id);
  return created;
}

async function insertUsage(apiKeyId: string, tokens: number) {
  const db = coreDb.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
  };
  db.prepare(
    `INSERT INTO usage_history
       (provider, model, api_key_id, tokens_input, tokens_output, success, timestamp)
     VALUES ('testprovider', 'testmodel', ?, ?, 0, 1, ?)`
  ).run(apiKeyId, tokens, new Date().toISOString());
}

function makeRequest(apiKey: string | null) {
  return new Request("http://localhost:20128/v1/chat/completions", {
    method: "POST",
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    body: JSON.stringify({ model: "some/model", messages: [{ role: "user", content: "hi" }] }),
  });
}

test("depleted wallet → 402; funded wallet → pass", async () => {
  const policy = await loadPolicy("balance");

  // Funded: 5000 tokens granted, 1200 spent → pass
  const funded = await makeKey({ balanceEnabled: true, balanceValue: 5000, currency: "tokens" });
  await insertUsage(funded.id, 1200);
  const fundedResult = await policy.enforceApiKeyPolicy(makeRequest(funded.key), "some/model");
  assert.equal(fundedResult.rejection, null);

  // Depleted: 5000 granted, 6000 spent → 402
  const depleted = await makeKey({ balanceEnabled: true, balanceValue: 5000, currency: "tokens" });
  await insertUsage(depleted.id, 6000);
  const depletedResult = await policy.enforceApiKeyPolicy(makeRequest(depleted.key), "some/model");
  assert.ok(depletedResult.rejection);
  assert.equal(depletedResult.rejection.status, 402);
  const bodyText = await depletedResult.rejection
    .clone()
    .text()
    .catch(() => "");
  assert.match(bodyText, /balance exhausted/i);

  // Balance disabled → no blocking even with zero value
  const off = await makeKey({ balanceEnabled: false, balanceValue: 0, currency: "tokens" });
  await insertUsage(off.id, 999999);
  const offResult = await policy.enforceApiKeyPolicy(makeRequest(off.key), "some/model");
  assert.equal(offResult.rejection, null);
});

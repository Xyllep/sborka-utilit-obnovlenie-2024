import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBalanceCurrency,
  parseBalanceValue,
  convertUsd,
  isBalanceCurrency,
} from "../../../src/lib/db/apiKeyBalance.ts";
test("parseBalanceCurrency defaults to usd and accepts aliases", () => {
  assert.equal(parseBalanceCurrency(undefined), "usd");
  assert.equal(parseBalanceCurrency("RUB"), "rub");
  assert.equal(parseBalanceCurrency("token"), "tokens");
  assert.equal(parseBalanceCurrency("nonsense"), "usd");
});

test("parseBalanceValue preserves zero and rejects garbage", () => {
  assert.equal(parseBalanceValue(0), 0);
  assert.equal(parseBalanceValue("12.5"), 12.5);
  assert.equal(parseBalanceValue("abc"), null);
  assert.equal(parseBalanceValue(null), null);
});

test("convertUsd applies rub rate", () => {
  assert.equal(convertUsd(2, "usd"), 2);
  assert.equal(convertUsd(2, "tokens"), 2);
  const rate =
    Number(process.env.BALANCE_USD_RUB_RATE) > 0 ? Number(process.env.BALANCE_USD_RUB_RATE) : 100;
  assert.equal(convertUsd(2, "rub"), 2 * rate);
});

test("isBalanceCurrency", () => {
  assert.equal(isBalanceCurrency("usd"), true);
  assert.equal(isBalanceCurrency("eur"), false);
});

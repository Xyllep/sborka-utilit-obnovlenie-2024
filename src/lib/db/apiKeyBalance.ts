/**
 * Per-API-key wallet ("balance"): $ (USD), ₽ (RUB) or tokens.
 *
 * Semantics (wallet model, mirrors the existing USD usage-limit machinery):
 *   - `balance_value` is the wallet size granted at the last top-up.
 *   - Spending is measured from `balance_window_start` (set on every top-up),
 *     so a refill simply adds to what is left and restarts the measurement window.
 *   - `remaining = balance_value - spentSince(balance_window_start)`.
 *   - When `remaining <= 0` the key policy blocks the request (HTTP 402).
 *
 * USD/RUB spending is derived from `usage_history` cost (same source the daily
 * USD limit uses); token spending sums the raw token counters. Unpriced usage
 * fails closed for money currencies, exactly like the USD usage limit does.
 */

export type BalanceCurrency = "usd" | "rub" | "tokens";

export const BALANCE_CURRENCIES: readonly BalanceCurrency[] = ["usd", "rub", "tokens"];

export function isBalanceCurrency(value: unknown): value is BalanceCurrency {
  return value === "usd" || value === "rub" || value === "tokens";
}

export function parseBalanceCurrency(value: unknown): BalanceCurrency {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "usd" || lower === "rub" || lower === "tokens") return lower;
    if (lower === "token") return "tokens";
  }
  return "usd";
}

/** Preserves 0 (a drained wallet) unlike parseNullablePositiveNumber. */
export function parseBalanceValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** USD → RUB conversion used when a RUB wallet is spent against USD-priced usage. */
export function getUsdRubRate(): number {
  const raw = Number(process.env.BALANCE_USD_RUB_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
}

export function convertUsd(amountUsd: number, currency: BalanceCurrency): number {
  if (currency === "rub") return amountUsd * getUsdRubRate();
  return amountUsd;
}

export function roundBalance(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

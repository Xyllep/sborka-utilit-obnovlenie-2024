/**
 * Balance status + enforcement for per-key wallets (usd / rub / tokens).
 *
 * Reads spending from `usage_history` since the key's balance window start and
 * compares it against `balance_value` in the key's currency. When the remaining
 * amount is <= 0 the key is out of funds and API access is blocked (402).
 */
import { getDbInstance } from "@/lib/db/core";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";
import {
  convertUsd,
  getUsdRubRate,
  parseBalanceCurrency,
  parseBalanceValue,
  roundBalance,
  type BalanceCurrency,
} from "@/lib/db/apiKeyBalance";

export interface BalanceMetadata {
  id: string;
  balanceEnabled?: boolean;
  balanceValue?: number | null;
  balanceCurrency?: BalanceCurrency | string | null;
  balanceWindowStart?: string | null;
}

export interface BalanceStatus {
  enabled: boolean;
  currency: BalanceCurrency;
  granted: number;
  spent: number;
  remaining: number;
  hasUnpricedUsage: boolean;
  depleted: boolean;
  windowStartIso: string | null;
}

interface SpendRow {
  provider: string | null;
  model: string | null;
  serviceTier?: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function getUsageSpendSince(
  apiKeyId: string,
  sinceIso: string,
  currency: BalanceCurrency
): Promise<{ spent: number; hasUnpricedUsage: boolean }> {
  if (!apiKeyId) return { spent: 0, hasUnpricedUsage: false };
  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM usage_history
      WHERE api_key_id = @apiKeyId
        AND timestamp >= @sinceIso
        AND success = 1
      GROUP BY LOWER(provider), LOWER(model), serviceTier
    `
    )
    .all({ apiKeyId, sinceIso }) as SpendRow[];

  let total = 0;
  let hasUnpricedUsage = false;

  if (currency === "tokens") {
    for (const row of rows) {
      total +=
        toNumber(row.promptTokens) +
        toNumber(row.completionTokens) +
        toNumber(row.cacheReadTokens) +
        toNumber(row.cacheCreationTokens) +
        toNumber(row.reasoningTokens);
    }
    return { spent: Math.round(total), hasUnpricedUsage: false };
  }

  for (const row of rows) {
    const provider = typeof row.provider === "string" ? row.provider : "";
    const model = typeof row.model === "string" ? row.model : "";
    if (!provider || !model) continue;

    const { costUsd, priced } = await calculateCostDetailed(
      provider,
      model,
      {
        input: toNumber(row.promptTokens),
        output: toNumber(row.completionTokens),
        cacheRead: toNumber(row.cacheReadTokens),
        cacheCreation: toNumber(row.cacheCreationTokens),
        reasoning: toNumber(row.reasoningTokens),
      },
      {
        provider,
        model,
        serviceTier: row.serviceTier || "standard",
      }
    );
    if (!priced) {
      hasUnpricedUsage = true;
    }
    total += costUsd;
  }

  return {
    spent: roundBalance(convertUsd(total, currency)),
    hasUnpricedUsage,
  };
}

export async function getBalanceStatus(metadata: BalanceMetadata): Promise<BalanceStatus | null> {
  if (metadata?.balanceEnabled !== true) return null;

  const currency = parseBalanceCurrency(metadata.balanceCurrency ?? "usd");
  const grantedRaw = parseBalanceValue(metadata.balanceValue);
  const granted = grantedRaw === null ? 0 : grantedRaw;

  // No top-up yet: window covers everything since epoch (all recorded usage).
  const windowStartIso =
    typeof metadata.balanceWindowStart === "string" && metadata.balanceWindowStart
      ? metadata.balanceWindowStart
      : "1970-01-01T00:00:00.000Z";

  const { spent, hasUnpricedUsage } = await getUsageSpendSince(
    metadata.id,
    windowStartIso,
    currency
  );

  const remaining = roundBalance(granted - spent);
  // A wallet blocks only when the measurable remaining is <= 0. Unpriced usage
  // contributes $0 to `spent` (it is logged, not enforced) so a top-up wallet
  // never locks a paying user out because pricing data is missing.
  const depleted = remaining <= 0;

  return {
    enabled: true,
    currency,
    granted,
    spent,
    remaining,
    hasUnpricedUsage,
    depleted,
    windowStartIso,
  };
}

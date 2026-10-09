import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById } from "@/lib/db/apiKeys";
import { getBalanceStatus } from "@/lib/db/apiKeyBalanceStatus";
import { getDbInstance } from "@/lib/db/core";
import { invalidateCaches } from "@/lib/db/apiKeys";
import { isBalanceCurrency, parseBalanceValue } from "@/lib/db/apiKeyBalance";
import * as log from "@/sse/utils/logger";

// GET /api/keys/[id]/balance - current balance status for a key
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const key = (await getApiKeyById(id)) as Record<string, unknown> | null;
    if (!key || typeof key.id !== "string") {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const status = await getBalanceStatus({
      id: key.id,
      balanceEnabled: key.balanceEnabled === true,
      balanceValue: typeof key.balanceValue === "number" ? key.balanceValue : null,
      balanceCurrency:
        typeof key.balanceCurrency === "string"
          ? (key.balanceCurrency as "usd" | "rub" | "tokens")
          : "usd",
      balanceWindowStart:
        typeof key.balanceWindowStart === "string" ? key.balanceWindowStart : null,
    });

    return NextResponse.json({
      key: {
        id: key.id,
        name: typeof key.name === "string" ? key.name : "",
        balanceEnabled: key.balanceEnabled === true,
        balanceValue: typeof key.balanceValue === "number" ? key.balanceValue : null,
        balanceCurrency: key.balanceCurrency ?? "usd",
        balanceWindowStart: key.balanceWindowStart ?? null,
      },
      status,
    });
  } catch (error) {
    log.error("keys", "Error fetching API key balance", error);
    return NextResponse.json({ error: "Failed to fetch balance" }, { status: 500 });
  }
}

// POST /api/keys/[id]/balance - set or top up the key balance
// Body: { currency: "usd"|"rub"|"tokens", enabled?: boolean,
//         amount?: number (top-up: adds to remaining), setAmount?: number (absolute set) }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key || typeof key.id !== "string") {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const currency = body?.currency;
    if (!isBalanceCurrency(currency)) {
      return NextResponse.json(
        { error: 'currency must be one of: "usd", "rub", "tokens"' },
        { status: 400 }
      );
    }
    if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }

    const hasAmount = body?.amount !== undefined;
    const hasSetAmount = body?.setAmount !== undefined;
    if (!hasAmount && !hasSetAmount && body?.enabled === undefined) {
      return NextResponse.json(
        { error: "Provide amount (top-up), setAmount (absolute) and/or enabled" },
        { status: 400 }
      );
    }

    const currentStatus = await getBalanceStatus({
      id: key.id,
      balanceEnabled: key.balanceEnabled === true,
      balanceValue: typeof key.balanceValue === "number" ? key.balanceValue : null,
      balanceCurrency:
        typeof key.balanceCurrency === "string"
          ? (key.balanceCurrency as "usd" | "rub" | "tokens")
          : "usd",
      balanceWindowStart:
        typeof key.balanceWindowStart === "string" ? key.balanceWindowStart : null,
    });

    const db = getDbInstance();
    const nowIso = new Date().toISOString();
    let newBalanceValue: number;

    if (hasSetAmount) {
      const parsed = parseBalanceValue(body.setAmount);
      if (parsed === null || parsed < 0) {
        return NextResponse.json(
          { error: "setAmount must be a non-negative number" },
          { status: 400 }
        );
      }
      newBalanceValue = parsed;
    } else if (hasAmount) {
      const parsed = parseBalanceValue(body.amount);
      if (parsed === null || parsed <= 0) {
        return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
      }
      // Top-up: current remaining + amount; restart the spending window so the
      // new grant is not consumed by pre-top-up usage.
      const remaining = currentStatus ? Math.max(0, currentStatus.remaining) : 0;
      const currencyChanged = currentStatus ? currentStatus.currency !== currency : true;
      newBalanceValue = currencyChanged ? parsed : remaining + parsed;
    } else {
      // enabled-only update: keep the granted value, restart window when re-enabling
      newBalanceValue = currentStatus?.granted ?? 0;
    }

    db.prepare(
      `UPDATE api_keys
       SET balance_enabled = @enabled,
           balance_value = @value,
           balance_currency = @currency,
           balance_window_start = @windowStart
       WHERE id = @id`
    ).run({
      enabled: body?.enabled === false ? 0 : 1,
      value: newBalanceValue,
      currency,
      windowStart: nowIso,
      id,
    });

    invalidateCaches();

    const status = await getBalanceStatus({
      id,
      balanceEnabled: true,
      balanceValue: newBalanceValue,
      balanceCurrency: currency,
      balanceWindowStart: nowIso,
    });

    return NextResponse.json({
      ok: true,
      key: {
        id,
        balanceEnabled: true,
        balanceValue: newBalanceValue,
        balanceCurrency: currency,
        balanceWindowStart: nowIso,
      },
      status,
    });
  } catch (error) {
    log.error("keys", "Error updating API key balance", error);
    return NextResponse.json({ error: "Failed to update balance" }, { status: 500 });
  }
}

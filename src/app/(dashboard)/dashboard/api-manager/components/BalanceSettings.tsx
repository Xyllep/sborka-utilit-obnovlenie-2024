"use client";

import { useCallback, useEffect, useState } from "react";
import { Input } from "@/shared/components";

type BalanceCurrency = "usd" | "rub" | "tokens";

interface BalanceStatus {
  enabled: boolean;
  currency: BalanceCurrency;
  granted: number;
  spent: number;
  remaining: number;
  depleted: boolean;
}

function symbolFor(currency: BalanceCurrency): string {
  return currency === "usd" ? "$" : currency === "rub" ? "₽" : "";
}

function fmt(value: number, currency: BalanceCurrency): string {
  if (currency === "tokens") return `${Math.round(value)}`;
  return `${symbolFor(currency)}${value.toFixed(2)}`;
}

/**
 * Per-key wallet balance panel (Keys → Access → Limits tab):
 * enable/disable, choose $ / ₽ / tokens, top up or set the balance.
 * Persists immediately via POST /api/keys/[id]/balance.
 */
export function BalanceSettings({ keyId }: { keyId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [currency, setCurrency] = useState<BalanceCurrency>("usd");
  const [status, setStatus] = useState<BalanceStatus | null>(null);
  const [topUp, setTopUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}/balance`);
      if (!res.ok) return;
      const data = await res.json();
      const k = data.key ?? {};
      setEnabled(k.balanceEnabled === true);
      setCurrency((k.balanceCurrency ?? "usd") as BalanceCurrency);
      setStatus(data.status ?? null);
    } finally {
      setLoaded(true);
    }
  }, [keyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}/balance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currency, ...payload }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Failed to update balance");
          return;
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [keyId, currency, load]
  );

  if (!loaded) return null;

  return (
    <div className="mt-1 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">Balance</p>
          <p className="text-xs text-text-muted">
            Prepaid wallet per key. When it hits zero, API access is blocked (HTTP 402).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy}
          onClick={() => save({ enabled: !enabled })}
          className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            enabled
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
              : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">account_balance_wallet</span>
          {enabled ? "On" : "Off"}
        </button>
      </div>

      {enabled && (
        <>
          <div className="mt-3 flex gap-2 items-center">
            {(["usd", "rub", "tokens"] as BalanceCurrency[]).map((c) => (
              <button
                key={c}
                type="button"
                disabled={busy}
                onClick={() => setCurrency(c)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  currency === c
                    ? "bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40"
                    : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
                }`}
              >
                {c === "usd" ? "$ USD" : c === "rub" ? "₽ RUB" : "Tokens"}
              </button>
            ))}
          </div>

          {status && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.03] p-2">
                <p className="text-[10px] text-text-muted uppercase">Granted</p>
                <p className="text-sm font-semibold">{fmt(status.granted, status.currency)}</p>
              </div>
              <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.03] p-2">
                <p className="text-[10px] text-text-muted uppercase">Spent</p>
                <p className="text-sm font-semibold">{fmt(status.spent, status.currency)}</p>
              </div>
              <div
                className={`rounded-md p-2 ${
                  status.depleted ? "bg-red-500/10" : "bg-emerald-500/10"
                }`}
              >
                <p className="text-[10px] text-text-muted uppercase">Remaining</p>
                <p
                  className={`text-sm font-semibold ${
                    status.depleted
                      ? "text-red-600 dark:text-red-400"
                      : "text-emerald-700 dark:text-emerald-300"
                  }`}
                >
                  {fmt(status.remaining, status.currency)}
                </p>
              </div>
            </div>
          )}
          {status?.depleted && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400 font-medium">
              Balance is exhausted — API access for this key is blocked until topped up.
            </p>
          )}

          <div className="mt-3 flex gap-2 items-center">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={topUp}
              onChange={(e) => setTopUp(e.target.value)}
              placeholder={currency === "tokens" ? "100000" : "10.00"}
              className="max-w-[140px]"
            />
            <button
              type="button"
              disabled={busy || !topUp || Number(topUp) <= 0}
              onClick={async () => {
                await save({ amount: Number(topUp) });
                setTopUp("");
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[14px]">add_circle</span>
              Top up
            </button>
            {error && <span className="text-xs text-red-500">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}

import type { ObservabilitySnapshot } from "../../../src/domains/platform/observabilityContracts.js";

export type InventoryBalanceEvidenceRow = { sku_id: string; location_id: string; lot_key?: string | null; reserved?: number | null };

export type ReservedLeaseEvidenceRow = { sku_id: string; location_id: string; lot_key?: string | null; quantity?: number | null; expires_at?: string | null };

// Balance-drift detector: the materialized inventory_balances.reserved column
// must equal the summed quantity of live `reserved` leases (expires_at NULL —
// paid/pinned — or still in the future). Expired-but-still-reserved rows stop
// blocking runtime availability yet keep inflating the balance, which the ATP
// read-model (onHand - reserved - unavailable - safetyStock) turns into false
// sold-out. Compared per (sku, location, lot) on both sides.
export function summarizeReservedBalanceDrift(
  balances: InventoryBalanceEvidenceRow[],
  reservedLeases: ReservedLeaseEvidenceRow[],
  now: Date,
): Pick<ObservabilitySnapshot["payments"], "reservedBalanceDriftCount" | "reservedBalanceDriftEvidence"> {
  const driftKey = (row: { sku_id: string; location_id: string; lot_key?: string | null }) =>
    `${row.sku_id}|${row.location_id}|${row.lot_key ?? ""}`;
  const activeBySlot = new Map<string, number>();
  for (const lease of reservedLeases) {
    if (lease.expires_at && new Date(lease.expires_at).getTime() <= now.getTime()) continue;
    activeBySlot.set(driftKey(lease), (activeBySlot.get(driftKey(lease)) ?? 0) + (lease.quantity ?? 0));
  }
  const drifted = balances.flatMap((balance) => {
    const activeReserved = activeBySlot.get(driftKey(balance)) ?? 0;
    const drift = (balance.reserved ?? 0) - activeReserved;
    if (drift === 0) return [];
    return [{
      skuId: balance.sku_id,
      locationId: balance.location_id,
      lotKey: balance.lot_key ?? null,
      balanceReserved: balance.reserved ?? 0,
      activeReserved,
      drift,
    }];
  });
  return {
    reservedBalanceDriftCount: drifted.length,
    reservedBalanceDriftEvidence: drifted.slice(0, 10),
  };
}

// Pure test stock matrix for the OmniPack catalog seed (W-catalog-seed). Loads our 6 cans
// across the full range — maximal → low → zero — so the stock lifecycle (dispatch, tracking,
// safety-stock alerts) is exercised before go-live. OmniPack and local inventory are seeded
// to the SAME numbers (synced; OmniPack is the stock oracle for a fulfillment house).
//
// Bands (with OMNIPACK_SEED_SAFETY_STOCK = 5): maximal/high/medium are healthy; low/at-safety
// fire a safety_stock WARNING; zero fires a safety_stock CRITICAL (out of stock).

export const OMNIPACK_SEED_SAFETY_STOCK = 5;

export type OmnipackSeedBand = "maximal" | "high" | "medium" | "low" | "at-safety" | "zero";

export interface OmnipackSeedMatrixEntry {
  sku: string;
  targetQuantity: number;
  band: OmnipackSeedBand;
}

// Our 6 active dog-food cans (BATCH_NR+EXP_DATE group). Quantities are the test design;
// EAN/group/pack come from the merchant dictionary, joined by sku in the orchestrator.
export const OMNIPACK_SEED_MATRIX: readonly OmnipackSeedMatrixEntry[] = [
  { sku: "OPENLUP-DOG-LAMB-CAN-400G", targetQuantity: 120, band: "maximal" },
  { sku: "OPENLUP-DOG-VENISON-CAN-400G", targetQuantity: 100, band: "high" },
  { sku: "OPENLUP-DOG-BEEF-CAN-400G", targetQuantity: 30, band: "medium" },
  { sku: "OPENLUP-DOG-TURKEY-CAN-400G", targetQuantity: 6, band: "low" },
  { sku: "OPENLUP-DOG-SALMON-CAN-400G", targetQuantity: 5, band: "at-safety" },
  { sku: "OPENLUP-DOG-PORK-CAN-400G", targetQuantity: 0, band: "zero" },
];

// Deterministic batch for a SKU: a stable lot code + a 12-month expiry from `now`. Pure
// (takes `now`) so re-runs in the same month produce the same lot → idempotent inbound.
export function seedBatchFor(sku: string, now: Date): { lotNumber: string; expirationDate: string } {
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const expiry = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  return { lotNumber: `SEED-${sku}-${yyyymm}`, expirationDate: expiry.toISOString().slice(0, 10) };
}

// Deterministic, account-scoped inbound reference so a re-post is recognized as the same
// receiving document (idempotency) rather than double-receiving stock.
export function inboundReference(accountFingerprint: string, sku: string, quantity: number, lotNumber: string): string {
  return `seed:${accountFingerprint}:${sku}:${quantity}:${lotNumber}`;
}

export interface OmnipackInboundPlanEntry {
  sku: string;
  quantity: number;
  reference: string;
  batch: { lotNumber: string; expirationDate: string };
}

// Builds the inbound plan: one entry per SKU that needs stock received. Skips zero-target
// SKUs (a zero band is the absence of inbound) and SKUs already at/above target in the
// provided getStock snapshot (skip-if-already-at-target → safe, no-op re-runs).
export function buildInboundPlan(
  observedForSaleBySku: Record<string, number>,
  accountFingerprint: string,
  now: Date,
): OmnipackInboundPlanEntry[] {
  return OMNIPACK_SEED_MATRIX.flatMap((entry) => {
    if (entry.targetQuantity <= 0) return [];
    if ((observedForSaleBySku[entry.sku] ?? 0) >= entry.targetQuantity) return [];
    const batch = seedBatchFor(entry.sku, now);
    return [
      {
        sku: entry.sku,
        quantity: entry.targetQuantity,
        reference: inboundReference(accountFingerprint, entry.sku, entry.targetQuantity, batch.lotNumber),
        batch,
      },
    ];
  });
}

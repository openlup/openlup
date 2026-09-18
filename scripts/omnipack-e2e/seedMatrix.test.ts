import { describe, expect, it } from "vitest";
import {
  OMNIPACK_SEED_MATRIX,
  OMNIPACK_SEED_SAFETY_STOCK,
  buildInboundPlan,
  inboundReference,
  seedBatchFor,
} from "./seedMatrix.ts";

const NOW = new Date("2026-06-25T10:00:00.000Z");
const FP = "abc123def456";

describe("omnipack seed matrix", () => {
  it("covers the full range max → low → zero across the 6 cans", () => {
    expect(OMNIPACK_SEED_MATRIX.map((e) => e.sku)).toEqual([
      "OPENLUP-DOG-LAMB-CAN-400G",
      "OPENLUP-DOG-VENISON-CAN-400G",
      "OPENLUP-DOG-BEEF-CAN-400G",
      "OPENLUP-DOG-TURKEY-CAN-400G",
      "OPENLUP-DOG-SALMON-CAN-400G",
      "OPENLUP-DOG-PORK-CAN-400G",
    ]);
    const bands = new Set(OMNIPACK_SEED_MATRIX.map((e) => e.band));
    expect(bands.has("maximal")).toBe(true);
    expect(bands.has("zero")).toBe(true);
    // low/at-safety entries sit at or below the safety stock → fire safety alerts on sync.
    const lowOrAtSafety = OMNIPACK_SEED_MATRIX.filter((e) => e.band === "low" || e.band === "at-safety");
    expect(lowOrAtSafety.every((e) => e.targetQuantity <= OMNIPACK_SEED_SAFETY_STOCK + 1)).toBe(true);
    expect(OMNIPACK_SEED_MATRIX.find((e) => e.band === "zero")?.targetQuantity).toBe(0);
  });

  it("derives a deterministic batch (stable lot + 12-month expiry)", () => {
    const a = seedBatchFor("OPENLUP-DOG-LAMB-CAN-400G", NOW);
    const b = seedBatchFor("OPENLUP-DOG-LAMB-CAN-400G", NOW);
    expect(a).toEqual(b);
    expect(a.lotNumber).toBe("SEED-OPENLUP-DOG-LAMB-CAN-400G-202606");
    expect(a.expirationDate).toBe("2027-06-25");
  });

  it("derives a deterministic, account-scoped inbound reference", () => {
    const ref = inboundReference(FP, "OPENLUP-DOG-LAMB-CAN-400G", 120, "SEED-x");
    expect(ref).toBe("seed:abc123def456:OPENLUP-DOG-LAMB-CAN-400G:120:SEED-x");
    expect(inboundReference(FP, "OPENLUP-DOG-LAMB-CAN-400G", 120, "SEED-x")).toBe(ref);
  });

  it("plans inbound for non-zero SKUs not yet at target, skipping zero + already-stocked", () => {
    const plan = buildInboundPlan({ "OPENLUP-DOG-VENISON-CAN-400G": 100 }, FP, NOW);
    const planned = plan.map((p) => p.sku);
    // PORK is zero (skipped); VENISON already at 100 (skipped); the other 4 are planned.
    expect(planned).not.toContain("OPENLUP-DOG-PORK-CAN-400G");
    expect(planned).not.toContain("OPENLUP-DOG-VENISON-CAN-400G");
    expect(planned).toContain("OPENLUP-DOG-LAMB-CAN-400G");
    expect(plan.find((p) => p.sku === "OPENLUP-DOG-LAMB-CAN-400G")?.batch.lotNumber).toContain("SEED-OPENLUP-DOG-LAMB-CAN-400G");
  });

  it("plans nothing when every SKU is already at/above target (idempotent re-run)", () => {
    const stocked = Object.fromEntries(OMNIPACK_SEED_MATRIX.map((e) => [e.sku, e.targetQuantity]));
    expect(buildInboundPlan(stocked, FP, NOW)).toEqual([]);
  });
});

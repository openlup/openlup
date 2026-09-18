import { describe, expect, it, vi } from "vitest";
import { readPromotionHealthSnapshot } from "./promotionObservabilityRows.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("promotion health RPC reader", () => {
  it("uses one bounded 24-hour RPC and never scans raw promotion tables", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: response(), error: null });
    const from = vi.fn(() => { throw new Error("raw table scan forbidden"); });

    await expect(readPromotionHealthSnapshot({ rpc, from } as never, NOW, true)).resolves.toMatchObject({
      contractVersion: "promotion-health.v1",
      evidence: [],
      moneyEvidence: [],
    });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("commerce_promotion_health_snapshot", {
      p_since: "2026-07-14T12:00:00.000Z",
      p_stale_before: "2026-07-15T11:45:00.000Z",
      p_evidence_limit: 100,
      p_include_health: true,
    });
  });

  it("rejects oversized or open-ended evidence payloads", async () => {
    const oversized = response();
    oversized.evidence = Array.from({ length: 101 }, () => ({
      kind: "stale_reserved",
      claimId: "00000000-0000-4000-8000-000000000001",
      observedAt: "2026-07-15T12:00:00.000Z",
    }));
    const rpc = vi.fn().mockResolvedValue({ data: oversized, error: null });

    await expect(readPromotionHealthSnapshot({ rpc } as never, NOW, true))
      .rejects.toThrow("invalid response");
  });

  it.each([
    { kind: "capacity_exceeded", observedAt: NOW.toISOString() },
    { kind: "lifecycle_mismatch", observedAt: NOW.toISOString() },
  ])("rejects incomplete discriminated evidence: $kind", async (evidence) => {
    const malformed = response();
    malformed.evidence = [evidence];
    const rpc = vi.fn().mockResolvedValue({ data: malformed, error: null });

    await expect(readPromotionHealthSnapshot({ rpc } as never, NOW, true))
      .rejects.toThrow("invalid response");
  });

  it.each([
    { kind: "capacity_exceeded", observedAt: "2026-07-15T12:00:00.000Z" },
    { kind: "lifecycle_mismatch", observedAt: "2026-07-15T12:00:00.000Z" },
    { kind: "missing_claim", observedAt: "2026-07-15T12:00:00.000Z" },
    { kind: "stale_reserved", observedAt: "2026-07-15T12:00:00.000Z" },
  ])("rejects $kind evidence without its kind-specific opaque identifiers", async (evidence) => {
    const invalid = response();
    invalid.evidence = [evidence];
    const rpc = vi.fn().mockResolvedValue({ data: invalid, error: null });

    await expect(readPromotionHealthSnapshot({ rpc } as never, NOW, true))
      .rejects.toThrow("invalid response");
  });
});

function response() {
  return {
    contractVersion: "promotion-health.v1",
    historyCoverage: "post_migration_only",
    measuredAt: "2026-07-15T12:00:00.000Z",
    windowFrom: "2026-07-14T12:00:00.000Z",
    staleBefore: "2026-07-15T11:45:00.000Z",
    aggregates: {
      claims: { reserved: 0, redeemed: 0, released: 0, activeCapacity: 0, staleReserved: 0, staleBlockingCapacity: 0 },
      capacity: { definition: "reserved_plus_redeemed", configuredLimitCodes: 0, atLimitCodes: 0, overLimitCodes: 0 },
      lifecycleMismatchCount: 0,
      missingClaimOrderCount: 0,
      orphanClaimCount: 0,
      promotionMoneyMismatchCount: 0,
    },
    transitionCounts24h: { reserved: 0, redeemed: 0, released: 0, late_paid: 0 },
    evidence: [] as unknown[],
    moneyEvidence: [] as unknown[],
  };
}

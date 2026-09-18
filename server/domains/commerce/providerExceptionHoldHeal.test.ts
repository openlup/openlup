import { describe, expect, it } from "vitest";
import { selectBackfillRows, type HealCandidate } from "./providerExceptionHoldHeal.ts";

function candidate(overrides: Partial<HealCandidate> = {}): HealCandidate {
  return {
    hold_id: "hold-1",
    order_id: "order-1",
    fulfillment_order_id: "ful-1",
    cleared_evidence_id: "evidence-1",
    cleared_provider_status: "suspended",
    cleared_provider_sub_status: "CARRIER_MAPPING_ERROR",
    cleared_occurred_at: "2026-07-15T20:43:55Z",
    ...overrides,
  };
}

describe("provider-exception hold backfill selection", () => {
  it("selects a suspended hold whose parcel was delivered afterwards", () => {
    const rows = selectBackfillRows(
      [candidate()],
      new Map([["ful-1", "2026-07-17T16:25:39Z"]]),
      new Map([["order-1", "OPENLUP-D7898B8C"]]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hold_id: "hold-1",
      order_number: "OPENLUP-D7898B8C",
      delivered_at: "2026-07-17T16:25:39Z",
      cleared_provider_sub_status: "CARRIER_MAPPING_ERROR",
    });
  });

  it("skips a hold whose fulfilment never reached delivered", () => {
    expect(selectBackfillRows([candidate()], new Map([["ful-1", null]]), new Map())).toEqual([]);
  });

  it("skips a hold with no fulfilment row at all", () => {
    expect(selectBackfillRows([candidate()], new Map(), new Map())).toEqual([]);
  });

  it("skips an exception raised after delivery — that is a return, not a stale suspension", () => {
    const rows = selectBackfillRows(
      [candidate({ cleared_occurred_at: "2026-07-18T10:00:00Z" })],
      new Map([["ful-1", "2026-07-17T16:25:39Z"]]),
      new Map(),
    );

    expect(rows).toEqual([]);
  });

  it("skips an exception exactly at the delivery instant (strictly-before proof)", () => {
    const rows = selectBackfillRows(
      [candidate({ cleared_occurred_at: "2026-07-17T16:25:39Z" })],
      new Map([["ful-1", "2026-07-17T16:25:39Z"]]),
      new Map(),
    );

    expect(rows).toEqual([]);
  });

  it("keeps the order number null when the order lookup misses", () => {
    const rows = selectBackfillRows(
      [candidate()],
      new Map([["ful-1", "2026-07-17T16:25:39Z"]]),
      new Map(),
    );

    expect(rows[0]?.order_number).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { stripeRefundEvidence } from "../../../src/payments/stripe/stripeRefundEvidence.js";

const charge = { id: "ch_fixture", amount: 2599, amount_refunded: 2599 };
describe("A2 Stripe refund characterization", () => {
  it("R1 observes full and partial cumulative refund snapshots", () => {
    expect(stripeRefundEvidence("charge.refunded", charge)).toEqual({ refundKind: "full",
      snapshot: { chargeId: "ch_fixture", amountRefundedMinor: 2599 } });
    for (const cumulative of [500, 1200]) {
      expect(stripeRefundEvidence("charge.refunded", { ...charge, amount_refunded: cumulative }))
        .toEqual({ refundKind: "partial", snapshot: { chargeId: "ch_fixture", amountRefundedMinor: cumulative } });
    }
  });

  it("R2 returns null for missing or invalid evidence without inventing a full refund", () => {
    const invalid: Record<string, unknown>[] = [{}, { ...charge, id: " " }, { ...charge, id: null },
      { ...charge, amount: undefined }, { ...charge, amount: 0 }, { ...charge, amount: 25.99 },
      { ...charge, amount_refunded: undefined }, { ...charge, amount_refunded: "2599" },
      { ...charge, amount_refunded: 0 }, { ...charge, amount_refunded: -1 },
      { ...charge, amount_refunded: 2600 }, { ...charge, amount_refunded: NaN },
      { ...charge, amount_refunded: 1.5 }, { ...charge, amount: Number.MAX_SAFE_INTEGER + 1 }];
    for (const snapshot of invalid) expect(stripeRefundEvidence("charge.refunded", snapshot))
      .toEqual({ refundKind: null, snapshot: null });
    expect(stripeRefundEvidence("charge.updated", charge)).toEqual({ refundKind: null, snapshot: null });
  });
});

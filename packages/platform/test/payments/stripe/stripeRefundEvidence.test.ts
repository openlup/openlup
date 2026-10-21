import { describe, expect, it } from "vitest";
import { stripeRefundEvidence } from "../../../src/payments/stripe/stripeRefundEvidence.js";

const charge = { id: "ch_refund_boundary", amount: 10_000, amount_refunded: 3_000 };
const unproven = { refundKind: null, snapshot: null };

describe("stripeRefundEvidence", () => {
  it.each([
    { refunded: 1, kind: "partial" },
    { refunded: 3_000, kind: "partial" },
    { refunded: 10_000, kind: "full" },
  ])("preserves the $refunded cumulative observation as $kind evidence", ({ refunded, kind }) => {
    expect(stripeRefundEvidence("charge.refunded", { ...charge, amount_refunded: refunded })).toEqual({
      refundKind: kind,
      snapshot: { chargeId: charge.id, amountRefundedMinor: refunded },
    });
  });

  it.each<{ name: string; patch: Record<string, unknown> }>([
    { name: "missing original amount", patch: { amount: undefined } },
    { name: "zero original amount", patch: { amount: 0 } },
    { name: "fractional original amount", patch: { amount: 10_000.5 } },
    { name: "unsafe original amount", patch: { amount: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "missing refund amount", patch: { amount_refunded: undefined } },
    { name: "zero refund amount", patch: { amount_refunded: 0 } },
    { name: "negative refund amount", patch: { amount_refunded: -1 } },
    { name: "fractional refund amount", patch: { amount_refunded: 3_000.5 } },
    { name: "string refund amount", patch: { amount_refunded: "10000" } },
    { name: "NaN refund amount", patch: { amount_refunded: NaN } },
    { name: "infinite refund amount", patch: { amount_refunded: Infinity } },
    { name: "refund exceeding the original charge", patch: { amount_refunded: 10_001 } },
    { name: "missing charge identity", patch: { id: undefined } },
    { name: "non-string charge identity", patch: { id: 123 } },
    { name: "blank charge identity", patch: { id: " \t" } },
  ])("cannot prove a refund from $name", ({ patch }) => {
    expect(stripeRefundEvidence("charge.refunded", { ...charge, ...patch })).toEqual(unproven);
  });

  it.each(["payment_intent.succeeded", "refund.failed"])(
    "does not reinterpret %s as a cumulative Charge refund",
    (eventType) => {
      expect(stripeRefundEvidence(eventType, charge)).toEqual(unproven);
    },
  );
});

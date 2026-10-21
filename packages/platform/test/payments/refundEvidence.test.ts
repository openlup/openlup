import { describe, expect, it, vi } from "vitest";
import { createVerifiedPaymentIngress } from "@openlup/platform/payments";
import type { PaymentRefundObservation, RefundEvidencePolicy, VerifiedPaymentEvidence } from "@openlup/platform/payments/contracts";

const original = { amountMinor: 9000, currency: "XXX" };
const base: VerifiedPaymentEvidence = { kind: "money", provider: "provider-a", providerEventId: "event-refund",
  providerOccurredAt: null, fingerprint: "refund-fingerprint", providerPaymentRef: "remote-original",
  intentRef: "intent-original", attemptRef: "attempt-original", outcome: "refunded", money: original };
const input = { rawBody: new TextEncoder().encode('{"refund":{"operation":"operation-original","amount":2100}}'),
  headers: {}, receivedAt: "2026-10-21T10:00:00.000Z" };
function snapshot(amount: number): PaymentRefundObservation {
  return { kind: "cumulative-snapshot", operationId: "operation-original", originalPaymentMoney: original,
    refundedMoney: { amountMinor: amount, currency: "XXX" } };
}
async function deliver(refund: PaymentRefundObservation | undefined, policy?: RefundEvidencePolicy, patch: Partial<VerifiedPaymentEvidence> = {}) {
  const ingest = vi.fn(async (_event: unknown) => ({ paymentEventId: "event-local", paymentIntentId: "intent-original", paymentAttemptId: "attempt-original", replayed: false }));
  const apply = vi.fn(async (_event: unknown) => ({ replayed: false }));
  const observedAmount = refund && "refundedMoney" in refund ? refund.refundedMoney.amountMinor : null;
  const deliveryInput = { ...input, rawBody: new TextEncoder().encode(`{ "refund" : { "operation" : "operation-original", "amount" : ${Number.isFinite(observedAmount) ? observedAmount : "null"} } }`) };
  const result = await createVerifiedPaymentIngress({ provider: patch.provider ?? "provider-a", refundEvidencePolicy: policy,
    verifyPort: { verifyAndNormalize: async () => ({ ...base, refund, ...patch }) },
    paymentControlPort: { ingestPaymentEvent: ingest, applyPaymentResult: apply },
  }).receive(deliveryInput);
  return { ingest, apply, result };
}

describe("refund truth witnesses and evidence policy", () => {
  it.each([[9000, "refunded"], [2100, "partially_refunded"]] as const)(
    "forwards snapshot %i preserving original payment money", async (refunded, status) => {
      const f = await deliver(snapshot(refunded));
      expect(f.result.status).toBe(200);
      expect(f.ingest.mock.calls[0][0]).toMatchObject({ amountMinor: 9000, currency: "XXX",
        rawPayload: { refund: { operation: "operation-original", amount: refunded } } });
      expect(f.apply.mock.calls[0][0]).toMatchObject({ resultStatus: status, paymentIntentId: "intent-original", paymentEventId: "event-local" });
    });
  it("refuses missing observation by default and preserves explicit full-reversal evidence", async () => {
    const missing = await deliver(undefined);
    const full = await deliver({ kind: "full-reversal", reason: "refund", operationId: "reversal-original", originalPaymentMoney: original });
    expect(missing.result.status).toBe(200); expect(missing.ingest).toHaveBeenCalledTimes(1); expect(missing.apply).not.toHaveBeenCalled();
    expect(full.result.status).toBe(200); expect(full.ingest).toHaveBeenCalledTimes(1);
    expect(full.apply.mock.calls[0][0]).toMatchObject({ resultStatus: "refunded" });
  });
  it("forwards repeated cumulative snapshots unchanged without inventing a delta", async () => {
    const first = await deliver(snapshot(2100)), second = await deliver(snapshot(2100));
    expect(second.ingest.mock.calls[0]).toEqual(first.ingest.mock.calls[0]);
    expect(second.apply.mock.calls[0]).toEqual(first.apply.mock.calls[0]);
    expect(second.ingest.mock.calls[0][0]).toMatchObject({ amountMinor: 9000,
      rawPayload: { refund: { operation: "operation-original", amount: 2100 } } });
  });
  it("requires amount and identity for snapshot and delta before terminal apply", async () => {
    for (const kind of ["cumulative-snapshot", "event-delta"] as const) {
      for (const refund of [
        { ...snapshot(2100), kind, operationId: "" },
        { ...snapshot(2100), kind, refundedMoney: { amountMinor: Number.NaN, currency: "XXX" } },
        { ...snapshot(2100), kind, refundedMoney: { amountMinor: 2100, currency: "invalid" } },
      ]) {
        const f = await deliver(refund);
        expect(f.result.status).toBe(400); expect(f.ingest).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
      }
      const delta = await deliver({ ...snapshot(2100), kind });
      expect(delta.apply.mock.calls[0][0]).toMatchObject({ resultStatus: "partially_refunded" });
    }
    for (const patch of [{ money: null }, { providerPaymentRef: "" }]) {
      const f = await deliver(snapshot(2100), undefined, patch);
      expect(f.result.status).toBe(400); expect(f.apply).not.toHaveBeenCalled();
    }
  });
  it("reproduces the default-to-full only with explicit legacy opt-in", async () => {
    for (const provider of ["provider-a", "provider-b"]) {
      const implicit = await deliver(undefined, undefined, { provider });
      expect(implicit.apply).not.toHaveBeenCalled();
    }
    const f = await deliver(undefined, "legacy-assume-full");
    expect(f.result.status).toBe(200);
    expect(f.apply.mock.calls[0][0]).toMatchObject({ resultStatus: "refunded" });
  });
  it("keeps full reversal refund and chargeback variants valid with exact original money", async () => {
    for (const reason of ["refund", "chargeback"] as const) {
      const f = await deliver({ kind: "full-reversal", reason, operationId: "reversal-original", originalPaymentMoney: original });
      expect(f.result.status).toBe(200);
      expect(f.apply.mock.calls[0][0]).toMatchObject({ resultStatus: reason === "refund" ? "refunded" : "disputed" });
      const invalid = await deliver({ kind: "full-reversal", reason, operationId: "", originalPaymentMoney: original });
      expect(invalid.apply).not.toHaveBeenCalled();
    }
  });
});

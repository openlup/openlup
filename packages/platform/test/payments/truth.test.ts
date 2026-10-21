import { expect, it, vi } from "vitest";
import { createVerifiedPaymentIngress, paymentSourceFingerprint, paymentPayloadFingerprint,
  paymentTruthFingerprint, assertPaymentTruthEvent, paymentReconciliationFingerprint } from "@openlup/platform/payments";
import type { VerifiedPaymentEvidence } from "@openlup/platform/payments/contracts";

it("forwards webhook identity and canonical fingerprints through the durable host seam", async () => {
  const at = "2026-10-21T00:00:00.000Z";
  const payload = { original: true };
  const source = { sourceEventId: "event-original", eventKind: "payment.succeeded", settlementIntentId: "intent-original",
    amountMinor: 4990, currency: "XXX", occurredAt: at, payloadFingerprint: paymentPayloadFingerprint(payload) };
  const fingerprint = paymentSourceFingerprint(source);
  expect(fingerprint).toBe("f1347a8003ef9f2f5595c11b4df9cb8b26c3418700959b978c9fd71db23f4e87");
  const evidence: VerifiedPaymentEvidence = { kind: "money", provider: "provider-a", providerEventId: "event-original",
    providerOccurredAt: null, fingerprint, providerPaymentRef: "remote-original", intentRef: "intent-original",
    attemptRef: "attempt-original", money: { amountMinor: 4990, currency: "XXX" }, outcome: "succeeded" };
  const transcript: unknown[] = [];
  const ingest = vi.fn(async (event: { providerEventId: string; paymentIntentId?: string | null; paymentAttemptId?: string | null;
    amountMinor?: number | null; currency?: string | null; eventType: string; occurredAt: string; rawPayload: Record<string, unknown> }) => {
    const sourceEvidence = { sourceKind: "accepted_event" as const, sourceReference: event.providerEventId, observedStatus: event.eventType,
      observedAt: event.occurredAt, payloadFingerprint: paymentPayloadFingerprint(event.rawPayload) };
    transcript.push({ providerEventId: event.providerEventId, paymentIntentId: event.paymentIntentId, paymentAttemptId: event.paymentAttemptId,
      payload: { ...event.rawPayload, truth: { fingerprint: paymentSourceFingerprint({ ...source, payloadFingerprint: sourceEvidence.payloadFingerprint }), evidence: sourceEvidence } } });
    return { paymentEventId: "event-local", paymentIntentId: "intent-original", paymentAttemptId: "attempt-original", replayed: false };
  });
  const apply = vi.fn(async (value: unknown) => { transcript.push(value); return { replayed: false }; });
  const result = await createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: async () => evidence },
    paymentControlPort: { ingestPaymentEvent: ingest, applyPaymentResult: apply },
  }).receive({ rawBody: new TextEncoder().encode('{ "original" : true }'), headers: {}, receivedAt: at });
  expect(transcript[0]).toMatchObject({ providerEventId: "event-original", paymentIntentId: "intent-original", paymentAttemptId: "attempt-original",
    payload: { original: true, truth: { fingerprint, evidence: { sourceKind: "accepted_event", sourceReference: "event-original",
      observedStatus: "payment.succeeded", observedAt: at, payloadFingerprint: "6d245f89d84e8d1dfc9dc22db417b500630901b858d5a2869af44dba6e01fa39" } } } });
  expect(transcript[1]).toMatchObject({ idempotencyKey: "provider-webhook:provider-a:event-original:apply", paymentEventId: "event-local", paymentIntentId: "intent-original" });
  expect(result.status).toBe(200);
  const truth = { sourceEventId: source.sourceEventId, settlementIntentId: "intent-original", idempotencyKey: "truth-key-original",
    outcome: "captured" as const, amountMinor: 4990, currency: "XXX", occurredAt: at, failure: null,
    evidence: { sourceKind: "accepted_event" as const, sourceReference: source.sourceEventId, observedStatus: source.eventKind,
      observedAt: at, payloadFingerprint: source.payloadFingerprint } };
  assertPaymentTruthEvent(truth);
  expect(paymentTruthFingerprint({ ...truth, idempotencyKey: "another-key" })).toBe(paymentTruthFingerprint(truth));
  expect(() => assertPaymentTruthEvent({ ...truth, amountMinor: 0 })).toThrow("payment_truth_amount_invalid");
  expect(() => paymentReconciliationFingerprint({ eventId: "event-local", idempotencyKey: "reconcile-key", evidenceStatus: "failed",
    outcome: "captured", occurredAt: at, failure: null, evidence: truth.evidence })).toThrow("payment_reconciliation_failure_cannot_terminalize");
});

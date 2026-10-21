import { describe, expect, it, vi } from "vitest";
import { createVerifiedPaymentIngress } from "@openlup/platform/payments";
const AT = "2026-10-21T10:00:00.000Z";
describe("public subscription confirmation forwarding", () => {
  it("forwards the original paid intent, method and event key through verified subscription confirmation", async () => {
    const trace: string[] = [];
    const apply = vi.fn(async () => { trace.push("apply"); return { replayed: false }; });
    const upsert = vi.fn(async () => { trace.push("method"); return { replayed: false }; });
    const confirm = vi.fn(async (_input: unknown) => { trace.push("confirm"); return { confirmed: true, status: "active" }; });
    const ingest = vi.fn(async () => { trace.push("ingest"); return { paymentEventId: "event-paid",
      paymentIntentId: "intent-original", paymentAttemptId: "attempt-original", replayed: false }; });
    const rawBody = new TextEncoder().encode("original verified bytes");
    const verify = vi.fn(async () => ({ kind: "money" as const, provider: "provider-a", providerEventId: "event-paid",
      providerPaymentRef: "remote-original", providerOccurredAt: AT, fingerprint: "original-fingerprint",
      intentRef: "intent-original", attemptRef: "attempt-original", outcome: "succeeded" as const,
      money: { amountMinor: 9100, currency: "XXX" } }));
    const result = await createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: verify },
      paymentControlPort: { ingestPaymentEvent: ingest, applyPaymentResult: apply, confirmSubscriptionActivation: confirm },
      // Host-owned stored linkage, already authorized to the original obligation.
      createPorts: event => {
        event.reusableMethod = { clientId: "client-original", subscriptionId: "sub-original",
          providerMethodRef: "method-original", providerCustomerRef: "customer-original", methodKind: "card", status: "active" };
        return { paymentControlPort: { ingestPaymentEvent: ingest, applyPaymentResult: apply }, methodRefPort: { upsertFromWebhook: upsert },
          afterProcessed: async ({ event: processed, ingested, resultStatus }) => {
            if (resultStatus !== "succeeded" || !ingested.paymentIntentId) return;
            await confirm({ idempotencyKey: `provider-webhook:provider-a:${processed.providerEventId}:confirm`,
              paymentIntentId: ingested.paymentIntentId, occurredAt: processed.occurredAt,
              methodRef: processed.reusableMethod?.providerMethodRef ?? null, methodKind: processed.reusableMethod?.methodKind ?? null });
          } };
      },
    }).receive({ rawBody, headers: { proof: "original" }, receivedAt: AT });
    expect(verify).toHaveBeenCalledExactlyOnceWith({ rawBody, headers: { proof: "original" }, receivedAt: AT });
    expect(trace).toEqual(["ingest", "apply", "method", "confirm"]);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ providerEventId: "event-paid",
      providerPaymentId: "remote-original", amountMinor: 9100, currency: "XXX" }));
    expect(apply).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "provider-webhook:provider-a:event-paid:apply",
      paymentIntentId: "intent-original", paymentEventId: "event-paid", resultStatus: "succeeded", occurredAt: AT, failureReason: null });
    expect(upsert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reusableMethod: expect.objectContaining({ subscriptionId: "sub-original", providerMethodRef: "method-original" }) }));
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "provider-webhook:provider-a:event-paid:confirm",
      paymentIntentId: "intent-original", methodRef: "method-original", methodKind: "card", occurredAt: AT });
    expect(result.status).toBe(200);
  });
});

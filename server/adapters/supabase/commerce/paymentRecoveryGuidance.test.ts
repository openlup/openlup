import { evidencePayload } from "../../../domains/payment/paymentProviderReconciliationEvidence.js";
import { normalizeStripeIntent } from "../../stripe/stripePaymentReconciliationProvider.js";
import { stripeFailureEvidence } from "../../stripe/stripeFailureEvidence.js";
import { createPaymentRecoveryEvidenceNormalizer } from "../../paymentRecoveryGuidance.js";
import { describe, expect, it, vi } from "vitest";
import type { PaymentRecoveryEvidence } from "@openlup/core/payment";
import { createSupabasePaymentRecoveryGuidancePort } from "./paymentRecoveryGuidance.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const paymentIntentId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const tokenId = "55555555-5555-4555-8555-555555555555";
const target = { orderId, paymentIntentId };
const normalized: PaymentRecoveryEvidence = {
  refusalVerified: true, cause: "generic_decline", certainty: "verified", disclosure: "safe",
  method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" },
  operation: "one_time_payment", advice: null,
};
function response() {
  return {
    snapshot: {
      orderId, clientId, orderStatus: "pending_payment", paymentIntentId,
      intentStatus: "failed", paymentAttemptId: attemptId, attemptStatus: "failed",
      provider: "test_rail", providerPaymentId: "payment-1", updatedAt: "2026-09-11T12:00:00+00:00",
      failureReason: "provider_declined", subscriptionId: null as string | null,
      orderMode: "one_time", subscriptionStatus: null as string | null,
      paidAt: null as string | null, hasExactGap: false,
    },
    eligible: true, tokenAuthorized: false, historyComplete: true, observedSuccess: false,
    attempts: [{ id: attemptId, status: "failed", provider: "test_rail",
      providerPaymentId: "payment-1", providerFlow: "sample_flow", createdAt: "2026-09-11T12:00:00Z",
      evidence: [{ version: 1, source: "execution" }] as unknown[] }],
  };
}
function setup(data: unknown = response(), error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const normalize = vi.fn<({ provider, evidence }: { provider: string; evidence: unknown[] }) => PaymentRecoveryEvidence | null>()
    .mockReturnValue(normalized);
  const port = createSupabasePaymentRecoveryGuidancePort({ rpc }, normalize);
  return { port, rpc, normalize };
}

describe("consistent checkout guidance snapshot adapter", () => {
  it("makes one RPC and derives status and normalized history from that response", async () => {
    const { port, rpc, normalize } = setup();
    const result = await port.getGuidanceSnapshot(target);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("commerce_checkout_payment_guidance_snapshot", {
      p_order_id: orderId, p_payment_intent_id: paymentIntentId, p_recovery_token_id: null,
    });
    expect(result).toMatchObject({ ...target, clientId, intentStatus: "failed",
      purchaseContext: "one_time", eligible: true, subscriptionActivationStatus: "not_applicable",
      subscriptionStatus: null,
      attempts: [{ id: attemptId, status: "failed", evidence: normalized }] });
    expect(normalize).toHaveBeenCalledExactlyOnceWith({
      provider: "test_rail", evidence: [{ version: 1, source: "execution" }],
    });
    expect(result).not.toHaveProperty("orderMode");
    expect(result?.attempts[0]).toMatchObject({ provider: "test_rail", providerFlow: "sample_flow" });
  });

  it("passes only the validated token ID into the atomic recheck", async () => {
    const data = response(); data.tokenAuthorized = true;
    const { port, rpc } = setup(data);
    const result = await port.getGuidanceSnapshot({ ...target, recoveryTokenId: tokenId });
    expect(rpc.mock.calls[0][1].p_recovery_token_id).toBe(tokenId);
    expect(result?.tokenAuthorized).toBe(true);
    expect(JSON.stringify(result)).not.toContain(tokenId);
  });

  it("retains authoritative paid status when the token is no longer authorized", async () => {
    const data = response();
    Object.assign(data.snapshot, { orderStatus: "paid", intentStatus: "succeeded", attemptStatus: "succeeded" });
    data.attempts[0].status = "succeeded";
    const result = await setup(data).port.getGuidanceSnapshot({ ...target, recoveryTokenId: tokenId });
    expect(result).toMatchObject({ orderStatus: "paid", intentStatus: "succeeded", tokenAuthorized: false });
  });

  it("uses the exact paid-gap status from the same snapshot", async () => {
    const data = response();
    Object.assign(data.snapshot, { orderMode: "subscription_cycle", subscriptionId: tokenId,
      subscriptionStatus: "pending_activation", orderStatus: "paid", intentStatus: "succeeded",
      paidAt: "2000-01-01T00:00:00Z", hasExactGap: true });
    const result = await setup(data).port.getGuidanceSnapshot(target);
    expect(result).toMatchObject({ purchaseContext: "subscription_initial", subscriptionActivationStatus: "action_required",
      subscriptionStatus: "pending_activation" });
    data.snapshot.hasExactGap = false;
    expect((await setup(data).port.getGuidanceSnapshot(target))?.subscriptionActivationStatus).toBe("not_applicable");
  });

  it("preserves unknown origin and incomplete evidence without inferring a method", async () => {
    const data = response(); data.eligible = false; data.historyComplete = false;
    data.attempts[0].evidence = [];
    const { port, normalize } = setup(data);
    const result = await port.getGuidanceSnapshot(target);
    expect(result).toMatchObject({ purchaseContext: null, eligible: false, historyComplete: false,
      attempts: [{ id: attemptId, evidence: null }] });
    expect(normalize).not.toHaveBeenCalled();
  });

  it("preserves deterministic SQL order and does not compute a counter", async () => {
    const data = response();
    data.attempts.push({ ...data.attempts[0], id: tokenId, createdAt: "2026-09-10T12:00:00Z" });
    const result = await setup(data).port.getGuidanceSnapshot(target);
    expect(result?.attempts.map((attempt) => attempt.id)).toEqual([attemptId, tokenId]);
    expect(result).not.toHaveProperty("consecutiveRefusals");
  });

  it("returns null only for an authoritative missing snapshot", async () => {
    const { port, normalize } = setup(null);
    expect(await port.getGuidanceSnapshot(target)).toBeNull();
    expect(normalize).not.toHaveBeenCalled();
  });

  it.each(["PGRST202", "42501", "57014"])("throws on RPC failure %s for legacy fallback", async (code) => {
    const { port } = setup(null, { code, message: "sensitive upstream detail" });
    await expect(port.getGuidanceSnapshot(target)).rejects.toThrow("payment_recovery_snapshot_unavailable");
  });

  it.each(["intentStatus", "attemptStatus", "orderStatus"])("rejects an unknown %s instead of coercing it", async (key) => {
    const data = response(); Object.assign(data.snapshot, { [key]: "new_unknown_status" });
    await expect(setup(data).port.getGuidanceSnapshot(target)).rejects.toThrow("payment_recovery_snapshot_invalid");
  });

  it("rejects malformed history, unknown fields, mismatched IDs and impossible context", async () => {
    const malformed = response(); malformed.attempts[0].status = "not_a_status";
    await expect(setup(malformed).port.getGuidanceSnapshot(target)).rejects.toThrow("snapshot_invalid");
    await expect(setup({ ...response(), token: "unexpected" }).port.getGuidanceSnapshot(target)).rejects.toThrow("snapshot_invalid");
    const mismatch = response(); mismatch.snapshot.orderId = tokenId;
    await expect(setup(mismatch).port.getGuidanceSnapshot(target)).rejects.toThrow("identity_mismatch");
    const impossible = response(); impossible.snapshot.orderMode = "unknown";
    await expect(setup(impossible).port.getGuidanceSnapshot(target)).rejects.toThrow("context_invalid");
  });

  it("rejects transport bounds being exceeded instead of silently slicing them", async () => {
    const data = response(); data.attempts[0].evidence = Array.from({ length: 33 }, () => ({}));
    await expect(setup(data).port.getGuidanceSnapshot(target)).rejects.toThrow("snapshot_invalid");
    data.attempts[0].evidence = [];
    data.attempts = Array.from({ length: 101 }, () => data.attempts[0]);
    await expect(setup(data).port.getGuidanceSnapshot(target)).rejects.toThrow("snapshot_invalid");
  });
});


it("projects actual reconciliation producer evidence from providerPayload, including unapplied normalized success", async () => {
  const attempt = { paymentAttemptId: attemptId, paymentIntentId, orderId, paymentId: tokenId,
    subscriptionId: null, subscriptionCycleId: null, provider: "stripe", providerPaymentId: "payment-1",
    providerAttemptId: "payment-1", providerSessionId: null, attemptStatus: "processing", intentStatus: "processing",
    amountMinor: 100, currency: "XTS", orderMode: "one_time", cycleRetryAttempt: 0, cycleNextRetryAt: null,
    localUpdatedAt: "2026-09-11T12:00:00Z" } satisfies Parameters<typeof evidencePayload>[0];
  const providerObject = { id: "payment-1", status: "requires_payment_method", latest_charge: "charge-1",
    last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds",
      payment_method: { type: "card" } } };
  const status = normalizeStripeIntent({ ...providerObject,
    diagnosticFailureEvidence: stripeFailureEvidence(providerObject, { source: "readback" })! });
  const stored = evidencePayload(attempt, status, { applied: false });
  expect(stored).not.toHaveProperty("failureEvidence");
  expect(stored).toMatchObject({ normalizedStatus: "failed", providerPayload: { failureEvidence: {
    declineCode: "insufficient_funds", source: "readback" } } });
  const data = response(); data.snapshot.provider = "stripe"; data.attempts[0].provider = "stripe";
  // SQL pgTAP pins this same stored nesting and performs correlation before projection.
  data.attempts[0].evidence = [(stored.providerPayload as Record<string, unknown>).failureEvidence];
  const port = createSupabasePaymentRecoveryGuidancePort({ rpc: vi.fn().mockResolvedValue({ data, error: null }) },
    createPaymentRecoveryEvidenceNormalizer());
  expect((await port.getGuidanceSnapshot(target))?.attempts[0].evidence).toMatchObject({
    refusalVerified: true, cause: "insufficient_funds", method: { kind: "card" } });
  const successfulReadback = evidencePayload(attempt, { ...status, status: "succeeded" }, { applied: false, silenceOverdue: false });
  expect(successfulReadback).toMatchObject({ normalizedStatus: "succeeded", applied: false });
  expect(successfulReadback).not.toHaveProperty("resultStatus");
});

import { describe, expect, it, vi } from "vitest";
import type { PaymentRecoveryEvidence } from "@openlup/core/payment";
import { createCheckoutPaymentContinuationCodec } from "./checkoutPaymentContinuationCredential.js";
import { readAuthorizedPaymentRecovery, type PaymentRecoverySnapshot } from "./paymentRecoveryGuidanceAuthorization.js";
import { hashCheckoutRecoveryToken } from "./checkoutRecoveryToken.js";

const ids = {
  orderId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
  paymentIntentId: "33333333-3333-4333-8333-333333333333", paymentAttemptId: "44444444-4444-4444-8444-444444444444",
};
const now = Date.parse("2026-09-11T08:00:00Z");
const request = { orderId: ids.orderId, clientId: ids.clientId, paymentIntentId: ids.paymentIntentId,
  journeyId: "checkout:55555555-5555-4555-8555-555555555555" };
const codec = createCheckoutPaymentContinuationCodec("synthetic-test-signing-root-at-least-32-bytes", { now: () => new Date(now) })!;
const cookie = codec.issue({ ...ids, journeyId: request.journeyId, executionRail: "stripe" }).setCookie;
const claims = codec.verifyCookieHeader(cookie)!;
const activationRefusal: PaymentRecoveryEvidence = { refusalVerified: true, cause: "generic_decline", certainty: "unknown",
  disclosure: "safe", advice: null, operation: "recurring_setup",
  method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" } };
function snapshot(overrides: Partial<PaymentRecoverySnapshot> = {}): PaymentRecoverySnapshot {
  return { ...ids, orderStatus: "pending_payment", intentStatus: "failed", attemptStatus: "failed", provider: "stripe",
    providerPaymentId: "pi_synthetic", updatedAt: new Date(now).toISOString(), failureReason: "provider_declined",
    subscriptionActivationStatus: "not_applicable", subscriptionId: null, subscriptionStatus: null, eligible: true, purchaseContext: "one_time",
    tokenAuthorized: false, historyComplete: true, observedSuccess: false, attempts: [{ id: ids.paymentAttemptId, status: "failed", evidence: {
      refusalVerified: true, cause: "generic_decline", certainty: "unknown", disclosure: "safe", advice: null,
      method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" }, operation: "one_time_payment",
    } }], ...overrides };
}
function reader(value: PaymentRecoverySnapshot | null = snapshot()) {
  return { getGuidanceSnapshot: vi.fn(async () => value) };
}

describe("recovery guidance authority", () => {
  it("accepts a genuinely signed cookie only for its current attempt and projects bounded public facts", async () => {
    const port = reader();
    const result = await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, deps: { port }, now });
    expect(port.getGuidanceSnapshot).toHaveBeenCalledExactlyOnceWith({ orderId: ids.orderId, paymentIntentId: ids.paymentIntentId });
    expect(result?.guidance).toEqual({ version: 1, paymentAttemptId: ids.paymentAttemptId, purchaseContext: "one_time",
      cause: "generic_decline", methodKind: "card", methodKey: "card", operation: "one_time_payment", restriction: null,
      actions: ["change_instrument", "change_method"], consecutiveRefusals: 1, emphasis: "normal" });
    expect(JSON.stringify(result?.guidance)).not.toContain("pi_synthetic");
  });

  it.each([
    ["card", "stripe", "one_time_payment", "one_time", "provider_declined"],
    ["blik", "tpay", "blik_one_time", "one_time", "provider_declined"],
    ["blik", "tpay", "blik_recurring_activation", "subscription_initial", "blik_recurring_unsupported_bank"],
  ] as const)("authorizes exact legacy %s refusal from server attempt provenance", async (
    method, provider, providerFlow, purchaseContext, failureReason,
  ) => {
    const value = snapshot({ provider, failureReason, purchaseContext,
      subscriptionId: purchaseContext === "subscription_initial" ? ids.clientId : null,
      subscriptionStatus: purchaseContext === "subscription_initial" ? "pending_activation" : null,
      attempts: [{ id: ids.paymentAttemptId, status: "failed", provider, providerFlow, evidence: null }] });
    const result = await readAuthorizedPaymentRecovery({ request, claims: { ...claims, executionRail: provider },
      authorization: undefined, deps: { port: reader(value) }, now });
    expect(result?.guidance).toMatchObject({ paymentAttemptId: ids.paymentAttemptId, methodKey: method,
      cause: failureReason === "blik_recurring_unsupported_bank" ? "recurring_setup_failed" : "generic_decline" });
  });

  it("offers a fresh code, not a refused agreement, after a BLIK activation refusal without the mandate decision", async () => {
    const value = snapshot({ provider: "tpay", purchaseContext: "subscription_initial", subscriptionId: ids.clientId,
      subscriptionStatus: "pending_activation", attempts: [{ id: ids.paymentAttemptId, status: "failed", provider: "tpay",
        providerFlow: "blik_recurring_activation", evidence: activationRefusal }] });
    const result = await readAuthorizedPaymentRecovery({ request, claims: { ...claims, executionRail: "tpay" },
      authorization: undefined, deps: { port: reader(value) }, now });
    expect(result?.guidance).toMatchObject({ cause: "generic_decline", methodKey: "blik", operation: "recurring_setup",
      restriction: null, actions: ["change_instrument", "change_method"] });
  });

  it.each<[string, PaymentRecoveryEvidence, "recurring_setup_failed" | "generic_decline"]>([
    ["BLIK activation evidence", activationRefusal, "recurring_setup_failed"],
    ["evidence without the activation", { ...activationRefusal, operation: null }, "generic_decline"],
  ])("constrains a proof-less mandate decision on %s to another method", async (_name, evidence, cause) => {
    const value = snapshot({ provider: "tpay", failureReason: "blik_recurring_unsupported_bank", historyComplete: false,
      purchaseContext: "subscription_initial", subscriptionId: ids.clientId, subscriptionStatus: "pending_activation",
      attempts: [{ id: ids.paymentAttemptId, status: "failed", provider: "tpay", providerFlow: "blik_recurring_activation", evidence }] });
    const result = await readAuthorizedPaymentRecovery({ request, claims: { ...claims, executionRail: "tpay" },
      authorization: undefined, deps: { port: reader(value) }, now });
    expect(result?.guidance).toMatchObject({ cause, methodKey: "blik", restriction: "method", actions: ["change_method"] });
  });

  it("keeps a proof-less mandate decision without any projection non-actionable", async () => {
    const value = snapshot({ provider: "tpay", failureReason: "blik_recurring_unsupported_bank", historyComplete: false,
      purchaseContext: "subscription_initial", subscriptionId: ids.clientId, subscriptionStatus: "pending_activation",
      attempts: [{ id: ids.paymentAttemptId, status: "failed", provider: "tpay", providerFlow: "blik_recurring_activation", evidence: null }] });
    const result = await readAuthorizedPaymentRecovery({ request, claims: { ...claims, executionRail: "tpay" },
      authorization: undefined, deps: { port: reader(value) }, now });
    expect(result?.guidance).toBeNull();
  });

  it("never lets a BLIK mandate reason restrict a refusal whose evidence is another method", async () => {
    const value = snapshot({ failureReason: "blik_recurring_unsupported_bank", purchaseContext: "subscription_initial",
      subscriptionId: ids.clientId, subscriptionStatus: "pending_activation" });
    const result = await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, deps: { port: reader(value) }, now });
    expect(result?.guidance).toMatchObject({ cause: "generic_decline", methodKey: "card", restriction: null,
      actions: ["change_instrument", "change_method"] });
  });

  it.each([
    ["unknown reason", "future_failure", "stripe", "one_time_payment", "one_time"],
    ["ambiguous provider flow", "provider_declined", "tpay", "pbl_one_time", "one_time"],
    ["missing flow", "provider_declined", "stripe", null, "one_time"],
    ["one-time BLIK flow in subscription context", "provider_declined", "tpay", "blik_one_time", "subscription_initial"],
    ["recurring BLIK flow in one-time context", "provider_declined", "tpay", "blik_recurring_activation", "one_time"],
  ] as const)("keeps %s non-actionable", async (_name, failureReason, provider, providerFlow, purchaseContext) => {
    const value = snapshot({ provider, failureReason, purchaseContext,
      attempts: [{ id: ids.paymentAttemptId, status: "failed", provider, providerFlow, evidence: null }] });
    const result = await readAuthorizedPaymentRecovery({ request, claims: { ...claims, executionRail: provider },
      authorization: undefined, deps: { port: reader(value) }, now });
    expect(result?.guidance).toBeNull();
  });

  it.each([{ observedSuccess: true }, { historyComplete: false }, {
    attempts: [{ id: ids.paymentAttemptId, status: "succeeded" as const, provider: "stripe",
      providerFlow: "one_time_payment", evidence: null }],
  }])("never revives legacy refusal guidance when success/history safety is %j", async (override) => {
    const value = snapshot({ ...override, attempts: "attempts" in override ? override.attempts : [
      { id: ids.paymentAttemptId, status: "failed", provider: "stripe", providerFlow: "one_time_payment", evidence: null },
    ] });
    const result = await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined,
      deps: { port: reader(value) }, now });
    expect(result?.guidance).toBeNull();
  });

  it.each(["orderId", "clientId", "paymentIntentId", "journeyId"] as const)("rejects a cookie outside its %s scope before reading history", async (key) => {
    const port = reader();
    expect(await readAuthorizedPaymentRecovery({ request: { ...request, [key]: "another" }, claims,
      authorization: undefined, deps: { port }, now })).toBeNull();
    expect(port.getGuidanceSnapshot).not.toHaveBeenCalled();
  });

  it.each([null, codec.verifyCookieHeader(cookie.replace("=", "=tampered"))])("does not treat matching guessed IDs as authority", async (untrusted) => {
    const port = reader();
    expect(await readAuthorizedPaymentRecovery({ request, claims: untrusted, authorization: undefined, deps: { port }, now })).toBeNull();
    expect(port.getGuidanceSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an expired verified claim before history access", async () => {
    const port = reader();
    expect(await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, deps: { port }, now: claims.expiresAt * 1000 })).toBeNull();
    expect(port.getGuidanceSnapshot).not.toHaveBeenCalled();
  });

  it.each([{ paymentAttemptId: "other" }, { provider: "tpay" }, { eligible: false }, { purchaseContext: null }] as Partial<PaymentRecoverySnapshot>[])(
    "withholds guidance for stale scope, renewal or ineligible context %j", async (overrides) => {
      const value = snapshot(overrides);
      expect(await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, deps: { port: reader(value) }, now }))
        .toEqual({ snapshot: value, guidance: null });
    });

  it.each(["orderId", "clientId", "paymentIntentId"] as const)("fails back on an inconsistent snapshot %s", async (key) => {
    expect(await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined,
      deps: { port: reader(snapshot({ [key]: "different" })) }, now })).toBeNull();
  });

  it("validates the opaque token and passes only its row ID for atomic liveness recheck", async () => {
    const raw = "rcv_synthetic-opaque-token";
    const storedHash = hashCheckoutRecoveryToken(raw);
    const validate = vi.fn(async (token: string) => hashCheckoutRecoveryToken(token) === storedHash ? {
      tokenId: "token-row", orderId: ids.orderId, clientId: ids.clientId, mode: "subscription_cycle", status: "pending_payment",
    } : null);
    const port = reader(snapshot({ tokenAuthorized: true, purchaseContext: "subscription_initial" }));
    const result = await readAuthorizedPaymentRecovery({ request: { ...request, journeyId: undefined }, claims: null,
      authorization: `Bearer ${raw}`, deps: { port, tokenPort: { validate } }, now });
    expect(validate).toHaveBeenCalledExactlyOnceWith(raw);
    expect(port.getGuidanceSnapshot).toHaveBeenCalledExactlyOnceWith({ orderId: ids.orderId, paymentIntentId: ids.paymentIntentId, recoveryTokenId: "token-row" });
    expect(result?.guidance?.purchaseContext).toBe("subscription_initial");
    expect(JSON.stringify(port.getGuidanceSnapshot.mock.calls)).not.toContain(raw);
  });

  it("withholds guidance when a previously valid token is revoked before the snapshot", async () => {
    const value = snapshot({ tokenAuthorized: false });
    const validate = vi.fn(async () => ({ tokenId: "revoked-row", ...ids, mode: "one_time_order", status: "pending_payment" }));
    const result = await readAuthorizedPaymentRecovery({ request, claims: null, authorization: "Bearer rcv_revoked",
      deps: { port: reader(value), tokenPort: { validate } }, now });
    expect(result).toEqual({ snapshot: value, guidance: null });
  });

  it.each([undefined, "Basic rcv_token", "Bearer token with spaces", ["Bearer token"], `Bearer ${"x".repeat(2049)}`])(
    "rejects malformed bearer headers without validating or reading history", async (authorization) => {
      const port = reader(); const validate = vi.fn(async () => null);
      expect(await readAuthorizedPaymentRecovery({ request, claims: null, authorization, deps: { port, tokenPort: { validate } }, now })).toBeNull();
      expect(validate).not.toHaveBeenCalled(); expect(port.getGuidanceSnapshot).not.toHaveBeenCalled();
    });

  it.each([null, { tokenId: "x", ...ids, clientId: "other", mode: "one_time_order", status: "pending_payment" },
    { tokenId: "x", ...ids, orderId: "other", mode: "one_time_order", status: "pending_payment" }])(
    "does not authorize invalid, expired or differently scoped tokens", async (token) => {
      const port = reader();
      expect(await readAuthorizedPaymentRecovery({ request, claims: null, authorization: "Bearer rcv_token",
        deps: { port, tokenPort: { validate: async () => token } }, now })).toBeNull();
      expect(port.getGuidanceSnapshot).not.toHaveBeenCalled();
    });

  it("falls back to the legacy reader on missing snapshot or unavailable infrastructure", async () => {
    expect(await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, deps: { port: reader(null) }, now })).toBeNull();
    const port = { getGuidanceSnapshot: vi.fn(async () => { throw new Error("unavailable"); }) };
    expect(await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, deps: { port }, now })).toBeNull();
    expect(port.getGuidanceSnapshot).toHaveBeenCalledTimes(1);
    expect(await readAuthorizedPaymentRecovery({ request, claims: null, authorization: "Bearer rcv_token",
      deps: { port, tokenPort: { validate: async () => { throw new Error("unavailable"); } } }, now })).toBeNull();
    expect(port.getGuidanceSnapshot).toHaveBeenCalledTimes(1);
  });
});

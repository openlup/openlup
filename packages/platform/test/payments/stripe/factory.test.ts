import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripePaymentAdapter, stripePaymentCapabilities, type StripePaymentAdapterConfig } from "../../../src/payments/stripe/index.js";
import { mapStripeIntent, mapSetupIntent } from "../../../src/payments/stripe/intentMapper.js";
import { projectVerifiedEvidence } from "../../../src/payments/verifiedEvidenceProjection.js";
import { readMethodLifecycleEvent } from "../../../src/payments/index.js";

const timestamp = 1_800_000_000;
const methodCases = [
  ["payment_method.attached", "registered", "method_registered"],
  ["payment_method.automatically_updated", "updated", "method_updated"],
  ["payment_method.detached", "revoked", "method_revoked"],
] as const;
const request = { attemptRef: "attempt-a", intentRef: "intent-a", fingerprint: "host-fingerprint",
  providerIdempotencyKey: "host-key", money: { amountMinor: 2599, currency: "EUR" }, mode: "test" as const, purpose: "initial" as const };
function subject(intent = { id: "pi_fixture", status: "requires_action", amount: 2599, currency: "eur", client_secret: "transient_fixture" }) {
  const client = { createPaymentIntent: vi.fn(async () => intent), retrievePaymentIntent: vi.fn(async () => intent) };
  const config: StripePaymentAdapterConfig = { client, mode: "test", supportedCurrencies: ["EUR"], webhookSigningSecrets: ["fixture"], clock: () => timestamp };
  return { client, config, adapter: createStripePaymentAdapter(config) };
}
function event(type: string, object: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { id: "evt_fixture", type, created: timestamp, data: { object: { id: "pi_fixture", amount: 2599, currency: "eur", ...object } }, ...extra };
}
function signed(raw: unknown, at = timestamp, key = "fixture") {
  const rawBody = Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
  const digest = createHmac("sha256", key).update(`${at}.`).update(rawBody).digest("hex");
  return { rawBody, headers: { "Stripe-Signature": `t=${at},v1=${digest}` }, receivedAt: "2026-10-21T10:00:00Z" };
}

describe("opt-in payment factory", () => {
  it("forwards host identity/key bytes, keeps the secret only in handoff, and makes no construction calls", async () => {
    const { adapter, client } = subject();
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
    const result = await adapter.attemptPort.execute(request);
    expect(client.createPaymentIntent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ amount: 2599, currency: "eur",
      metadata: { source: "openlup.payment-control", paymentIntentId: "intent-a", orderRef: "intent-a", providerRequestFingerprint: "host-fingerprint", providerFlow: "one_time_payment" } }), { idempotencyKey: "host-key" });
    expect(result).toEqual({ outcome: { kind: "attempt", status: "requires_action" }, dispatch: { kind: "dispatched", providerPaymentRef: "pi_fixture" },
      handoff: { kind: "client-confirmed", payload: "transient_fixture" }, diagnostics: { webhookExpected: true, recoveryRequired: false } });
    expect(JSON.stringify(result.diagnostics)).not.toContain("transient_fixture");
  });
  it("validates host-declared currencies and refuses unsupported input before provider dispatch", async () => {
    const { adapter, client, config } = subject();
    const supportedCurrencies = ["EUR", "USD"];
    const configured = createStripePaymentAdapter({ ...config, supportedCurrencies });
    expect(configured.capabilities.supportedCurrencies).toEqual(supportedCurrencies);
    expect(configured.capabilities.supportedCurrencies).not.toBe(supportedCurrencies);
    expect(Object.isFrozen(configured.capabilities.supportedCurrencies)).toBe(true);
    expect(stripePaymentCapabilities.supportedCurrencies).toEqual([]);
    for (const currency of supportedCurrencies) {
      expect(() => configured.attemptPort.validateInput({ ...request, money: { ...request.money, currency } })).not.toThrow();
    }
    supportedCurrencies.push("GBP");
    expect(configured.capabilities.supportedCurrencies).toEqual(["EUR", "USD"]);
    expect(() => configured.attemptPort.validateInput({ ...request, money: { ...request.money, currency: "GBP" } })).toThrow("Unsupported payment input");
    expect(Reflect.set(stripePaymentCapabilities, "supportedCurrencies", ["GBP"])).toBe(false);
    for (const value of [stripePaymentCapabilities, stripePaymentCapabilities.captureFlows,
      stripePaymentCapabilities.captureFlows[0], stripePaymentCapabilities.captureFlows[0].methodFamilies,
      stripePaymentCapabilities.supportedCurrencies]) expect(Object.isFrozen(value)).toBe(true);
    for (const currencies of [undefined, null, "EUR", [], [null], [123], Array<string>(1), ["eur"], ["EU"], ["EURO"], ["EUR\n"], ["123"], ["EUR", "usd"]]) {
      expect(() => createStripePaymentAdapter({ ...config, supportedCurrencies: currencies } as StripePaymentAdapterConfig)).toThrow("Invalid supported currencies");
    }
    for (const patch of [{ money: { amountMinor: 1.5, currency: "EUR" } }, { money: { amountMinor: 2599, currency: "USD" } },
      { mode: "live" }, { purpose: "renewal-unattended" }, { customerAuthorization: "transient" }, { providerIdempotencyKey: "" }]) {
      await expect(adapter.attemptPort.execute({ ...request, ...patch } as typeof request)).rejects.toThrow("Unsupported payment input");
    }
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
  });
  it("maps issuer decline to neutral refusal without claiming not-dispatched, and preserves ambiguous errors", async () => {
    const { adapter, client } = subject();
    const input = { ...request, purpose: "renewal-unattended" as const, storedMethod: { reference: "pm_fixture", mandate: {} } };
    client.createPaymentIntent.mockRejectedValueOnce({ type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds", message: "private prose" });
    expect(await adapter.attemptPort.execute(input)).toEqual({ outcome: { kind: "decline", refusal: { code: "soft_retryable", hints: ["transient"] } },
      dispatch: { kind: "unknown" }, diagnostics: { webhookExpected: false, recoveryRequired: false } });
    expect(client.createPaymentIntent.mock.calls[0][0]).toMatchObject({ offSession: true, paymentMethod: "pm_fixture" });
    const network = new Error("ambiguous transport"); client.createPaymentIntent.mockRejectedValueOnce(network);
    await expect(adapter.attemptPort.execute(input)).rejects.toBe(network);
  });
  it("verifies untouched bytes with secret rotation, rejects bad signatures and stale timestamps", async () => {
    const { config } = subject();
    const adapter = createStripePaymentAdapter({ ...config, webhookSigningSecrets: ["old", "fixture"] });
    const input = signed(event("payment_intent.succeeded"));
    expect(await adapter.verifyPort.verifyAndNormalize(input)).toMatchObject({ kind: "money", outcome: "succeeded", providerEventId: "evt_fixture" });
    for (const at of [timestamp - 301, timestamp + 301]) expect(await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.succeeded"), at))).toEqual({ kind: "refusal", reason: "stale" });
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.succeeded"), timestamp, "wrong"))).toEqual({ kind: "refusal", reason: "signature" });
    expect(await adapter.verifyPort.verifyAndNormalize({ ...input, rawBody: Buffer.concat([input.rawBody, Buffer.from(" ")]) })).toEqual({ kind: "refusal", reason: "signature" });
    expect(await createStripePaymentAdapter({ ...config, webhookSigningSecrets: [] }).verifyPort.verifyAndNormalize(input)).toEqual({ kind: "refusal", reason: "signature" });
  });
  it("applies the configured tolerance and refuses malformed payloads and unsupported events", async () => {
    const { config, adapter } = subject();
    const wider = createStripePaymentAdapter({ ...config, toleranceSeconds: 600 });
    expect(await wider.verifyPort.verifyAndNormalize(signed(event("payment_intent.succeeded"), timestamp - 600))).toMatchObject({ kind: "money" });
    expect(await adapter.verifyPort.verifyAndNormalize(signed("{"))).toEqual({ kind: "refusal", reason: "malformed" });
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("customer.created")))).toEqual({ kind: "refusal", reason: "unsupported-event" });
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.succeeded", {}, { livemode: true })))).toEqual({ kind: "refusal", reason: "unsupported-event" });
    expect(() => createStripePaymentAdapter({ ...config, toleranceSeconds: NaN })).toThrow();
  });
  it("preserves dispute outcome, payment linkage and original money", async () => {
    const { adapter } = subject();
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("charge.dispute.created", { id: "dp_fixture", payment_intent: "pi_fixture" })))).toMatchObject({
      kind: "money", outcome: "disputed", providerEventId: "evt_fixture", providerPaymentRef: "pi_fixture",
      money: { amountMinor: 2599, currency: "EUR" }, providerAuditPayload: { eventType: "charge.dispute.created" },
    });
  });
  it("retains only donor-filtered audit facts and excludes them from event identity", async () => {
    const { adapter } = subject();
    const object = { latest_charge: "ch_fixture", payment_method: { id: "pm_fixture", type: "card" },
      metadata: { providerFlow: "off_session_payment", customerAuthorization: "planted_authorization" },
      last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", advice_code: "try_again_later",
        charge: "ch_fixture", message: "planted_provider_prose" },
      client_secret: "planted_secret", handoff: { payload: "planted_handoff" }, rawBody: "planted_raw_body" };
    const failed = await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.payment_failed", object)));
    expect(failed).toMatchObject({ kind: "money", outcome: "failed" });
    if (failed.kind === "refusal") throw new Error("expected verified evidence");
    expect(failed.providerAuditPayload).toEqual({ provider: "stripe", eventId: "evt_fixture", eventType: "payment_intent.payment_failed",
      providerPaymentId: "pi_fixture", amountMinor: 2599, currency: "EUR", failureEvidence: {
        version: 1, source: "webhook", disposition: "present", refusalVerified: true, providerPaymentId: "pi_fixture",
        providerChargeId: "ch_fixture", code: "card_declined", declineCode: "insufficient_funds", adviceCode: "try_again_later",
        adviceOrigin: "provider", operation: "stored_method_payment", methodSource: "provider",
        method: { kind: "card", recoveryMethodKey: "card", interaction: "stored_instrument" },
      } });
    const revised = await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.payment_failed", {
      ...object, latest_charge: "ch_other", last_payment_error: { ...object.last_payment_error, charge: "ch_other" },
    })));
    expect(revised).toMatchObject({ providerEventId: failed.providerEventId, fingerprint: failed.fingerprint,
      providerAuditPayload: { failureEvidence: { providerChargeId: "ch_other" } } });
    const refunded = await adapter.verifyPort.verifyAndNormalize(signed(event("charge.refunded", {
      ...object, id: "ch_fixture", payment_intent: "pi_fixture", amount_refunded: 500,
    })));
    expect(refunded).toMatchObject({ providerAuditPayload: { eventType: "charge.refunded",
      stripeRefundSnapshot: { chargeId: "ch_fixture", amountRefundedMinor: 500 } } });
    if (refunded.kind === "refusal") throw new Error("expected refund evidence");
    expect(refunded.providerAuditPayload).not.toHaveProperty("failureEvidence");
    expect(refunded.providerAuditPayload).not.toHaveProperty("failureReason");
    expect(refunded.providerAuditPayload).not.toHaveProperty("decline_code");
    for (const evidence of [failed, revised, refunded]) {
      for (const value of ["planted_authorization", "planted_provider_prose", "planted_secret", "planted_handoff", "planted_raw_body"]) {
        expect(JSON.stringify(evidence)).not.toContain(value);
        if (evidence.kind !== "refusal") expect(JSON.stringify(evidence.providerAuditPayload)).not.toContain(value);
      }
    }
  });
  it("observes explicit cumulative refunds and refuses missing evidence", async () => {
    const { adapter } = subject();
    const verify = (amount?: number) => adapter.verifyPort.verifyAndNormalize(signed(event("charge.refunded", { id: "ch_fixture", payment_intent: "pi_fixture", amount_refunded: amount })));
    for (const amount of [500, 1200, 2599]) expect(await verify(amount)).toMatchObject({ kind: "money", outcome: "refunded", providerPaymentRef: "pi_fixture",
      refund: { kind: "cumulative-snapshot", operationId: "ch_fixture", originalPaymentMoney: { amountMinor: 2599, currency: "EUR" }, refundedMoney: { amountMinor: amount, currency: "EUR" } } });
    expect(await verify()).toEqual({ kind: "refusal", reason: "malformed" });
    expect(await verify(3000)).toEqual({ kind: "refusal", reason: "malformed" });
  });
  it("maps method and setup lifecycle separately from money", async () => {
    const { adapter } = subject();
    for (const [type, outcome, kind] of methodCases) {
      for (const created of [timestamp, "2027-01-15T08:00:00.000Z"]) {
        const occurredAt = typeof created === "number" ? new Date(created * 1000).toISOString() : created;
        const result = await adapter.verifyPort.verifyAndNormalize(signed(event(type, {
          id: "pm_fixture", card: { brand: "visa", last4: "4242", exp_month: 6, exp_year: 2027 },
        }, { created })));
        expect(result).toMatchObject({ kind: "method", outcome, methodRef: "pm_fixture", providerOccurredAt: occurredAt });
        if (result.kind !== "method") throw new Error("expected method evidence");
        expect(result.methodLifecycle).toEqual({ kind, providerKind: "stripe", providerMethodRef: "pm_fixture",
          providerEventId: "evt_fixture", occurredAt,
          replacement: { schemeLabel: "visa", lastDigits: "4242", expiresAt: "2027-06-30T23:59:59.999Z" } });
      }
    }
    for (const [type, outcome] of [["setup_intent.succeeded", "registered"], ["setup_intent.setup_failed", "failed"], ["setup_intent.requires_action", "requires-action"]]) {
      expect(await adapter.verifyPort.verifyAndNormalize(signed(event(type, { id: type.startsWith("setup") ? "seti_fixture" : "pm_fixture", payment_method: "pm_fixture" })))).toMatchObject({ kind: "method", outcome, methodRef: "pm_fixture" });
    }
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("setup_intent.setup_failed")))).toEqual({ kind: "refusal", reason: "unsupported-event" });
  });
  it("omits lifecycle without provider time while retaining the method outcome", async () => {
    const { adapter } = subject();
    for (const [type, outcome] of methodCases) {
      for (const created of [undefined, null, "invalid-time"]) {
        const input = signed(event(type, { id: "pm_fixture" }, { created }));
        const result = await adapter.verifyPort.verifyAndNormalize(input);
        expect(result).toMatchObject({ kind: "method", outcome, methodRef: "pm_fixture", providerOccurredAt: null });
        expect(result).not.toHaveProperty("methodLifecycle");
        if (result.kind !== "method") throw new Error("expected method evidence");
        expect(readMethodLifecycleEvent(projectVerifiedEvidence(result, input, "require-evidence"))).toBeNull();
        expect(await adapter.verifyPort.verifyAndNormalize({ ...input, receivedAt: "2026-10-22T00:00:00Z" })).toEqual(result);
      }
    }
  });
  it("preserves method lifecycle through the M07 projection and lifecycle reader", async () => {
    const { adapter } = subject();
    for (const [type, , kind] of methodCases) {
      const input = signed(event(type, { id: "pm_fixture", card: { brand: "visa", last4: "4242", exp_month: 6, exp_year: 2027 } }));
      const result = await adapter.verifyPort.verifyAndNormalize(input);
      if (result.kind !== "method") throw new Error("expected method evidence");
      const projected = projectVerifiedEvidence(result, input, "require-evidence");
      expect(projected.occurredAt).toBe(input.receivedAt);
      expect(readMethodLifecycleEvent(projected)).toEqual({ kind, providerKind: "stripe", providerMethodRef: "pm_fixture",
        providerEventId: "evt_fixture", occurredAt: new Date(timestamp * 1000).toISOString(),
        replacement: { schemeLabel: "visa", lastDigits: "4242", expiresAt: "2027-06-30T23:59:59.999Z" } });
    }
  });
  it("makes replay fingerprints independent of receipt time and never invents provider occurrence time", async () => {
    const { adapter } = subject(); const input = signed(event("payment_intent.succeeded", {}, { created: undefined }));
    const first = await adapter.verifyPort.verifyAndNormalize(input);
    expect(first).toMatchObject({ providerOccurredAt: null });
    expect(await adapter.verifyPort.verifyAndNormalize({ ...input, receivedAt: "2026-10-22T00:00:00Z" })).toEqual(first);
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.payment_failed", {}, { created: undefined })))).not.toEqual(first);
  });
  it("preserves active checkout versus recovery read semantics and exact input references", async () => {
    const { adapter } = subject({ id: "pi_fixture", status: "requires_payment_method", amount: 2599, currency: "eur", client_secret: "transient_fixture" });
    const input = { identity: { provider: "stripe", providerPaymentRef: "pi_fixture", intentRef: "intent-a", attemptRef: "attempt-a" }, expectedMoney: request.money, purpose: "active_checkout" as const };
    const result = await adapter.readbackPort.readPayment(input);
    expect(result).toMatchObject({ kind: "pending", purpose: "active_checkout", observedMoney: request.money });
    expect(result.identity).toBe(input.identity); expect(result.expectedMoney).toBe(input.expectedMoney);
    expect(await adapter.readbackPort.readPayment({ ...input, purpose: "recovery" })).toMatchObject({ kind: "failed", purpose: "recovery" });
  });
  it("refuses mismatched readback, keeps uncertainty, and omits incomplete exact absence", async () => {
    const { adapter, client } = subject();
    const input = { identity: { provider: "stripe", providerPaymentRef: "pi_other", intentRef: "intent-a", attemptRef: "attempt-a" }, expectedMoney: request.money, purpose: "recovery" as const };
    expect(await adapter.readbackPort.readPayment(input)).toMatchObject({ kind: "unknown" });
    expect(await adapter.readbackPort.readPayment({ ...input, identity: { ...input.identity, providerPaymentRef: null } })).toMatchObject({ kind: "unsupported" });
    client.retrievePaymentIntent.mockRejectedValueOnce(new Error("timeout"));
    expect(await adapter.readbackPort.readPayment(input)).toMatchObject({ kind: "unknown" });
    expect(adapter.absencePort).toBeUndefined(); expect(adapter.capabilities.exactAbsence).toBe("unsupported");
    expect(adapter.readbackPort.close).toBeUndefined();
    expect(stripePaymentCapabilities).toMatchObject({ refundCreate: "unsupported", authorizationCaptureSplit: "unsupported", unattended: "supported" });
  });
  it("offers close only with injected cancellation and checks identity/money before it", async () => {
    const { config } = subject(); let canceled = false;
    const cancelPaymentIntent = vi.fn(async () => { canceled = true; return { id: "pi_fixture", status: "canceled", amount: 2599, currency: "eur" }; });
    const adapter = createStripePaymentAdapter({ ...config, client: { ...config.client, cancelPaymentIntent,
      retrievePaymentIntent: async () => ({ id: "pi_fixture", status: canceled ? "canceled" : "processing", amount: 2599, currency: "eur" }) } });
    const input = { identity: { provider: "stripe", providerPaymentRef: "pi_fixture", intentRef: "intent-a", attemptRef: "attempt-a" }, expectedMoney: request.money, purpose: "recovery" as const };
    expect(await adapter.readbackPort.close!({ ...input, expectedMoney: { amountMinor: 1, currency: "EUR" } })).toMatchObject({ kind: "unknown" });
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(await adapter.readbackPort.close!(input)).toMatchObject({ kind: "failed", purpose: "recovery" });
    expect(cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith("pi_fixture");
    expect(adapter.capabilities.close).toBe("supported");
  });
  it("preserves pure structural mapper results without constructing an SDK", () => {
    expect(mapStripeIntent({ id: "pi_fixture", status: "succeeded", amount: 2599, currency: "eur", customer: { id: "cus_fixture" },
      payment_method: { id: "pm_fixture" }, latest_charge: { id: "ch_fixture" } })).toMatchObject({ customer: "cus_fixture", payment_method: "pm_fixture", latest_charge: "ch_fixture", amount: 2599 });
    expect(mapSetupIntent({ id: "seti_fixture", status: "requires_action", payment_method: "pm_fixture" })).toMatchObject({ id: "seti_fixture", payment_method: "pm_fixture", latest_charge: null });
  });
});

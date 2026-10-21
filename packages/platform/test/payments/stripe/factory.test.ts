import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripePaymentAdapter, stripePaymentCapabilities, type StripePaymentAdapterConfig } from "../../../src/payments/stripe/index.js";
import { mapStripeIntent, mapSetupIntent } from "../../../src/payments/stripe/intentMapper.js";

const timestamp = 1_800_000_000;
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
    const supportedCurrencies = ["EUR", "USD"] as const;
    const configured = createStripePaymentAdapter({ ...config, supportedCurrencies });
    expect(configured.capabilities.supportedCurrencies).toBe(supportedCurrencies);
    expect(stripePaymentCapabilities.supportedCurrencies).toEqual([]);
    for (const currency of supportedCurrencies) {
      expect(() => configured.attemptPort.validateInput({ ...request, money: { ...request.money, currency } })).not.toThrow();
    }
    expect(() => configured.attemptPort.validateInput({ ...request, money: { ...request.money, currency: "GBP" } })).toThrow("Unsupported payment input");
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
  it("refuses disputed outcomes through the single current-union mapping", async () => {
    const { adapter } = subject();
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("charge.dispute.created", { id: "dp_fixture", payment_intent: "pi_fixture" })))).toEqual({ kind: "refusal", reason: "unsupported-event" });
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
    for (const [type, outcome] of [["payment_method.attached", "registered"], ["payment_method.automatically_updated", "updated"], ["payment_method.detached", "revoked"],
      ["setup_intent.succeeded", "registered"], ["setup_intent.setup_failed", "failed"], ["setup_intent.requires_action", "requires-action"]]) {
      expect(await adapter.verifyPort.verifyAndNormalize(signed(event(type, { id: type.startsWith("setup") ? "seti_fixture" : "pm_fixture", payment_method: "pm_fixture" })))).toMatchObject({ kind: "method", outcome, methodRef: "pm_fixture" });
    }
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("setup_intent.setup_failed")))).toEqual({ kind: "refusal", reason: "unsupported-event" });
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

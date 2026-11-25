import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripePaymentAdapter, stripePaymentCapabilities, type StripePaymentAdapterConfig } from "../../../src/payments/stripe/index.js";
import { mapStripeIntent, mapSetupIntent } from "../../../src/payments/stripe/intentMapper.js";
import { projectVerifiedEvidence } from "../../../src/payments/verifiedEvidenceProjection.js";
import { createVerifiedPaymentIngress, readMethodLifecycleEvent } from "../../../src/payments/index.js";

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
  return { id: "evt_fixture", type, created: timestamp, data: { object: { id: "pi_fixture", amount: 2599, amount_received: 2599, currency: "eur", ...object } }, ...extra };
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
    expect(result).toMatchObject({ outcome: { kind: "attempt", status: "requires_action" }, dispatch: { kind: "dispatched", providerPaymentRef: "pi_fixture" },
      handoff: { kind: "client-confirmed", payload: "transient_fixture" }, diagnostics: { webhookExpected: true, recoveryRequired: false } });
    expect(JSON.stringify(result.diagnostics)).not.toContain("transient_fixture");
    expect(result.persistence).toMatchObject({ providerSessionId: "pi_fixture", nextActionKind: "sca_required",
      requestPayload: { providerIdempotencyKey: "host-key", providerRequestFingerprint: "host-fingerprint", orderRef: "intent-a" },
      responsePayload: { providerStatus: "requires_action" } });
    expect(JSON.stringify(result.persistence)).not.toContain("transient_fixture");
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
      { mode: "live" }, { orderMode: "unsupported" }, { purpose: "unsupported" }, { purpose: "renewal-unattended" }, { customerAuthorization: "transient" }, { providerIdempotencyKey: "" }]) {
      const input = { ...request, ...patch } as typeof request;
      expect(() => adapter.attemptPort.validateInput(input)).toThrow("Unsupported payment input");
      await expect(adapter.attemptPort.execute(input)).rejects.toThrow("Unsupported payment input");
    }
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
    expect(client.retrievePaymentIntent).not.toHaveBeenCalled();
  });
  it("maps issuer decline to neutral refusal without claiming not-dispatched, and preserves ambiguous errors", async () => {
    const { adapter, client } = subject();
    const input = { ...request, purpose: "renewal-unattended" as const, storedMethod: { reference: "pm_fixture", mandate: {} } };
    client.createPaymentIntent.mockRejectedValueOnce({ type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds", message: "private prose" });
    expect(await adapter.attemptPort.execute(input)).toMatchObject({ outcome: { kind: "decline", refusal: { code: "soft_retryable", hints: ["transient"] } },
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
  it("projects capture time from a verified whole-second success event outside event identity", async () => {
    const { adapter, config } = subject();
    const success = (extra: Record<string, unknown>) => signed(event("payment_intent.succeeded", {}, extra));
    const verify = (extra: Record<string, unknown>) => adapter.verifyPort.verifyAndNormalize(success(extra));
    const instant = new Date(timestamp * 1000).toISOString();
    const verified = await verify({ livemode: false, account: "acct_capture_fixture" });
    expect(verified).toMatchObject({
      kind: "money", providerOccurredAt: instant, capturedAmountBasis: "provider_capture_v1",
      providerAuditPayload: { livemode: false, captureTimeBasis: "signed_event_v1", providerAccountRef: "acct_capture_fixture" },
    });
    expect(await verify({ livemode: "false" })).toMatchObject({
      fingerprint: "fingerprint" in verified ? verified.fingerprint : undefined,
      providerAuditPayload: { captureTimeBasis: "signed_event_v1" },
    });
    for (const account of [undefined, false, " "]) {
      expect(await verify({ livemode: false, account })).not.toMatchObject({ providerAuditPayload: { providerAccountRef: expect.anything() } });
    }
    for (const created of [timestamp + 0.0001, timestamp + 0.125, instant]) {
      expect(await verify({ livemode: false, created })).toMatchObject({
        kind: "money", capturedAmountBasis: "provider_capture_v1", providerAuditPayload: { captureTimeBasis: "invalid_event_time" },
      });
    }
    expect(await verify({ livemode: false, created: undefined })).toMatchObject({ kind: "money", providerOccurredAt: null });
    expect(await createStripePaymentAdapter({ ...config, mode: "live" }).verifyPort.verifyAndNormalize(success({ livemode: true })))
      .toMatchObject({ providerAuditPayload: { livemode: true, captureTimeBasis: "signed_event_v1" } });
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
    expect(first).toMatchObject({ providerOccurredAt: null, capturedAmountBasis: "provider_capture_v1" });
    if (first.kind !== "money") throw new Error("Expected verified capture");
    const { fingerprint, providerAuditPayload, capturedAmountBasis, ...priorIdentity } = first;
    expect(providerAuditPayload).toBeDefined();
    expect(capturedAmountBasis).toBe("provider_capture_v1");
    expect(fingerprint).toBe(createHash("sha256").update(JSON.stringify(priorIdentity)).digest("hex"));
    expect(projectVerifiedEvidence(first, input, "require-evidence")).toMatchObject({ capturedAmountBasis });
    const failed = await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.payment_failed")));
    expect(failed).not.toHaveProperty("capturedAmountBasis");
    expect(await adapter.verifyPort.verifyAndNormalize({ ...input, receivedAt: "2026-10-22T00:00:00Z" })).toEqual(first);
    expect(await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.payment_failed", {}, { created: undefined })))).not.toEqual(first);
  });
  it("accepts rolling multi-v1 Stripe-Signature headers during secret rotation and enforces staleness", async () => {
    const { adapter } = subject();
    const base = signed(event("payment_intent.succeeded"));
    const sigHeader = base.headers["Stripe-Signature"]!;
    const rotated = {
      ...base,
      headers: { "Stripe-Signature": `${sigHeader},v1=${"0".repeat(64)}` },
    };
    expect(await adapter.verifyPort.verifyAndNormalize(rotated)).toMatchObject({
      kind: "money",
      outcome: "succeeded",
      providerPaymentRef: "pi_fixture",
    });

    const staleBase = signed(event("payment_intent.succeeded"), timestamp - 400);
    const staleRotated = {
      ...staleBase,
      headers: { "Stripe-Signature": `${staleBase.headers["Stripe-Signature"]!},v1=${"0".repeat(64)}` },
    };
    expect(await adapter.verifyPort.verifyAndNormalize(staleRotated)).toEqual({ kind: "refusal", reason: "stale" });
  });
  it.each([request.money.amountMinor, 0])("records and refuses a signed success with conflicting collected amount %s on each delivery", async paidAmountMinor => {
    const { adapter } = subject();
    const configuredAmountMinor = 2699;
    const delivery = signed(event("payment_intent.succeeded", { amount: configuredAmountMinor, amount_received: paidAmountMinor }));
    const ingestPaymentEvent = vi.fn();
    const applyPaymentResult = vi.fn();
    const findCompletedHistoricalCapture = vi.fn(async () => null);
    const operationalEvents = vi.fn();
    const ingress = createVerifiedPaymentIngress({ provider: "stripe", verifyPort: adapter.verifyPort, operationalEvents,
      paymentControlPort: { findCompletedHistoricalCapture, ingestPaymentEvent, applyPaymentResult } });
    const details = { reason: "provider_amount_mismatch", configuredAmountMinor, paidAmountMinor, currency: "EUR" };
    const recorded = { name: "provider_payment_amount_mismatch", domain: "payment", surface: "webhook", details: {
      ...details, provider: "stripe", providerEventId: "evt_fixture", providerPaymentId: "pi_fixture", outcome: "review_required",
    } };
    for (const deliveryNumber of [1, 2]) {
      expect(await ingress.receive(delivery)).toEqual({ status: 409, data: {
        error: "Provider payment amounts disagree. Review the payment before settling.", ...details,
      } });
      expect(operationalEvents).toHaveBeenCalledTimes(deliveryNumber);
      expect(operationalEvents).toHaveBeenLastCalledWith(recorded);
    }
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
    const evidence = await adapter.verifyPort.verifyAndNormalize(delivery);
    expect(evidence).toMatchObject({ kind: "money", outcome: "succeeded", money: null, providerAuditPayload: {
      configuredAmountMinor, paidAmountMinor, currency: "EUR",
    } });
    expect(evidence).not.toHaveProperty("capturedAmountBasis");
  });

  it.each([
    { label: "two valid amounts differ (a)", object: { amount: 300, amount_received: 200 },
      amounts: { configuredAmountMinor: 300, paidAmountMinor: 200 } },
    { label: "requested is malformed (b)", object: { amount: "synthetic-private-value", amount_received: 200 },
      amounts: { paidAmountMinor: 200, malformedAmounts: [{ field: "amount", malformed: true }] } },
    { label: "received is malformed (b)", object: { amount: 300, amount_received: { data: "synthetic-private-value" } },
      amounts: { configuredAmountMinor: 300, malformedAmounts: [{ field: "amount_received", malformed: true }] } },
  ])("refuses when $label even if the recorder throws", async ({ object, amounts }) => {
    const { adapter } = subject();
    const delivery = signed(event("payment_intent.succeeded", object));
    const ingestPaymentEvent = vi.fn();
    const applyPaymentResult = vi.fn();
    const operationalEvents = vi.fn(() => { throw new Error("recorder unavailable"); });
    // The managed binding does not supply a completed-receipt lookup.
    const ingress = createVerifiedPaymentIngress({ provider: "stripe", verifyPort: adapter.verifyPort, operationalEvents,
      paymentControlPort: { ingestPaymentEvent, applyPaymentResult } });
    const details = { reason: "provider_amount_mismatch", currency: "EUR", ...amounts };
    for (const deliveryNumber of [1, 2]) {
      expect(await ingress.receive(delivery)).toEqual({ status: 409, data: {
        error: "Provider payment amounts disagree. Review the payment before settling.", ...details,
      } });
      expect(operationalEvents).toHaveBeenCalledTimes(deliveryNumber);
      expect(operationalEvents).toHaveBeenLastCalledWith({ name: "provider_payment_amount_mismatch", domain: "payment", surface: "webhook",
        details: { provider: "stripe", providerEventId: "evt_fixture", providerPaymentId: "pi_fixture", ...details, outcome: "review_required" } });
    }
    const evidence = await adapter.verifyPort.verifyAndNormalize(delivery);
    expect(evidence).toMatchObject({ kind: "money", money: null, providerAuditPayload: amounts });
    expect(evidence).not.toHaveProperty("capturedAmountBasis");
    expect(JSON.stringify(evidence)).not.toContain("synthetic-private-value");
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
  });

  it("returns the conflict evidence when the recorder returns a rejected promise", async () => {
    const { adapter } = subject();
    const delivery = signed(event("payment_intent.succeeded", { amount: 300, amount_received: 200 }));
    const ingestPaymentEvent = vi.fn();
    const applyPaymentResult = vi.fn();
    let recorded = 0;
    // Use a plain callback so the test spy cannot handle the returned rejection.
    const operationalEvents = () => {
      recorded += 1;
      return Promise.reject(new Error("async recorder unavailable"));
    };
    const ingress = createVerifiedPaymentIngress({ provider: "stripe", verifyPort: adapter.verifyPort, operationalEvents,
      paymentControlPort: { ingestPaymentEvent, applyPaymentResult } });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await ingress.receive(delivery)).toMatchObject({ status: 409, data: {
        reason: "provider_amount_mismatch", configuredAmountMinor: 300, paidAmountMinor: 200, currency: "EUR",
      } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(recorded).toBe(1);
      expect(ingestPaymentEvent).not.toHaveBeenCalled();
      expect(applyPaymentResult).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("refuses redelivery of a released requested-amount receipt without a completed-receipt lookup", async () => {
    const { adapter } = subject();
    const completedReceipt = { paymentEventId: "historical-event", paymentIntentId: "historical-intent",
      replayed: true, amountMinor: 300 };
    const prior = await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.succeeded", {
      amount: completedReceipt.amountMinor, amount_received: completedReceipt.amountMinor,
    })));
    if (prior.kind !== "money") throw new Error("Expected verified legacy identity");
    const delivery = signed(event("payment_intent.succeeded", { amount: 300, amount_received: 200 }));
    expect(await adapter.verifyPort.verifyAndNormalize(delivery)).toMatchObject({ historicalCaptureFingerprint: prior.fingerprint });
    const ingestPaymentEvent = vi.fn(async () => completedReceipt);
    const applyPaymentResult = vi.fn();
    const ingress = createVerifiedPaymentIngress({ provider: "stripe", verifyPort: adapter.verifyPort,
      paymentControlPort: { ingestPaymentEvent, applyPaymentResult } });
    expect(await ingress.receive(delivery)).toMatchObject({ status: 409, data: {
      reason: "provider_amount_mismatch", configuredAmountMinor: 300, paidAmountMinor: 200,
    } });
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
  });

  it.each([
    { object: { amount_received: 500 }, legacyAmount: request.money.amountMinor },
    { object: { amount_received: undefined }, legacyAmount: request.money.amountMinor },
    { object: { amount: "300", amount_received: 200 }, legacyAmount: 200 },
  ])("acknowledges a completed legacy receipt for $object", async ({ object, legacyAmount }) => {
    const { adapter } = subject();
    const prior = await adapter.verifyPort.verifyAndNormalize(signed(event("payment_intent.succeeded", {
      amount: legacyAmount, amount_received: legacyAmount,
    })));
    if (prior.kind !== "money") throw new Error("Expected verified legacy identity");
    const delivery = signed(event("payment_intent.succeeded", object));
    const current = await adapter.verifyPort.verifyAndNormalize(delivery);
    expect(current).toMatchObject({ historicalCaptureFingerprint: prior.fingerprint });
    const findCompletedHistoricalCapture = vi.fn(async () => "prior-local-event");
    const ingestPaymentEvent = vi.fn();
    const applyPaymentResult = vi.fn();
    const afterProcessed = vi.fn();
    const operationalEvents = vi.fn();
    const ingress = createVerifiedPaymentIngress({ provider: "stripe", verifyPort: adapter.verifyPort,
      paymentControlPort: { findCompletedHistoricalCapture, ingestPaymentEvent, applyPaymentResult }, afterProcessed, operationalEvents });
    expect(await ingress.receive(delivery)).toMatchObject({ status: 200, data: { replayed: true, paymentEventId: "prior-local-event" } });
    expect(findCompletedHistoricalCapture).toHaveBeenCalledWith({ provider: "stripe", providerEventId: "evt_fixture",
      providerPaymentId: "pi_fixture", legacyFingerprint: prior.fingerprint });
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
    expect(applyPaymentResult).not.toHaveBeenCalled();
    expect(afterProcessed).not.toHaveBeenCalled();
    expect(operationalEvents).toHaveBeenCalledWith(expect.objectContaining({ name: "provider_payment_historical_capture_replay" }));
  });
  it("acknowledges an exact completed receipt when the replay recorder rejects", async () => {
    const { adapter } = subject();
    const delivery = signed(event("payment_intent.succeeded", { amount: "300", amount_received: 200 }));
    const ingestPaymentEvent = vi.fn();
    const applyPaymentResult = vi.fn();
    const findCompletedHistoricalCapture = vi.fn(async () => "prior-local-event");
    const recorded = vi.fn();
    const ingress = createVerifiedPaymentIngress({ provider: "stripe", verifyPort: adapter.verifyPort,
      paymentControlPort: { findCompletedHistoricalCapture, ingestPaymentEvent, applyPaymentResult },
      operationalEvents: event => {
        recorded(event);
        return Promise.reject(new Error("async replay recorder unavailable"));
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await ingress.receive(delivery)).toMatchObject({ status: 200, data: { replayed: true, paymentEventId: "prior-local-event" } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ name: "provider_payment_historical_capture_replay" }));
      expect(ingestPaymentEvent).not.toHaveBeenCalled();
      expect(applyPaymentResult).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("preserves active checkout versus recovery read semantics and exact input references", async () => {
    const { adapter } = subject({ id: "pi_fixture", status: "requires_payment_method", amount: 2599, currency: "eur", client_secret: "transient_fixture" });
    const input = { identity: { provider: "stripe", providerPaymentRef: "pi_fixture", intentRef: "intent-a", attemptRef: "attempt-a" }, expectedMoney: request.money, purpose: "active_checkout" as const };
    const result = await adapter.readbackPort.readPayment(input);
    expect(result).toMatchObject({ kind: "pending", purpose: "active_checkout", observedMoney: request.money });
    expect(result.identity).toBe(input.identity); expect(result.expectedMoney).toBe(input.expectedMoney);
    expect(await adapter.readbackPort.readPayment({ ...input, purpose: "recovery" })).toMatchObject({ kind: "failed", purpose: "recovery" });
  });
  it("keeps a provider success with zero collected money out of capture readback", async () => {
    const intent = { id: "pi_fixture", status: "succeeded", amount: request.money.amountMinor, amount_received: 0,
      currency: request.money.currency.toLowerCase(), client_secret: "transient_fixture" };
    const { adapter } = subject(intent);
    const identity = { provider: "stripe", providerPaymentRef: intent.id, intentRef: "intent-a", attemptRef: "attempt-a" };
    await expect(adapter.readbackPort.readPayment({ identity, expectedMoney: request.money, purpose: "recovery" }))
      .resolves.toEqual({ kind: "unknown", reason: "indeterminate", identity, expectedMoney: request.money, purpose: "recovery" });
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

it("collects an off-session setup with exact host keys and a transient handoff, or refuses the absent client capability", async () => {
  const { config, adapter } = subject();
  const input = { customer: "cus_setup", metadata: { source: "account.card-update", subscriptionId: "subscription" }, idempotencyKey: "setup-key" };
  expect(await adapter.methodPort!.setupMethod(input)).toEqual({ kind: "unsupported" });
  const createSetupIntent = vi.fn(async () => ({ id: "seti_setup", client_secret: "transient-setup", status: "requires_confirmation" }));
  const configured = createStripePaymentAdapter({ ...config, client: { ...config.client, createSetupIntent } });
  expect(createSetupIntent).not.toHaveBeenCalled();
  expect(await configured.methodPort!.setupMethod(input)).toEqual({ kind: "ready", setupRef: "seti_setup", handoff: { kind: "client-confirmed", payload: "transient-setup" }, replayed: false });
  expect(createSetupIntent).toHaveBeenCalledExactlyOnceWith({ customer: "cus_setup", metadata: input.metadata, usage: "off_session" }, { idempotencyKey: "setup-key" });
});

it.each(["setup_intent.succeeded", "payment_intent.succeeded"])("preserves reusable method facts from %s through verified projection", async type => {
  const { adapter } = subject();
  const evidence = await adapter.verifyPort.verifyAndNormalize(signed(event(type, { id: type.startsWith("setup") ? "seti_setup" : "pi_fixture",
    payment_method: { id: "pm_registered", type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } },
    setup_future_usage: "off_session", customer: "cus_registered", metadata: { clientId: "untrusted-client", subscriptionId: "untrusted-subscription", recoveryCaseId: "case" } })));
  expect(evidence).toMatchObject({ reusableMethod: { providerMethodRef: "pm_registered", providerCustomerRef: "cus_registered", methodKind: "card", status: "active" } });
  if (evidence.kind !== "money" && evidence.kind !== "method") throw new Error("method evidence missing");
  const owner = { clientId: "recorded-client", subscriptionId: "recorded-subscription" };
  expect(projectVerifiedEvidence(evidence, { receivedAt: "2026-10-21T10:00:00Z" }, "require-evidence", owner)).toMatchObject({ reusableMethod: {
    ...owner, providerMethodRef: "pm_registered", consentSnapshot: expect.objectContaining({ source: expect.any(String) }),
  } });
  expect(projectVerifiedEvidence(evidence, { receivedAt: "2026-10-21T10:00:00Z" })).not.toHaveProperty("reusableMethod");
});

import { describe, expect, it, vi } from "vitest";
import { createVerifiedPaymentIngress, paymentPayloadFingerprint } from "@openlup/platform/payments";
import type { PaymentVerifyNormalizePort, VerifiedPaymentEvidence, VerifiedMethodEvidence } from "@openlup/platform/payments/contracts";

const AT = "2026-10-21T10:00:00.000Z";
const input = { rawBody: new TextEncoder().encode('{ "receipt" : "original" }'), headers: { proof: "original" }, receivedAt: AT };
const evidence: VerifiedPaymentEvidence = { kind: "money", provider: "provider-a", providerEventId: "event-original",
  providerPaymentRef: "remote-original", intentRef: "intent-original", attemptRef: "attempt-original",
  providerOccurredAt: null, fingerprint: paymentPayloadFingerprint({ outcome: "succeeded" }),
  outcome: "succeeded", money: { amountMinor: 9000, currency: "XXX" } };
function fixture(event: Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>> = evidence) {
  const trace: string[] = [];
  const verify = vi.fn(async (_input: typeof input) => { trace.push("verify"); return event; });
  const ingest = vi.fn(async (_event: Parameters<Parameters<typeof createVerifiedPaymentIngress>[0]["paymentControlPort"]["ingestPaymentEvent"]>[0]) => { trace.push("ingest"); return { paymentEventId: "event-local",
    paymentIntentId: "intent-original", paymentAttemptId: "attempt-original" as string | null, replayed: false, occurredAt: AT }; });
  const apply = vi.fn(async (_value: unknown) => { trace.push("apply"); return { replayed: false }; });
  const hook = vi.fn(async (_value: unknown) => { trace.push("hook"); });
  const close = vi.fn(async (_value: unknown) => { trace.push("close"); return { updated: true }; });
  const ingress = createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: verify },
    paymentControlPort: { ingestPaymentEvent: ingest, applyPaymentResult: apply, markSetupEventProcessed: close }, afterProcessed: hook });
  return { trace, verify, ingest, apply, hook, close, receive: ingress.receive };
}

describe("verified ingress public witnesses", () => {
  it("persists nothing on refusal, then verifies and durably ingests before acknowledgement", async () => {
    const f = fixture(); f.verify.mockRejectedValueOnce(new Error("signature_refused"));
    expect((await f.receive(input)).status).toBe(400); expect(f.ingest).not.toHaveBeenCalled();
    f.trace.length = 0;
    expect((await f.receive(input)).status).toBe(200);
    expect(f.trace).toEqual(["verify", "ingest", "apply", "hook"]);
    expect(f.ingest.mock.calls[0][0]).toMatchObject({ paymentIntentId: "intent-original", paymentAttemptId: "attempt-original" });
    expect(f.verify.mock.calls[1][0].rawBody).toBe(input.rawBody);
    expect(f.verify.mock.calls[1][0].headers).toBe(input.headers);
    for (const reason of ["signature", "stale", "malformed", "unsupported-event"] as const) {
      const refusal = fixture({ kind: "refusal", reason });
      expect((await refusal.receive(input)).status).toBe(reason === "unsupported-event" ? 200 : 400);
      expect(refusal.ingest).not.toHaveBeenCalled();
    }
  });
  it("withholds acknowledgement and hooks while ingest is unresolved and reports its failure", async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entering = new Promise<void>(resolve => { entered = resolve; });
    f.ingest.mockImplementationOnce(async () => { entered(); await held; throw new Error("store_unavailable"); });
    let acknowledged = false;
    const pending = f.receive(input).then(result => { acknowledged = true; return result; });
    await entering; expect(acknowledged).toBe(false); expect(f.hook).not.toHaveBeenCalled();
    release(); expect((await pending).status).toBe(503);
    expect(f.ingest).toHaveBeenCalledTimes(1); expect(f.hook).not.toHaveBeenCalled();
  });
  it("closes setup after hooks, keeps method identity with no setup reference and never applies money", async () => {
    const method: VerifiedMethodEvidence = { kind: "method", provider: "provider-a", providerEventId: "method-event",
      providerOccurredAt: null, fingerprint: "method-fingerprint", outcome: "registered", methodRef: "method-original",
      setupRef: null, intentRef: "intent-original", methodLifecycle: { kind: "method_registered", providerKind: "provider-a",
        providerMethodRef: "method-original", providerEventId: "method-event", occurredAt: AT } };
    for (const outcome of ["registered", "updated", "revoked", "expired", "suspended", "failed", "requires-action"] as const) {
      const f = fixture({ ...method, outcome });
      expect((await f.receive(input)).status).toBe(200);
      expect(f.trace).toEqual(["verify", "ingest", "hook", "close"]);
      expect(f.close).toHaveBeenCalledExactlyOnceWith({ paymentEventId: "event-local" });
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.ingest.mock.calls[0][0]).toMatchObject({ providerPaymentId: "method-original", paymentIntentId: "intent-original", methodLifecycle: method.methodLifecycle });
      expect(f.hook.mock.calls[0][0]).toMatchObject({ resultStatus: null,
        ingested: { paymentIntentId: "intent-original", paymentAttemptId: "attempt-original" } });
    }
  });
  it("acknowledges an unresolved attempt after durable ingest without continuing hooks", async () => {
    const f = fixture();
    f.ingest.mockResolvedValueOnce({ paymentEventId: "event-local", paymentIntentId: "intent-original", paymentAttemptId: null, replayed: false, occurredAt: AT });
    f.apply.mockRejectedValueOnce(new Error("payment_control_result_attempt_unresolved"));
    const result = await f.receive(input);
    expect(result.status).toBe(200); expect(result.data).toMatchObject({ skipped: "result_attempt_mismatch" });
    expect(f.hook).not.toHaveBeenCalled(); expect(f.trace).toEqual(["verify"]);
    expect(f.ingest).toHaveBeenCalledTimes(1); expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("keeps failure and success event identity and gives chargeback its distinct identity", async () => {
    const transcripts: unknown[] = [];
    for (const [outcome, id, expected] of [["failed", "remote-original", "failed"], ["succeeded", "remote-original", "succeeded"],
      ["refunded", "remote-original:chargeback", "disputed"], ["disputed", "remote-original:dispute", "disputed"],
      ["pending", "remote-original:pending", null]] as const) {
      const f = fixture({ ...evidence, outcome, providerEventId: id, ...(outcome === "refunded" ? { refund: {
        kind: "full-reversal", reason: "chargeback", operationId: "reversal-original", originalPaymentMoney: evidence.money!,
      } as const } : {}) });
      expect((await f.receive(input)).status).toBe(200);
      expect(f.hook.mock.calls[0][0]).toMatchObject({ resultStatus: expected });
      const ingested = f.ingest.mock.calls[0][0];
      transcripts.push([ingested.providerEventId, ingested.eventType]);
    }
    expect(transcripts).toEqual([["remote-original", "payment.failed"], ["remote-original", "payment.succeeded"],
      ["remote-original:chargeback", "payment.disputed"], ["remote-original:dispute", "payment.disputed"], ["remote-original:pending", "payment.requires_action"]]);
  });
  it("reuses first receipt clocks and fingerprints with no second effect on redelivery", async () => {
    const f = fixture({ ...evidence, providerOccurredAt: "2026-10-20T10:00:00.000Z" }); let first: unknown; let effects = 0; const applied = new Set<string>();
    f.ingest.mockImplementation(async event => { const replayed = first !== undefined; first ??= event;
      return { paymentEventId: "event-local", paymentIntentId: "intent-original", paymentAttemptId: "attempt-original", replayed, occurredAt: AT }; });
    f.apply.mockImplementation(async value => { const key = paymentPayloadFingerprint(value); const replayed = applied.has(key);
      if (!replayed) { applied.add(key); effects++; } return { replayed }; });
    await f.receive(input);
    const firstIdentity = f.ingest.mock.calls[0][0].providerEventId;
    const firstPayloadHash = paymentPayloadFingerprint(f.ingest.mock.calls[0][0].rawPayload);
    await f.receive(input);
    expect(paymentPayloadFingerprint(f.ingest.mock.calls[1][0].rawPayload)).toBe(firstPayloadHash);
    f.ingest.mockClear(); f.apply.mockClear(); f.hook.mockClear();
    f.verify.mockResolvedValue({ ...evidence, providerOccurredAt: "2026-10-20T10:00:00.000Z", providerAuditPayload: { audit: "changed" } });
    await f.receive(input);
    expect(f.ingest.mock.calls[0][0].providerEventId).toBe(firstIdentity);
    await f.receive({ ...input, receivedAt: "2026-10-21T10:01:00.000Z" });
    expect(f.apply.mock.calls.map(([value]) => value)).toEqual([expect.objectContaining({ occurredAt: AT }), expect.objectContaining({ occurredAt: AT })]);
    expect(await Promise.all(f.verify.mock.results.map(async result => { const value = await result.value; return value.kind === "money" ? value.fingerprint : null; }))).toEqual([evidence.fingerprint, evidence.fingerprint, evidence.fingerprint, evidence.fingerprint]);
    expect(f.ingest.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ providerEventId: "event-original", rawPayload: expect.objectContaining({ openlupEvidence: expect.objectContaining({ providerEventId: "event-original" }) }), occurredAt: AT }),
      expect.objectContaining({ providerEventId: "event-original", rawPayload: expect.objectContaining({ openlupEvidence: expect.objectContaining({ providerEventId: "event-original" }) }), occurredAt: "2026-10-21T10:01:00.000Z" }),
    ]);
    expect(f.hook.mock.calls.map(([value]) => value)).toEqual([expect.objectContaining({ event: expect.objectContaining({ occurredAt: AT }) }),
      expect.objectContaining({ event: expect.objectContaining({ occurredAt: AT }) })]);
    expect(effects).toBe(1);
  });
});

it("projects reusable registration with host ownership and copies lifecycle fields only", async () => {
  const method: VerifiedMethodEvidence = { kind: "method", provider: "provider-a", providerEventId: "method-event",
    providerOccurredAt: AT, fingerprint: "method-fingerprint", outcome: "registered", methodRef: "method-original",
    setupRef: "setup-original", intentRef: null, reusableMethod: { providerCustomerRef: "customer-original",
      providerMethodRef: "method-original", providerMandateRef: "mandate-original", methodKind: "stored-method", status: "active" },
    methodLifecycle: { kind: "method_registered", providerKind: "provider-a", providerMethodRef: "method-original",
      providerEventId: "method-event", occurredAt: AT } };
  const extended = { ...method, reusableMethod: { ...method.reusableMethod!, clientId: "adapter-owner", subscriptionId: "adapter-subscription" },
    methodLifecycle: { ...method.methodLifecycle!, unexpected: "transient-untyped", replacement: {
      schemeLabel: "Card", lastDigits: "1234", expiresAt: null, unexpected: "nested-untyped" } } };
  const ingested: unknown[] = [], methods: unknown[] = [];
  const ingress = (owner: boolean) => createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: async () => extended },
    resolveMethodOwner: owner ? async () => ({ clientId: "host-owner", subscriptionId: "host-subscription" }) : undefined,
    paymentControlPort: { ingestPaymentEvent: async event => { ingested.push(event); return {
      paymentEventId: "method-local", paymentIntentId: null, paymentAttemptId: null, replayed: false }; } },
    methodRefPort: { upsertFromWebhook: async event => { methods.push(event); return { replayed: false }; } } });
  expect((await ingress(true).receive(input)).status).toBe(200);
  expect(methods[0]).toMatchObject({ reusableMethod: { ...method.reusableMethod, clientId: "host-owner", subscriptionId: "host-subscription" } });
  expect(JSON.stringify(ingested)).not.toContain("adapter-owner");
  expect(JSON.stringify(ingested)).not.toContain("adapter-subscription");
  expect(JSON.stringify(ingested)).not.toContain("transient-untyped");
  expect(JSON.stringify(ingested)).not.toContain("nested-untyped");
  expect((await ingress(false).receive(input)).status).toBe(200);
  expect(methods[1]).not.toHaveProperty("reusableMethod");
  const failingOwner = createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: async () => extended },
    resolveMethodOwner: async () => { throw new Error("host_owner_unavailable"); },
    paymentControlPort: { ingestPaymentEvent: async event => { ingested.push(event); return {
      paymentEventId: "method-local", paymentIntentId: null, paymentAttemptId: null, replayed: false }; } } });
  expect((await failingOwner.receive(input)).status).toBe(503);
  expect(ingested).toHaveLength(2);
});


it("refuses invalid settling money through the existing amount mismatch response", async () => {
  const mismatch = fixture();
  mismatch.apply.mockRejectedValueOnce(new Error("payment_control_result_amount_mismatch"));
  const mismatchResponse = await mismatch.receive(input);
  expect(mismatchResponse).toEqual({ status: 503, data: { error: "Provider webhook processing failed" } });
  const invalidMoney = [{ amountMinor: 0, currency: "XXX" },
      { amountMinor: -1, currency: "XXX" }, { amountMinor: NaN, currency: "XXX" },
      { amountMinor: 1.5, currency: "XXX" }, { amountMinor: Infinity, currency: "XXX" },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "XXX" },
      { amountMinor: 9000, currency: "" }, { amountMinor: 9000, currency: " \t\n" }, null];
  for (const money of invalidMoney) {
    for (const outcome of ["succeeded", "refunded", "disputed"] as const) {
      const f = fixture({ ...evidence, outcome, money });
      expect(await f.receive(input)).toEqual(mismatchResponse);
      expect(f.ingest).not.toHaveBeenCalled();
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.hook).not.toHaveBeenCalled();
    }
    for (const outcome of ["failed", "pending"] as const) {
      const f = fixture({ ...evidence, outcome, money });
      expect((await f.receive(input)).status).toBe(200);
      expect(f.ingest).toHaveBeenCalledTimes(1);
      expect(f.apply).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
    }
  }
});

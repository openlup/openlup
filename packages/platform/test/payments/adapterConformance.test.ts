import { describe, expect, it, vi } from "vitest";
import { runPaymentAdapterConformance, runExecutionConformance, runDurableEventConformance,
  executePreparedAttemptMechanism, createVerifiedPaymentIngress, paymentPayloadFingerprint } from "@openlup/platform/payments";
import type { PaymentAdapterConformanceSubject, PaymentAdapterCapabilities, PaymentExecutionEnvelope,
  PaymentVerifyNormalizePort, VerifiedPaymentEvidence, PreparedAttemptFailurePolicy } from "@openlup/platform/payments/contracts";

type Verification = Parameters<typeof runPaymentAdapterConformance>[0][number]["verification"];
function subject(provider: string): PaymentAdapterConformanceSubject & { verification: Verification } {
  const money = { amountMinor: 9000, currency: "XXX" };
  const identity = { provider, providerPaymentRef: "remote-original", intentRef: `intent-${provider}`, attemptRef: `attempt-${provider}` };
  const capabilities: PaymentAdapterCapabilities = { providerKind: provider, captureFlows: [], supportedCurrencies: ["XXX"],
    requiresStoredMandateEvidence: false, assessMandate: () => ({ chargeable: false }), unattendedChargeFlow: "unattended",
    payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
    methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
    terminalOutcomeReporting: { kind: "inbound_event", silenceBecomesSuspectAfterMinutes: 60 }, mandateUpsertIsSubscriptionScoped: false,
    unattended: "unsupported", readback: "supported", close: "unsupported", exactAbsence: "supported",
    refundObservation: "supported", refundCreate: "unsupported", authorizationCaptureSplit: "unsupported" };
  const input = { rawBody: new TextEncoder().encode('{ "outcome" : "succeeded" }'), headers: { proof: "test-proof" }, receivedAt: "2026-10-21T10:00:00.000Z" };
  const evidence: VerifiedPaymentEvidence = { ...identity, kind: "money", providerEventId: "event-original", providerOccurredAt: null,
    outcome: "succeeded", money, fingerprint: paymentPayloadFingerprint({ outcome: "succeeded" }) };
  const failed: VerifiedPaymentEvidence = { ...evidence, providerEventId: "event-original:failed", outcome: "failed", fingerprint: paymentPayloadFingerprint({ outcome: "failed" }) };
  const verification: Verification = [
    { input, expected: evidence }, { input: { ...input, receivedAt: "2026-10-21T10:01:00.000Z" }, expected: evidence },
    { input: { ...input, rawBody: new TextEncoder().encode('{ "outcome" : "failed" }') }, expected: failed },
    { input: { ...input, rawBody: new TextEncoder().encode('{ "outcome" : "refusal" }') }, expected: { kind: "refusal", reason: "signature" } },
  ];
  const verifyAndNormalize: PaymentVerifyNormalizePort["verifyAndNormalize"] = vi.fn(async value => {
    const fixture = verification.find(row => row.input.rawBody === value.rawBody && row.input.receivedAt === value.receivedAt);
    if (!fixture || fixture.input.headers !== value.headers) throw new Error("raw_bytes_changed");
    return fixture.expected;
  });
  return { subjectId: provider, executionInput: { ...identity, fingerprint: "attempt-fingerprint", providerIdempotencyKey: "provider-key", money,
    mode: "test", purpose: "initial" }, readbackInput: { identity, expectedMoney: money, purpose: "active_checkout" },
    absenceInput: { identity, expectedMoney: money }, verification,
    adapter: { capabilities, attemptPort: { validateInput: () => {}, execute: async () => ({ outcome: { kind: "attempt", status: "processing" }, dispatch: { kind: "unknown" }, diagnostics: {} }) },
      verifyPort: { verifyAndNormalize }, readbackPort: { readPayment: async () => ({ kind: "unknown", reason: "timeout", identity, expectedMoney: money, purpose: "active_checkout" }) },
      absencePort: { proveAbsence: async () => ({ kind: "unknown", reason: "truncated", identity, expectedMoney: money }) } } };
}

describe("adapter conformance suites", () => {
  it("proves multiple subjects, exact bytes, replay versus changing outcome and unknown distinct from absence", async () => {
    const subjects = [subject("provider-a"), subject("provider-b")];
    subjects[0].adapter.absencePort = { proveAbsence: async () => ({ ...subjects[0].absenceInput!, kind: "absent",
      evidence: { exact: true, complete: true, lookupReference: "bounded-lookup-original" } }) };
    const report = await runPaymentAdapterConformance(subjects);
    expect(report.subjects.map(row => row.subjectId)).toEqual(["provider-a", "provider-b"]);
    for (const row of report.subjects) expect(row.readback.kind).toBe("unknown");
    expect(report.subjects.map(row => row.absence?.kind)).toEqual(["absent", "unknown"]);
    const collision = subject("provider-a");
    const changed = collision.verification[2].expected;
    if (changed.kind !== "money") throw new Error("fixture money required");
    changed.providerEventId = "event-original";
    await expect(runPaymentAdapterConformance([collision])).rejects.toThrow("replay identity fingerprint");
    expect(report.cases.every(row => row.passed)).toBe(true);
    const bad = subject("provider-a"); bad.adapter.capabilities.close = "supported";
    await expect(runPaymentAdapterConformance([bad])).rejects.toThrow("close method present");
    bad.adapter.capabilities.close = "unsupported"; delete bad.adapter.absencePort;
    await expect(runPaymentAdapterConformance([bad])).rejects.toThrow("absence port present");
    const drift = subject("provider-b");
    drift.adapter.readbackPort.readPayment = async () => ({ kind: "unknown", reason: "timeout", ...drift.readbackInput,
      expectedMoney: { amountMinor: 8999, currency: "XXX" } });
    await expect(runPaymentAdapterConformance([drift])).rejects.toThrow("readback exact identity and money");
  });
  it("refuses before prepare and excludes handoffs and transient secrets from conformance evidence", async () => {
    const prepare = vi.fn(), execute = vi.fn();
    const error = new Error("input_refused");
    const policy: PreparedAttemptFailurePolicy<Error, string> = { replayError: () => error,
      isTrustedNoCharge: (value): value is Error => value === error, logRetry: () => {}, exhaustedError: () => error,
      executionError: () => error, finalizationError: () => error };
    await expect(executePreparedAttemptMechanism({ paymentPort: { prepareProviderAttempt: prepare, finalizeProviderAttempt: vi.fn() },
      executionPort: { validateInput: () => { throw error; }, execute }, provider: "provider-a", paymentIntentId: "intent-original",
      executionInput: { idempotencyKey: "execution-key", providerIdempotencyKey: "provider-key", providerRequestFingerprint: "fingerprint",
        paymentIntentId: "intent-original", amountMinor: 9000, currency: "XXX", mode: "one_time" },
      prepareIdempotencyKey: "prepare-key", finalizeIdempotencyKey: "finalize-key", providerIdempotencyKey: "provider-key",
      providerRequestFingerprint: "fingerprint", providerFlow: "interactive", prepareRequestPayload: {},
    }, policy)).rejects.toBe(error);
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    const f = subject("provider-a");
    f.adapter.readbackPort.readPayment = async () => ({ ...f.readbackInput, kind: "pending", observedMoney: f.readbackInput.expectedMoney,
      providerOccurredAt: null, handoff: { kind: "redirect", url: "https://example.test/transient" } });
    const result: PaymentExecutionEnvelope = { outcome: { kind: "attempt", status: "requires_action" }, dispatch: { kind: "unknown" },
      handoff: { kind: "redirect", url: "https://example.test/transient" }, diagnostics: {} };
    f.adapter.attemptPort.execute = async () => result;
    const report = await runPaymentAdapterConformance([f]);
    expect(JSON.stringify(report)).not.toContain("handoff"); expect(JSON.stringify(report)).not.toContain("transient");
    const secret = "ephemeral-test-value";
    const authorization: NonNullable<typeof f.executionInput.customerAuthorization> = secret as NonNullable<typeof f.executionInput.customerAuthorization>;
    f.executionInput.customerAuthorization = authorization;
    const confirmation = "confirmation-test-value" as typeof authorization;
    result.handoff = { kind: "client-confirmed", payload: confirmation };
    const verified = f.verification[0].expected;
    if (verified.kind !== "money") throw new Error("fixture money required");
    for (const leaked of [authorization, confirmation]) {
      result.diagnostics = { unexpected: leaked };
      await expect(runPaymentAdapterConformance([f])).rejects.toThrow("execution diagnostics and taxonomy");
      result.diagnostics = {};
      verified.providerAuditPayload = { nested: { authorization: leaked } };
      await expect(runPaymentAdapterConformance([f])).rejects.toThrow("audit payload secret redaction");
      delete verified.providerAuditPayload;
    }
    const body = new TextEncoder().encode(`confirmation=${confirmation}&authorization=${secret}`);
    const safeInput = { ...f.verification[0].input, rawBody: body };
    const safeVerify = vi.fn(async () => verified);
    const stored = vi.fn(async () => ({ paymentEventId: "event-safe", paymentIntentId: null, paymentAttemptId: null, replayed: false }));
    const safe = await createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: safeVerify },
      paymentControlPort: { ingestPaymentEvent: stored } }).receive(safeInput);
    expect(safe.status).toBe(200); expect(stored).toHaveBeenCalledTimes(1);
    expect(safeVerify.mock.calls[0]).toEqual([safeInput]);
    expect(JSON.stringify(stored.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(stored.mock.calls)).not.toContain(confirmation);
    expect(JSON.stringify(safe)).not.toContain(secret);
    const ingress = createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: f.adapter.verifyPort,
      paymentControlPort: { ingestPaymentEvent: prepare } });
    const refused = await ingress.receive(f.verification[3].input);
    expect(refused.status).toBe(400); expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects payer leaks across execution, diagnostics and the whole stored evidence", async () => {
    const f = subject("provider-a");
    f.executionInput.methodSelection = { family: "bank-redirect", channelRef: "opaque-channel" };
    f.executionInput.payer = { email: "payer@example.invalid", name: "Transient Person" };
    await expect(runPaymentAdapterConformance([f])).resolves.toBeDefined();
    const verified = f.verification[0].expected;
    if (verified.kind !== "money") throw new Error("fixture money required");
    for (const value of Object.values(f.executionInput.payer)) {
      f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "attempt", status: "processing" },
        dispatch: { kind: "unknown" }, diagnostics: { unexpected: value } });
      await expect(runPaymentAdapterConformance([f])).rejects.toThrow("execution diagnostics and taxonomy");
      f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "attempt", status: "processing" },
        dispatch: { kind: "unknown" }, diagnostics: {}, handoff: { kind: "redirect", url: value } });
      await expect(runPaymentAdapterConformance([f])).rejects.toThrow("execution payer redaction");
      f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "attempt", status: "processing" }, dispatch: { kind: "unknown" }, diagnostics: {} });
      verified.providerAuditPayload = { nested: { unexpected: value } };
      await expect(runPaymentAdapterConformance([f])).rejects.toThrow("audit payload secret redaction");
      delete verified.providerAuditPayload;
      verified.providerPaymentRef = value;
      await expect(runPaymentAdapterConformance([f])).rejects.toThrow("audit payload secret redaction");
      verified.providerPaymentRef = "remote-original";
    }
    const stored = vi.fn(async () => ({ paymentEventId: "event-safe", paymentIntentId: null, paymentAttemptId: null, replayed: false }));
    const extended = { ...verified, payer: f.executionInput.payer, extra: "unknown-extra", money: { ...verified.money!, extra: "unknown-nested" } };
    await createVerifiedPaymentIngress({ provider: "provider-a", verifyPort: { verifyAndNormalize: async () => extended },
      paymentControlPort: { ingestPaymentEvent: stored } }).receive(f.verification[0].input);
    expect(stored).toHaveBeenCalledOnce();
    expect(JSON.stringify(stored.mock.calls)).not.toContain("payer@example.invalid");
    expect(JSON.stringify(stored.mock.calls)).not.toContain("unknown-extra");
    expect(JSON.stringify(stored.mock.calls)).not.toContain("unknown-nested");
  });
  it("requires exact before-dispatch refusal for missing adapter-required payer input", async () => {
    const f = subject("provider-a");
    f.adapter.capabilities.payerContext.requiresPayerBlock = true;
    await expect(runPaymentAdapterConformance([f])).rejects.toThrow("missing required input exact notDispatched");
    const reason = { code: "payment_failed" as const, hints: [] };
    f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "decline", refusal: reason },
      dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason } }, diagnostics: {} });
    await expect(runPaymentAdapterConformance([f])).resolves.toBeDefined();
  });
  it("composes framework-free execution validation with the unchanged durable event runner", async () => {
    const request = { idempotencyKey: "execution-key", providerIdempotencyKey: "provider-key", providerRequestFingerprint: "fingerprint",
      paymentIntentId: "intent-original", amountMinor: 9000, currency: "XXX", mode: "one_time" as const };
    let captured = 0;
    const execution = (outcome: string) => ({ provider: "provider-a", providerAttemptId: null, providerSessionId: null,
      attemptStatus: "processing" as const, nextActionKind: null, requestPayload: { providerIdempotencyKey: request.providerIdempotencyKey,
        providerRequestFingerprint: request.providerRequestFingerprint }, responsePayload: { outcome, providerCall: false },
      providerDecline: outcome === "refused" ? { code: "payment_failed", mandateUnsupported: false } : null });
    expect(await runExecutionConformance({ expectedProvider: "provider-a", request,
      captured: { execute: async () => { captured++; return execution("captured"); } }, capturedLedger: { cardinality: () => captured },
      refused: { execute: async () => execution("refused") } })).toMatchObject({ executions: 2, capturedEffects: 1, permanentRefusals: 1 });
    type Subject = Parameters<typeof runDurableEventConformance>[0];
    type Snapshot = Awaited<ReturnType<Subject["snapshot"]>>;
    let events: Snapshot["events"] = [];
    const aggregate = (key: string) => ({ orderId: key, paymentId: key, paymentIntentId: key, paymentAttemptId: key,
      orderStatus: "pending_payment", paymentStatus: "pending", intentStatus: "pending", attemptStatus: "pending" });
    let aggregates = { outOfOrder: aggregate("outOfOrder"), lateSuccess: aggregate("lateSuccess") };
    const applied = new Set<string>();
    const durable: Subject = { name: "memory-contract-fixture", durabilityClaim: true, assertSafe: () => {},
      reset: async () => { events = []; applied.clear(); aggregates = { outOfOrder: aggregate("outOfOrder"), lateSuccess: aggregate("lateSuccess") }; return { residualRows: 0 }; },
      seed: async () => {}, snapshot: async () => structuredClone({ counts: { clients: 1, orders: 2, payments: 2, intents: 2, attempts: 2,
        events: events.length, transitions: applied.size, idempotencyKeys: applied.size, outboxEvents: applied.size }, aggregates, events }),
      ingest: async value => {
        const previous = events.find(event => event.eventKey === value.eventKey);
        if (previous) return { paymentEventId: previous.id, replayed: true };
        events.push({ id: value.eventKey, eventKey: value.eventKey, paymentIntentId: value.aggregate, paymentAttemptId: value.aggregate, processingStatus: "received" });
        return { paymentEventId: value.eventKey, replayed: false };
      }, apply: async value => {
        if (applied.has(value.eventKey)) return { replayed: true };
        const current = aggregates[value.aggregate];
        const event = events.find(row => row.id === value.paymentEventId)!;
        if (value.resultStatus === "failed" && current.paymentStatus === "succeeded") event.processingStatus = "ignored";
        else { event.processingStatus = "processed"; Object.assign(current, value.resultStatus === "succeeded"
          ? { orderStatus: "paid", paymentStatus: "succeeded", intentStatus: "succeeded", attemptStatus: "succeeded" }
          : { orderStatus: "pending_payment", paymentStatus: "failed", intentStatus: "failed", attemptStatus: "failed" }); }
        applied.add(value.eventKey); return { replayed: false };
      } };
    const writes = (n: number) => ({ events: n, transitions: n, idempotencyKeys: n, outboxEvents: n });
    const proof = await runDurableEventConformance(durable, { fixture: { clients: 1, orders: 2, payments: 2, intents: 2, attempts: 2 },
      baseline: writes(0), afterOutOfOrderSuccess: writes(1), afterOutOfOrderFailure: writes(2), afterDuplicate: writes(2),
      afterLateFailure: writes(3), final: writes(4) });
    expect(proof.cleanupResidualRows).toBe(0); expect(proof.final.aggregates.lateSuccess.paymentStatus).toBe("succeeded");
  });
});

it("accepts an empty optional payer name and refuses JSON-escaped payer leaks", async () => {
  const f = subject("provider-a");
  f.executionInput.payer = { email: "payer@example.invalid", name: "" };
  await expect(runPaymentAdapterConformance([f])).resolves.toBeDefined();
  f.executionInput.payer = { email: 'payer"quoted@example.invalid', name: "Line\nName" };
  await expect(runPaymentAdapterConformance([f])).resolves.toBeDefined();
  for (const value of Object.values(f.executionInput.payer)) {
    f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "attempt", status: "processing" },
      dispatch: { kind: "unknown" }, diagnostics: {}, handoff: { kind: "redirect", url: value } });
    await expect(runPaymentAdapterConformance([f])).rejects.toThrow("execution payer redaction");
    f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "attempt", status: "processing" }, dispatch: { kind: "unknown" }, diagnostics: {} });
    const evidence = f.verification[0].expected;
    if (evidence.kind !== "money") throw new Error("fixture money required");
    evidence.providerAuditPayload = { nested: { payer: value } };
    await expect(runPaymentAdapterConformance([f])).rejects.toThrow("audit payload secret redaction");
    delete evidence.providerAuditPayload;
    f.adapter.readbackPort.readPayment = async () => ({ ...f.readbackInput, kind: "unknown", reason: "timeout", unexpected: value });
    await expect(runPaymentAdapterConformance([f])).rejects.toThrow("readback secret redaction");
    f.adapter.readbackPort.readPayment = async () => ({ ...f.readbackInput, kind: "unknown", reason: "timeout" });
  }
  const authorization = 'code"with\\escape' as typeof f.executionInput.customerAuthorization;
  f.executionInput.customerAuthorization = authorization;
  f.verification.length = 0;
  f.adapter.attemptPort.execute = async () => ({ outcome: { kind: "attempt", status: "processing" },
    dispatch: { kind: "unknown" }, diagnostics: { echoed: authorization } });
  await expect(runPaymentAdapterConformance([f])).rejects.toThrow();
});

it("refuses verification fixtures with invalid settling money", async () => {
  for (const money of [{ amountMinor: 0, currency: "XXX" },
      { amountMinor: -1, currency: "XXX" }, { amountMinor: NaN, currency: "XXX" },
      { amountMinor: 1.5, currency: "XXX" }, { amountMinor: Infinity, currency: "XXX" },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "XXX" },
      { amountMinor: 9000, currency: "" }, { amountMinor: 9000, currency: " \t\n" }, null]) {
    for (const outcome of ["succeeded", "refunded", "disputed"] as const) {
      const s = subject("provider-a");
      const original = s.verification[0].expected;
      if (original.kind !== "money") throw new Error("money fixture required");
      s.verification = [{ input: s.verification[0].input, expected: { ...original, outcome, money } }];
      s.adapter.verifyPort = { verifyAndNormalize: async () => s.verification[0].expected };
      await expect(runPaymentAdapterConformance([s])).rejects.toThrow(
        "payment_adapter_conformance:settling outcome requires positive money");
    }
  }
});

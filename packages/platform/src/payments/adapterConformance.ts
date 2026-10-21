import { projectVerifiedEvidence } from "./verifiedEvidenceProjection.js";
import { validatePaymentExecutionContractResult } from "@openlup/core/testing";
import type {
  PaymentAdapterConformanceEvidence, PaymentAdapterConformanceSubject,
  PaymentVerifyNormalizePort,
} from "./contracts/index.js";

/** Runner-independent adapter proof. Verification fixtures are owned by each adapter. */
export async function runPaymentAdapterConformance(
  subjects: readonly (PaymentAdapterConformanceSubject & {
    verification: readonly {
      input: Parameters<PaymentVerifyNormalizePort["verifyAndNormalize"]>[0];
      expected: Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>>;
    }[];
  })[],
): Promise<PaymentAdapterConformanceEvidence> {
  const observations: PaymentAdapterConformanceEvidence["subjects"][number][] = [];
  const cases: PaymentAdapterConformanceEvidence["cases"][number][] = [];
  for (const subject of subjects) {
    const { adapter, executionInput, readbackInput } = subject;
    const provider = adapter.capabilities.providerKind;
    requireFact(executionInput.money.currency.length > 0, "configured currency");
    adapter.attemptPort.validateInput(executionInput);
    const result = await adapter.attemptPort.execute(executionInput);
    const { handoff, ...execution } = result;
    const sensitiveValues = [executionInput.payer?.email, executionInput.payer?.name, executionInput.customerAuthorization,
      handoff?.kind === "client-confirmed" ? handoff.payload : handoff?.url].filter((v): v is NonNullable<typeof v> => v !== undefined && v.length > 0);
    const sensitiveForms = sensitiveValues.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
    const payerForms = [executionInput.payer?.email, executionInput.payer?.name]
      .filter((value): value is string => Boolean(value?.length))
      .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
    const input = {
      idempotencyKey: executionInput.attemptRef, providerIdempotencyKey: executionInput.providerIdempotencyKey,
      providerRequestFingerprint: executionInput.fingerprint, paymentIntentId: executionInput.intentRef,
      amountMinor: executionInput.money.amountMinor, currency: executionInput.money.currency, mode: "one_time" as const,
    };
    const validation = validatePaymentExecutionContractResult({ input, expectedProvider: provider, sensitiveValues,
      result: { provider, providerAttemptId: result.dispatch.kind === "dispatched" ? result.dispatch.providerPaymentRef : null,
        providerSessionId: null, attemptStatus: result.outcome.kind === "attempt" ? result.outcome.status : "processing",
        nextActionKind: null, requestPayload: { providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.providerRequestFingerprint }, responsePayload: result.diagnostics },
    });
    requireFact(validation.ok, "execution diagnostics and taxonomy");
    requireFact(!payerForms.some(value => JSON.stringify(result).includes(value)), "execution payer redaction");
    if (adapter.capabilities.payerContext.requiresPayerBlock && !executionInput.payer) {
      requireFact(result.dispatch.kind === "notDispatched" && result.dispatch.evidence.exact
        && result.dispatch.evidence.phase === "before-dispatch", "missing required input exact notDispatched");
    }
    const returned = await adapter.readbackPort.readPayment(readbackInput);
    const { handoff: readbackHandoff, ...readback } = "handoff" in returned ? returned : { ...returned, handoff: undefined };
    requireFact(!sensitiveForms.some(value => JSON.stringify(readback).includes(value)), "readback secret redaction");
    requireFact(sameIdentity(readback.identity, readbackInput.identity) && sameMoney(readback.expectedMoney, readbackInput.expectedMoney), "readback exact identity and money");
    requireFact(adapter.capabilities.readback === "supported" ? returned.kind !== "unsupported" : returned.kind === "unsupported", "readback capability");
    if ("observedMoney" in returned) requireFact(sameMoney(returned.observedMoney, readbackInput.expectedMoney), "observed money");
    if (adapter.capabilities.close === "supported") {
      requireFact(typeof adapter.readbackPort.close === "function", "close method present");
      const closed = await adapter.readbackPort.close!(readbackInput);
      requireFact(closed.kind !== "unsupported" && sameIdentity(closed.identity, readbackInput.identity)
        && sameMoney(closed.expectedMoney, readbackInput.expectedMoney), "close exact identity and money");
    } else if (adapter.readbackPort.close) {
      requireFact((await adapter.readbackPort.close(readbackInput)).kind === "unsupported", "close refuses");
    }
    let absence;
    if (adapter.capabilities.exactAbsence === "supported") requireFact(adapter.absencePort !== undefined, "absence port present");
    if (adapter.absencePort) {
      requireFact(subject.absenceInput !== undefined, "absence input present");
      absence = await adapter.absencePort.proveAbsence(subject.absenceInput!);
      requireFact(sameIdentity(absence.identity, subject.absenceInput!.identity)
        && sameMoney(absence.expectedMoney, subject.absenceInput!.expectedMoney), "absence exact identity and money");
      requireFact(adapter.capabilities.exactAbsence === "supported" ? absence.kind !== "unsupported" : absence.kind === "unsupported", "absence capability");
      if (absence.kind === "absent") requireFact(absence.evidence.exact && absence.evidence.complete
        && absence.evidence.lookupReference.trim().length > 0, "complete absence evidence");
    }
    const fingerprints = new Map<string, { fingerprint: string; outcome: string }>();
    const moneyEvents: { reference: string; outcome: string; eventId: string; fingerprint: string }[] = [];
    for (const fixture of subject.verification) {
      const verified = await adapter.verifyPort.verifyAndNormalize(fixture.input);
      requireFact(JSON.stringify(verified) === JSON.stringify(fixture.expected), "verified fixture");
      if (verified.kind !== "refusal") {
        requireFact(!sensitiveForms.some(value => JSON.stringify({ payload: projectVerifiedEvidence(verified, fixture.input, "require-evidence").rawPayload, diagnostics: result.diagnostics }).includes(value)),
          "audit payload secret redaction");
        const outcome = verified.kind + ":" + verified.outcome;
        const previous = fingerprints.get(verified.providerEventId);
        if (previous) requireFact(previous.outcome === outcome && previous.fingerprint === verified.fingerprint, "replay identity fingerprint");
        if (verified.kind === "money") {
          for (const event of moneyEvents) {
            if (event.reference === verified.providerPaymentRef && event.outcome !== outcome) {
              requireFact(event.eventId !== verified.providerEventId && event.fingerprint !== verified.fingerprint, "changing outcome identity");
            }
          }
          moneyEvents.push({ reference: verified.providerPaymentRef, outcome, eventId: verified.providerEventId, fingerprint: verified.fingerprint });
        }
        fingerprints.set(verified.providerEventId, { fingerprint: verified.fingerprint, outcome });
      }
    }
    // Transient handoffs are deliberately excluded from the returned evidence.
    void readbackHandoff;
    observations.push({ subjectId: subject.subjectId, execution, readback, ...(absence ? { absence } : {}) });
    cases.push({ subjectIds: [subject.subjectId], name: "execution, verification, capability and exact readback", passed: true });
  }
  return { subjects: observations, cases };
}

function requireFact(value: boolean, label: string): void {
  if (!value) throw new Error(`payment_adapter_conformance:${label}`);
}
function sameMoney(left: { amountMinor: number; currency: string }, right: { amountMinor: number; currency: string }): boolean {
  return left.amountMinor === right.amountMinor && left.currency === right.currency;
}
function sameIdentity(left: { provider: string; providerPaymentRef: string | null; intentRef: string; attemptRef: string }, right: typeof left): boolean {
  return left.provider === right.provider && left.providerPaymentRef === right.providerPaymentRef
    && left.intentRef === right.intentRef && left.attemptRef === right.attemptRef;
}

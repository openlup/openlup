import type { PaymentExecutionBaseInput } from "@openlup/core/testing";
import type { ExecutionCapability, SimulatorResult, ExecutionSubject, ExecutionProviderIdentity, ExecutionEvidence, AggregateKey, ResultStatus, DurableEventCounts, DurableEventAggregate, DurableEventFixtureCardinality, DurableEventWriteCardinality, DurableEventCardinalityExpectations, DurableEventSnapshot, EventReceipt, DurableEventCapability, DurableEventEvidence } from "./contracts/conformance.js";
import {
  validatePaymentExecutionContractResult,
} from "@openlup/core/testing";

/** Framework-free execution proof; durable event evidence is a separate capability. */
export async function runExecutionConformance<
  TInput extends PaymentExecutionBaseInput,
  TResult extends SimulatorResult,
>(input: ExecutionProviderIdentity & {
  readonly captured: ExecutionSubject<TInput, TResult>;
  readonly capturedLedger: { cardinality(): number };
  readonly refused: ExecutionSubject<TInput, TResult>;
  readonly request: TInput;
}): Promise<ExecutionEvidence> {
  assertEqual(input.capturedLedger.cardinality(), 0, "initial captured ledger cardinality");
  const captured = await input.captured.execute(input.request);
  const refused = await input.refused.execute(input.request);
  for (const result of [captured, refused]) {
    const validation = validatePaymentExecutionContractResult({
      input: input.request,
      result,
      expectedProvider: input.expectedProvider,
    });
    if (!validation.ok || validation.issues.length) {
      throw new Error(`Invalid simulator payment execution result: ${JSON.stringify(validation.issues)}`);
    }
  }
  assertEqual(captured.responsePayload.outcome, "captured", "captured subject outcome");
  assertEqual(refused.responsePayload.outcome, "refused", "refused subject outcome");
  const results = [captured, refused];
  const providerCalls = results.filter((result) => result.responsePayload.providerCall === true).length;
  const capturedEffects = input.capturedLedger.cardinality();
  const permanentRefusals = results.filter((result) => result.responsePayload.outcome === "refused"
    && result.providerDecline?.code === "payment_failed" && result.providerDecline.mandateUnsupported === false).length;
  if (capturedEffects !== 1 || permanentRefusals !== 1) {
    throw new Error("Expected one captured effect and one permanent simulator refusal.");
  }
  return {
    capability: { name: "simulator-execution", durabilityClaim: false },
    executions: results.length,
    providerCalls,
    capturedEffects,
    permanentRefusals,
  };
}

export async function runDurableEventConformance(
  subject: DurableEventCapability,
  expected: DurableEventCardinalityExpectations,
): Promise<DurableEventEvidence> {
  subject.assertSafe();
  let evidence: Omit<DurableEventEvidence, "cleanupResidualRows"> | undefined;
  try {
    assertEqual((await subject.reset()).residualRows, 0, "baseline residual rows");
    await subject.seed();
    const baseline = await subject.snapshot();
    assertCoreCounts(baseline.counts, expected.fixture, expected.baseline);

    const aSuccess = await deliver(subject, "outOfOrder", "a-success", "succeeded", "2026-07-29T10:00:00.000Z");
    const afterOutOfOrderSuccess = await subject.snapshot();
    assertEvent(afterOutOfOrderSuccess, aSuccess, "a-success", "outOfOrder", "processed");
    assertCoreCounts(afterOutOfOrderSuccess.counts, expected.fixture, expected.afterOutOfOrderSuccess);
    assertSucceeded(afterOutOfOrderSuccess.aggregates.outOfOrder);

    const aFailure = await deliver(subject, "outOfOrder", "a-failure", "failed", "2026-07-29T09:00:00.000Z");
    const afterOutOfOrderFailure = await subject.snapshot();
    assertEvent(afterOutOfOrderFailure, aFailure, "a-failure", "outOfOrder", "ignored");
    assertCoreCounts(afterOutOfOrderFailure.counts, expected.fixture, expected.afterOutOfOrderFailure);
    assertSucceeded(afterOutOfOrderFailure.aggregates.outOfOrder);
    assertStableAggregate(baseline.aggregates.outOfOrder, afterOutOfOrderFailure.aggregates.outOfOrder);

    const duplicate = await deliver(subject, "outOfOrder", "a-success", "succeeded", "2026-07-29T10:00:00.000Z");
    assertEqual(duplicate.ingest.replayed, true, "duplicate ingest replay");
    assertEqual(duplicate.apply.replayed, true, "duplicate apply replay");
    assertEqual(duplicate.ingest.paymentEventId, aSuccess.ingest.paymentEventId, "duplicate canonical event id");
    const afterDuplicate = await subject.snapshot();
    assertEvent(afterDuplicate, duplicate, "a-success", "outOfOrder", "processed");
    assertCoreCounts(afterDuplicate.counts, expected.fixture, expected.afterDuplicate);
    assertSucceeded(afterDuplicate.aggregates.outOfOrder);
    assertStableAggregate(afterOutOfOrderFailure.aggregates.outOfOrder, afterDuplicate.aggregates.outOfOrder);

    const bFailure = await deliver(subject, "lateSuccess", "b-failure", "failed", "2026-07-29T09:30:00.000Z");
    const afterLateFailure = await subject.snapshot();
    assertEvent(afterLateFailure, bFailure, "b-failure", "lateSuccess", "processed");
    assertCoreCounts(afterLateFailure.counts, expected.fixture, expected.afterLateFailure);
    assertEqual(JSON.stringify(Object.values(afterLateFailure.aggregates.lateSuccess).slice(4)), JSON.stringify(["pending_payment", "failed", "failed", "failed"]), "late failure statuses");

    const bSuccess = await deliver(subject, "lateSuccess", "b-success", "succeeded", "2026-07-29T10:30:00.000Z");
    const final = await subject.snapshot();
    assertEvent(final, bSuccess, "b-success", "lateSuccess", "processed");
    assertCoreCounts(final.counts, expected.fixture, expected.final);
    assertSucceeded(final.aggregates.lateSuccess);
    assertStableAggregate(baseline.aggregates.lateSuccess, final.aggregates.lateSuccess);
    evidence = {
      capability: { name: subject.name, durabilityClaim: true },
      baseline,
      afterOutOfOrderSuccess,
      afterOutOfOrderFailure,
      afterDuplicate,
      afterLateFailure,
      final,
    };
  } finally {
    const cleanup = await subject.reset();
    assertEqual(cleanup.residualRows, 0, "cleanup residual rows");
  }
  if (!evidence) throw new Error("Payment-event conformance produced no evidence");
  return { ...evidence, cleanupResidualRows: 0 };
}

async function deliver(subject: DurableEventCapability, aggregate: AggregateKey, eventKey: string, resultStatus: ResultStatus, occurredAt: string) {
  const ingest = await subject.ingest({ aggregate, eventKey, resultStatus, occurredAt });
  const apply = await subject.apply({ aggregate, eventKey, paymentEventId: ingest.paymentEventId, resultStatus, occurredAt });
  return { ingest, apply };
}

function assertCoreCounts(counts: DurableEventCounts, fixture: DurableEventFixtureCardinality, writes: DurableEventWriteCardinality): void {
  for (const [key, value] of Object.entries({ ...fixture, ...writes })) {
    assertEqual(counts[key as keyof DurableEventCounts], value, `${key} count`);
  }
}

function assertEvent(snapshot: DurableEventSnapshot, receipt: { ingest: EventReceipt }, eventKey: string, aggregate: AggregateKey, expectedState: string): void {
  const event = snapshot.events.find((candidate) => candidate.eventKey === eventKey);
  if (!event) throw new Error(`Missing durable event ${eventKey}`);
  assertEqual(event.id, receipt.ingest.paymentEventId, `${eventKey} canonical event id`);
  assertEqual(event.paymentIntentId, snapshot.aggregates[aggregate].paymentIntentId, `${eventKey} intent id`);
  assertEqual(event.paymentAttemptId, snapshot.aggregates[aggregate].paymentAttemptId, `${eventKey} attempt id`);
  assertEqual(event.processingStatus, expectedState, `${eventKey} processing status`);
}

function assertStableAggregate(before: DurableEventAggregate, after: DurableEventAggregate): void {
  for (const key of ["orderId", "paymentId", "paymentIntentId", "paymentAttemptId"] as const) {
    assertEqual(after[key], before[key], `stable ${key}`);
  }
}

function assertSucceeded(aggregate: DurableEventAggregate): void {
  assertEqual(aggregate.orderStatus, "paid", "order status");
  assertEqual(aggregate.paymentStatus, "succeeded", "payment status");
  assertEqual(aggregate.intentStatus, "succeeded", "intent status");
  assertEqual(aggregate.attemptStatus, "succeeded", "attempt status");
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
}

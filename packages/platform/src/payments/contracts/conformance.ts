import type { PaymentAdapter, PaymentAttemptPort, PaymentExecutionEnvelope } from "./adapter.js";
import type { PaymentAbsenceEnvelope, PaymentAbsencePort, PaymentReadbackEnvelope, PaymentReadbackPort } from "./evidence.js";

/** A fixture binds its own identity, adapter ports and inputs; scenarios accept multiple subjects. */
export interface PaymentAdapterConformanceSubject {
  subjectId: string;
  adapter: PaymentAdapter;
  executionInput: Parameters<PaymentAttemptPort["execute"]>[0];
  readbackInput: Parameters<PaymentReadbackPort["readPayment"]>[0];
  /** Required when the adapter supplies an absence port. */
  absenceInput?: Parameters<PaymentAbsencePort["proveAbsence"]>[0];
}

/** Runner-independent observations; never include transient input or raw diagnostics. */
export interface PaymentAdapterConformanceEvidence {
  subjects: readonly {
    subjectId: string;
    execution: Omit<PaymentExecutionEnvelope, "handoff">;
    readback: PaymentReadbackEnvelope & { handoff?: never };
    absence?: PaymentAbsenceEnvelope;
  }[];
  cases: readonly { subjectIds: readonly string[]; name: string; passed: boolean }[];
}

import type { PaymentExecutionBaseInput, PaymentExecutionContractResult } from "@openlup/core/testing";


export type ExecutionCapability = { readonly name: string; readonly durabilityClaim: false };


export type SimulatorResult = PaymentExecutionContractResult & {
  providerDecline?: { code?: string; mandateUnsupported?: boolean } | null;
};


export type ExecutionSubject<TInput extends PaymentExecutionBaseInput, TResult extends SimulatorResult> = {
  readonly execute: (request: TInput) => Promise<TResult>;
};


/**
 * The expected provider identity is a property of the adapter under proof, not of
 * this contract. The collector that constructs the subject owns that literal, so a
 * second runtime bundle proves the same behaviour under its own provider identity
 * and this contract names no provider at all.
 */
export type ExecutionProviderIdentity = { readonly expectedProvider: string };


export type ExecutionEvidence = {
  readonly capability: ExecutionCapability;
  readonly executions: number;
  readonly providerCalls: number;
  readonly capturedEffects: number;
  readonly permanentRefusals: number;
};


export type AggregateKey = "outOfOrder" | "lateSuccess";

export type ResultStatus = "succeeded" | "failed";


export type DurableEventCounts = {
  clients: number;
  orders: number;
  payments: number;
  intents: number;
  attempts: number;
  events: number;
  transitions: number;
  idempotencyKeys: number;
  outboxEvents: number;
};


export type DurableEventAggregate = {
  orderId: string;
  paymentId: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  orderStatus: string;
  paymentStatus: string;
  intentStatus: string;
  attemptStatus: string;
};


/** Fixture cardinality that stays constant for the whole run. */
export type DurableEventFixtureCardinality = Pick<
  DurableEventCounts,
  "clients" | "orders" | "payments" | "intents" | "attempts"
>;


/** Durable writes the adapter emits per step. */
export type DurableEventWriteCardinality = Pick<
  DurableEventCounts,
  "events" | "transitions" | "idempotencyKeys" | "outboxEvents"
>;


/**
 * Exact write cardinality is adapter-owned, not part of the portable contract:
 * how many transitions, idempotency keys, and outbox rows one payment event
 * produces is a property of the writer and outbox fan-out under proof, and a
 * second runtime bundle emits its own. The behavioural assertions below (no
 * second canonical event, no regression after a stale failure, convergence on
 * late success) are the portable part; the collector that owns the adapter
 * injects its own numbers so they are still asserted at the exact same step.
 */
export type DurableEventCardinalityExpectations = {
  readonly fixture: DurableEventFixtureCardinality;
  readonly baseline: DurableEventWriteCardinality;
  readonly afterOutOfOrderSuccess: DurableEventWriteCardinality;
  readonly afterOutOfOrderFailure: DurableEventWriteCardinality;
  readonly afterDuplicate: DurableEventWriteCardinality;
  readonly afterLateFailure: DurableEventWriteCardinality;
  readonly final: DurableEventWriteCardinality;
};


export type DurableEventSnapshot = {
  counts: DurableEventCounts;
  aggregates: Record<AggregateKey, DurableEventAggregate>;
  events: Array<{
    id: string;
    eventKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    processingStatus: string;
  }>;
};


export type EventReceipt = { paymentEventId: string; replayed: boolean };


export type DurableEventCapability = {
  readonly name: string;
  readonly durabilityClaim: true;
  assertSafe(): void;
  reset(): Promise<{ residualRows: number }>;
  seed(): Promise<void>;
  snapshot(): Promise<DurableEventSnapshot>;
  ingest(input: {
    aggregate: AggregateKey;
    eventKey: string;
    resultStatus: ResultStatus;
    occurredAt: string;
  }): Promise<EventReceipt>;
  apply(input: {
    aggregate: AggregateKey;
    paymentEventId: string;
    eventKey: string;
    resultStatus: ResultStatus;
    occurredAt: string;
  }): Promise<{ replayed: boolean }>;
};


export type DurableEventEvidence = {
  capability: { name: string; durabilityClaim: true };
  baseline: DurableEventSnapshot;
  afterOutOfOrderSuccess: DurableEventSnapshot;
  afterOutOfOrderFailure: DurableEventSnapshot;
  afterDuplicate: DurableEventSnapshot;
  afterLateFailure: DurableEventSnapshot;
  final: DurableEventSnapshot;
  cleanupResidualRows: 0;
};

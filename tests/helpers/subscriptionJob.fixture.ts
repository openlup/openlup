import type { Pool } from "pg";
import { expect, vi } from "vitest";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import type { NativeRenewalCodec, SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { RenewalDue, RenewalExecutionRequest, RenewalFrozenSnapshot, RenewalReadback, RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";
import { createM10SubscriptionReferenceBinding } from "../../server/runtime/public-reference/m10SubscriptionBinding.js";
import { createPostgresRenewalSettlementPort } from "../../server/adapters/postgres/commerce/renewalSettlement.js";
import { AT, later, type Renewal, type RenewalSeed } from "../postgres/subscriptionNativeFixture.js";

export const transaction = async <T>(pool: Pool, work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T> => {
  const db = await pool.connect();
  try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
};
export function preHoldRetryExecutor(db: SubscriptionQueryExecutor): SubscriptionQueryExecutor {
  // The historical worker did not have the hold predicate or its column.
  return { query: (sql, values) => db.query(sql
    .replace("op.claimed_before_rnw_1 AS renewal_held", "false AS renewal_held")
    .replace(/\n\s*AND \(NOT op\.claimed_before_rnw_1[\s\S]+?(?=\n\s*ORDER BY o\.next_retry_at)/u, ""), values) };
}

export function bindSubscriptionJob(pool: Pool, f: RenewalSeed & { operation?: string }, enabled = true, ambiguous?: Renewal,
  beforeQuery?: (sql: string) => Promise<void>, retryExecutor?: SubscriptionQueryExecutor) {
  let now = later(1), method = "frozen-method", declined = false, ready = true;
  let operationId = f.operation;
  const withTransaction = <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => transaction(pool, work);
  const snapshot: RenewalFrozenSnapshot = {
    contractVersion: "platform.subscription.renewal.v1", subscriptionId: f.subscription, clientId: f.client,
    scheduledAt: AT, scheduledInstant: Date.parse(AT), frozenRevision: "original", frozenFingerprint: f.fingerprint,
    cycle: { status: "correlated", logicalCycleNumber: 3, nativeRenewalCounter: 2, activationCycleId: null, evidenceRef: "fixture-known-activation" },
    retryAttempt: 0, externalAttemptSequence: 0,
    templateSnapshot: { templateId: "original", version: 1, cadenceDays: 28, lines: f.snapshot.lines },
    pricingSnapshot: { currency: "XXX", totalAmountMinor: f.snapshot.totalAmountMinor, shippingAmountMinor: 0, agreementPolicy: "lock_until_edit", proration: "none" },
    orderSnapshot: { shippingAddressRef: null, shippingQuoteRef: null, acquisitionRef: null, lines: f.snapshot.lines },
    stockSourceKey: f.source, settlementChannelKey: "fixture", authorizationRef: "frozen-mandate", payerAccountRef: null, unattendedChargeAuthorizedAt: AT,
  };
  const due: RenewalDue = { ...snapshot, cadenceDays: 28, currency: "XXX", deliveryAdmission: "allowed", deliveryBlockReason: null };
  const codec: NativeRenewalCodec = {
    due: raw => ({ ...due, scheduledAt: String(raw.scheduled_at), scheduledInstant: Date.parse(String(raw.scheduled_at)), subscriptionId: String(raw.subscription_id) }),
    freeze: () => {
      if (f.operation) throw new Error("must_resume_original_snapshot");
      return snapshot;
    },
    encode: () => f.snapshot,
    decode: wire => {
      if (ambiguous && wire.subscriptionId === ambiguous.subscription) return { ...snapshot, subscriptionId: ambiguous.subscription,
        cycle: { status: "ambiguous", logicalCycleNumber: null, nativeRenewalCounter: 2, activationCycleId: null, reason: "unknown_activation" } };
      expect(wire).toEqual(f.snapshot); return snapshot;
    },
    identity: () => f.identity, fingerprint: () => f.fingerprint,
    readback: raw => ({ ...raw, scheduledInstant: Date.parse(String(raw.scheduledAt)), cycle: snapshot.cycle, cycleSnapshot: snapshot }) as unknown as RenewalReadback,
  };
  const execution = (intent: string, order: string, key: string): RenewalExecutionRequest => ({
    cycleIdempotencyKey: f.identity, executionIdempotencyKey: key, externalIdempotencyKey: `${key}:provider`, requestFingerprint: "f".repeat(64),
    paymentIntentId: intent, amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", mode: "subscription", orderRef: order, orderId: order,
    flow: "off_session", customerRef: null, paymentMethodRef: method, recurringModel: null, clientId: f.client, payer: null,
  });
  const execute = vi.fn(async () => ({ status: "pending" as const, externalAttemptRef: "original-ack" }));
  const evidence = (external: string, event: string) => {
    if (!operationId) throw new Error("payment_evidence_requires_claim");
    return {
      status: declined ? "failed" as const : "succeeded" as const, disposition: "observed" as const,
      operationId, eventKey: event, requestFingerprint: f.fingerprint, verifiedEvidenceRef: `${event}:verified`,
      externalAttemptRef: external, occurredAt: now, observedAt: now, firstRecordedAt: now,
      amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", reason: declined ? "declined" : null,
    };
  };
  const queries: string[] = [];
  const executor = { async query(sql: string, values?: unknown[]) { queries.push(sql); await beforeQuery?.(sql); return pool.query(sql, values); } };
  const retryOptions = { executor: retryExecutor ?? executor, withTransaction, decode: codec.decode,
    readFrozenMandate: async () => ({ authorized: true, authorizationRef: "frozen-mandate", paymentMethodRef: "frozen-method" }),
    retryInput: (_snapshot: RenewalFrozenSnapshot, row: { settlementIntentId: string; orderId: string; retryAttempt: number }) => execution(row.settlementIntentId, row.orderId, `${f.identity}:retry:${row.retryAttempt}`),
    validateInput: () => {}, payments: { execute, readOutcome: async (prepared: { attemptSequence: number }) => evidence(`retry-${prepared.attemptSequence}`, `${f.identity}:retry-outcome:${prepared.attemptSequence}`) },
    failureTemplate: "failed", recoveredTemplate: "recovered", recoveryPath: "/repair", classifyFailure: () => "temporary",
  };
  const lease = vi.fn();
  const withRunLease = async <T>(population: string, work: () => Promise<T>): Promise<T | null> => {
    lease(population);
    const db = await pool.connect();
    try {
      const result = await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [population]);
      if (!result.rows[0].acquired) return null;
      try { return await work(); } finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [population]); }
    } finally { db.release(); }
  };
  const readiness = vi.fn(async () => ({ state: ready ? "ready" as const : "unknown" as const, candidate: { artifact: "fixture", configuration: "fixture", environment: "disposable", database: "fixture", schema: "complete" }, loadedPackages: [], issues: [] }));
  const binding = createM10SubscriptionReferenceBinding({
    enabled, population: `fixture:${f.subscription}`, executor, withTransaction, withRunLease, codec,
    settlement: db => createPostgresRenewalSettlementPort(db) as unknown as RenewalSettlementPort,
    inventory: createPostgresRenewalReservationPort(pool),
    paymentRails: { resolve: () => ({ execute, findExternalAttempt: async () => "original-ack", readOutcome: async () => evidence("original-ack", `${f.identity}:original-evidence`) }) },
    policy: { executionInput: (_due, operation, prepared) => {
      operationId = operation.operationId;
      return execution(prepared.settlementIntentId, prepared.orderId, `${f.identity}:original`);
    }, validateInput: () => {}, classifyFailure: () => "temporary", identityKey: row => row.subscriptionId === ambiguous?.subscription ? ambiguous.identity : f.identity },
    retry: retryOptions, failureTemplate: "failed", recoveryPath: "/repair", workerId: "composed", now: () => now,
    version: "0.24.0", catalogue: { version: "complete-test-catalogue", migration: "native-test-catalogue" }, readiness, cadenceSeconds: 60,
  });
  return { binding, codec, snapshot, queries, execute, lease, readiness, retryOptions,
    succeed: () => { declined = false; },
    time: (value: string) => { now = value; }, method: (value: string) => { method = value; }, decline: () => { declined = true; }, unready: () => { ready = false; } };
}

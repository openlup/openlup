import { connectedNativeStoreTables } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import { api, active, purchase, admin, at, composition, payments, destinations, inventory, captureStore, withRestoredStore, days, deps, executor, facts, fulfillment, later, now, retire, restartDatabase, freshRetryReadback, rpc, runtime, settlement, stock, transaction } from "./subscriptionPublicRenewalFixture.js";
import type { NativeRetryDriverOptions, NativeRenewalPurchaseFacts } from "@openlup/platform/subscriptions";
import type { RenewalReadback } from "@openlup/platform/subscriptions/contracts";

beforeEach(async () => {
  await retire();
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  await stock(1000);
});

it.each(["succeeded", "declined"] as const)("replays %s through the installed public runner before and after cancellation with zero writes or payment execution", async scenario => {
  const f = await active(), d = await deps(f.subscriptionId, scenario);
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  expect(result.status).toBe(scenario === "succeeded" ? "succeeded" : "refused");
  const original = (await d.input.store.readRenewal(result.identityKey))!;
  const wire = d.codec.encode(original.cycleSnapshot);
  for (const cancelled of [false, true]) {
    if (cancelled) await rpc("subscription_apply_lifecycle_action", [f.clientId, `cancel:${f.subscriptionId}`, f.subscriptionId, "cancel", "{}", later]);
    const before = await allPublicRows(admin), count = d.execute.mock.calls.length;
    for (let n = 0; n < 2; n++) expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, later)).toMatchObject({ status: "terminal_replay", replayed: true, operationId: result.operationId });
    await expect(rpc("subscription_claim_due_renewal", [original.identityKey, "f".repeat(64), wire, "changed", 300, later])).rejects.toMatchObject({ code: "23505" });
    await expect(rpc("subscription_claim_due_renewal", [original.identityKey, original.operationFingerprint, JSON.stringify({ ...wire, authorizationRef: "changed" }), "changed", 300, later])).rejects.toMatchObject({ code: "23505" });
    expect(d.execute).toHaveBeenCalledTimes(count);
    expect(await allPublicRows(admin)).toEqual(before);
  }
});

it("cancellation refuses new work and nonterminal takeover without changing the historical operation", async () => {
  for (const claimed of [false, true]) {
    const f = await active(), d = await deps(f.subscriptionId, "succeeded");
    if (claimed) await d.input.store.claimDue({ snapshot: await d.input.store.buildCycleSnapshots(d.due), workerId: "first", now });
    await rpc("subscription_apply_lifecycle_action", [f.clientId, `cancel:${f.subscriptionId}`, f.subscriptionId, "cancel", "{}", later]);
    const before = await allPublicRows(admin);
    await expect(api.runOneAutomaticSubscriptionRenewal(d.input, d.due, later)).rejects.toMatchObject({ code: "22023", message: "subscription_renewal_claim_not_due" });
    expect(d.execute).not.toHaveBeenCalled(); expect(await allPublicRows(admin)).toEqual(before);
  }
});

function binding(d: Awaited<ReturnType<typeof deps>>, clock: () => string) {
  const unused = async (): Promise<never> => { throw new Error("unexpected_retry_on_stock_fixture"); };
  const queries = vi.fn(executor.query);
  const native = api.createNativeSubscriptionBinding({ enabled: true, batchLimit: 7, population: `public-renewal:${d.due.subscriptionId}`, executor: { query: queries },
    withTransaction: transaction, withRunLease: async (_population, work) => {
      const db = await runtime.connect();
      try {
        if (!(await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", ["g7-population"])).rows[0].acquired) return null;
        try { return await work(); } finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["g7-population"]); }
      } finally { db.release(); }
    }, codec: d.codec, settlement: db => settlement(d.codec, db), inventory: d.input.inventory,
    paymentRails: d.input.paymentRails, policy: d.input.policy,
    retry: { readFrozenMandate: unused, retryInput: () => { throw new Error("unexpected_retry"); }, payments: { execute: unused, readOutcome: unused }, recoveredTemplate: "recovered" },
    failureTemplate: "failed", recoveryPath: "/recover", workerId: "public-binding", now: clock,
    catalogue: { version: "complete-test-catalogue", migration: "native-test-catalogue" },
    readiness: async () => ({ state: "ready", candidate: { artifact: "fixture", configuration: "fixture", environment: "disposable", database: "fixture", schema: "complete" }, loadedPackages: [], issues: [] }),
  });
  return { ...native, queries, ...composition.createSubscriptionContribution({ version: "fixture", requiredSchema: native.schema, run: native.services.run, cadenceSeconds: 60 }) };
}

it("waits for stock and resumes the same frozen obligation through the installed public composition", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  let clock = now;
  await stock(0);
  const b = binding(d, () => clock);
  expect(b.contributions[0].schedules).toHaveLength(1);
  expect(Object.values(b.triggers)).toEqual([b.services.run]);
  expect(await b.services.run()).toMatchObject({ renewals: [{ status: "refused", reason: "inventory_unavailable" }] });
  expect(d.execute).not.toHaveBeenCalled();
  expect(b.queries.mock.calls.some(([sql, values]) => sql.includes("subscription_stock_wait_normal_due") && values?.[0] === 7)).toBe(true);
  const waiting = (await runtime.query("SELECT * FROM public.subscription_stock_wait_cases WHERE subscription_id=$1", [f.subscriptionId])).rows[0];
  expect(waiting.state).toBe("waiting");
  const frozen = JSON.stringify(waiting.cycle_snapshot), operationId = waiting.renewal_operation_id;
  const before = await allPublicRows(admin);
  await expect(api.createPostgresStockWaitStore({ executor, codec: d.codec, withTransaction: transaction, workerId: "refusal" }).admit({
    operationId, claimToken: randomUUID(), snapshot: { ...d.codec.decode(waiting.cycle_snapshot), frozenFingerprint: "0".repeat(64) }, now,
  })).rejects.toThrow();
  expect(await allPublicRows(admin)).toEqual(before);
  await stock(1000); clock = later;
  expect(await binding(d, () => clock).services.run()).toMatchObject({ renewals: [{ status: "succeeded", operationId }] });
  expect(d.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify((await runtime.query("SELECT cycle_snapshot FROM public.subscription_stock_wait_cases WHERE id=$1", [waiting.id])).rows[0].cycle_snapshot)).toBe(frozen);
  const operation = (await d.input.store.readRenewal(d.codec.identity(d.codec.decode(waiting.cycle_snapshot))))!;
  await expect(b.realizationAdmitted(operation.orderId!)).rejects.toThrow("realization_admission_missing");
  await parcel(operation.orderId!);
  expect(await b.realizationAdmitted(operation.orderId!)).toMatchObject({ state: "resumed" });
  expect(await b.realizationAdmitted(operation.orderId!)).toMatchObject({ state: "resumed" });
  expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].status).toBe("active");
});

async function parcel(orderId: string) {
  // Parcel facts use the bounded writer and the installation's synthetic port.
  const spine = fulfillment.createPostgresFulfillmentShipmentSpinePort(executor, { portKey: "g7-parcels" });
  return (await spine.createShipment({ idempotencyKey: `parcel:${orderId}`, orderId, requestedAt: at })).shipmentId;
}

it("defers an undelivered parcel, then extends only the next cycle for genuinely past delivery, without stacking", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
  const shipmentId = await parcel(f.orderId);
  const aligned = { ...d.input, store: api.withNativeDeliveryAlignmentRenewalAdmission(d.input.store, executor) };
  expect(await api.runOneAutomaticSubscriptionRenewal(aligned, d.due, now)).toMatchObject({ status: "deferred" });
  expect(d.execute).not.toHaveBeenCalled();
  expect((await runtime.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].next_cycle_at.toISOString()).toBe(d.due.scheduledAt);
  const deliveredAt = days(d.due.scheduledAt, 7);
  expect(Date.parse(deliveredAt)).toBeLessThan(Number((await admin.query("SELECT extract(epoch FROM now())*1000 AS ms")).rows[0].ms));
  const arrival = fulfillment.createPostgresDeliveryAlignmentPort(executor), input = { requestKey: `delivery:${shipmentId}`, parcelRef: shipmentId, deliveredAt, evidenceRef: `evidence:${shipmentId}` as const };
  expect(await arrival.recordArrival(input)).toMatchObject({ disposition: "aligned", nextCycleAt: days(deliveredAt, 28) });
  const before = await allPublicRows(admin);
  expect(await arrival.recordArrival(input)).toMatchObject({ replayed: true, nextCycleAt: days(deliveredAt, 28) });
  expect(await allPublicRows(admin)).toEqual(before);
  expect(await arrival.recordArrival({ ...input, requestKey: `older-delivery:${shipmentId}`, deliveredAt: days(deliveredAt, -1) })).toMatchObject({ nextCycleAt: days(deliveredAt, 28) });
  expect((await runtime.query("SELECT status,started_at FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0]).toMatchObject({ status: "active", started_at: new Date(at) });
  // No replacement confirmation is called. An undelivered replacement remains
  // an outstanding obligation in the unchanged alignment characterization.
});

function retryDriver(d: Awaited<ReturnType<typeof deps>>, observation: "ambiguous" | "declined" | "succeeded", observedAt: string, method = facts.methodRef, target = { executor, transaction }) {
  const retryExecutor = target.executor, retryTransaction = target.transaction;
  const operationStore = api.createPostgresRenewalStore(retryExecutor, d.codec, retryTransaction);
  const simulator = payments.createPostgresSandboxPaymentSimulator(retryExecutor, {
    dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  const execute = vi.fn(async (input: Parameters<NativeRetryDriverOptions["payments"]["execute"]>[0]) => {
    const attempt = await simulator.beginAttempt({ settlementIntentId: input.paymentIntentId, idempotencyKey: input.executionIdempotencyKey,
      requestFingerprint: input.requestFingerprint, methodFacts: { authorizationRef: d.due.authorizationRef,
        unattendedChargeAuthorizedAt: d.due.unattendedChargeAuthorizedAt, payerAccountRef: d.due.payerAccountRef,
        methodRef: method, methodEvidenceRef: facts.methodEvidenceRef }, at: observedAt });
    return { status: "pending" as const, externalAttemptRef: attempt.id };
  });
  // The simulator owns attempts and observations; recovery owns truth ingestion.
  const options: NativeRetryDriverOptions = { executor: retryExecutor, withTransaction: retryTransaction, decode: d.codec.decode,
    readFrozenMandate: async snapshot => ({ authorized: (await api.createPostgresPurchaseRenewalWriter(retryExecutor).readMethod(snapshot.subscriptionId))?.healthState === "healthy",
      authorizationRef: snapshot.authorizationRef, paymentMethodRef: facts.methodRef }),
    retryInput: (snapshot, row) => ({ ...api.createSandboxRenewalPolicy(method).executionInput(d.due,
      { cycleSnapshot: snapshot, identityKey: row.identityKey, operationFingerprint: row.requestFingerprint } as RenewalReadback,
      { settlementIntentId: row.settlementIntentId, orderId: row.orderId }),
      executionIdempotencyKey: `${row.identityKey}:retry:${row.retryAttempt}`, externalIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}` }),
    validateInput: d.input.policy.validateInput, classifyFailure: () => "temporary", failureTemplate: "failed", recoveredTemplate: "recovered", recoveryPath: "/recover",
    payments: { execute, readOutcome: async (prepared, snapshot) => {
      const attempt = await simulator.readAttempt({ settlementIntentId: prepared.settlementIntentId });
      if (!attempt) throw new Error("missing_saved_simulator_attempt");
      const eventKey = `retry-observation:${prepared.obligationId}:${prepared.attemptSequence}:${observation}`;
      if (observation !== "ambiguous") await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: eventKey,
        outcome: observation === "succeeded" ? "captured" : "refused", occurredAt: observedAt });
      const saved = await simulator.readAttempt({ settlementIntentId: prepared.settlementIntentId, attemptId: attempt.id });
      const evidence = saved!.latestObservation;
      return {
        status: observation === "succeeded" ? "succeeded" : observation === "declined" ? "failed" : "unknown",
        disposition: observation === "ambiguous" ? "ambiguous" : "observed", operationId:
          (await operationStore.readRenewal(prepared.identityKey))!.operationId,
        eventKey, requestFingerprint: prepared.operationFingerprint,
        verifiedEvidenceRef: evidence ? `sandbox:${evidence.id}` : "", externalAttemptRef: attempt.id,
        occurredAt: evidence?.occurredAt ?? null, observedAt, firstRecordedAt: observedAt,
        amountMinor: snapshot.pricingSnapshot.totalAmountMinor, currency: snapshot.pricingSnapshot.currency,
        reason: observation === "declined" ? "fixture_declined" : null,
        ...(evidence ? { sourceEvidence: { sourceKind: "accepted_event" as const, sourceReference: evidence.id,
          attemptRef: attempt.id, observedStatus: evidence.outcome, observedAt: evidence.occurredAt, payloadFingerprint: evidence.fingerprint } } : {}),
      };
    } },
  };
  return { driver: api.createNativeRetryDriver(options), execute, options };
}

it.each(["canonical", "uppercase", "compact", "braced", "grouped"] as const)("matches host UUIDs by value for retry and recovery (%s)", async spelling => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  if (spelling === "uppercase") {
    const snapshot = await d.input.store.buildCycleSnapshots(d.due);
    expect(d.codec.withDestination!(snapshot, snapshot.orderSnapshot.shippingAddressRef!.toUpperCase())).toEqual(snapshot);
    expect(() => d.codec.withDestination!(snapshot, "not-a-uuid")).toThrow();
  }
  const spell = (id: string) => spelling === "canonical" ? id : spelling === "uppercase" ? id.toUpperCase()
    : spelling === "compact" ? id.replaceAll("-", "") : spelling === "braced" ? `{${id.toUpperCase()}}`
    : id.replaceAll("-", "").match(/.{4}/g)!.join("-").toUpperCase();
  for (const id of [row.settlementIntentId, row.orderId, first.operationId]) {
    expect((await runtime.query("SELECT $1::uuid::text AS id", [spell(id)])).rows[0].id).toBe(id);
  }
  const recovery = retryDriver(d, "succeeded", retryAt), original = recovery.options;
  const retry = api.createNativeRetryDriver({ ...original,
    retryInput: (snapshot, obligation) => ({ ...original.retryInput(snapshot, obligation),
      paymentIntentId: spell(obligation.settlementIntentId), orderRef: spell(obligation.orderId) }),
    payments: { ...original.payments, readOutcome: async (prepared, snapshot) => ({ ...await original.payments.readOutcome(prepared, snapshot),
      operationId: spell(first.operationId) }) },
  });
  expect(await retry.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  expect(await store.read(first.operationId)).toMatchObject({ state: "recovered", externalAttemptSequence: 1 });
  const prepared = (await runtime.query("SELECT input FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='prepare'", [first.operationId])).rows;
  expect(prepared).toHaveLength(1);
  expect(prepared[0].input).toMatchObject({ paymentIntentId: row.settlementIntentId, orderRef: row.orderId });
  expect((await runtime.query(`SELECT
    (SELECT count(*)::integer FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND outcome='captured') AS captures,
    (SELECT status FROM public.commerce_settlement_intents WHERE id=$1) AS status,
    (SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id=$2) AS cycles`, [row.settlementIntentId, f.subscriptionId])).rows[0])
    .toEqual({ captures: 1, status: "settled", cycles: 2 });
  const before = await allPublicRows(admin);
  expect(await retry.run(retryAt, 50)).toEqual([]);
  expect(recovery.execute).toHaveBeenCalledTimes(1); expect(await allPublicRows(admin)).toEqual(before);
});

it.each(["paymentIntentId", "orderRef"] as const)("refuses an invalid retry UUID in %s without preparing or charging", async field => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  const recovery = retryDriver(d, "succeeded", retryAt), original = recovery.options;
  const retry = api.createNativeRetryDriver({ ...original, retryInput: (snapshot, obligation) => ({ ...original.retryInput(snapshot, obligation), [field]: "not-a-uuid" }) });
  const before = await allPublicRows(admin);
  expect(await retry.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "frozen_mandate_mismatch" }]);
  expect(recovery.execute).not.toHaveBeenCalled(); expect(await allPublicRows(admin)).toEqual(before);
});

it("refuses an invalid operation UUID in outcome evidence without settlement or redispatch", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  const recovery = retryDriver(d, "succeeded", retryAt), original = recovery.options;
  const retry = api.createNativeRetryDriver({ ...original, payments: { ...original.payments,
    readOutcome: async (prepared, snapshot) => ({ ...await original.payments.readOutcome(prepared, snapshot), operationId: "not-a-uuid" }) } });
  expect(await retry.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  expect(await store.read(first.operationId)).toMatchObject({ state: "prepared" });
  expect((await runtime.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [row.settlementIntentId])).rows[0].status).toBe("failed");
  const next = retryDriver(d, "succeeded", retryAt);
  expect(await next.driver.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(next.execute).not.toHaveBeenCalled();
});

it("exhausts the real retry ladder without pausing, refuses unhealthy recovery, and authorizes only after bounded method repair", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const store = api.createPostgresRetryStore(executor);
  for (let sequence = 1; sequence <= 3; sequence++) {
    const row = (await store.read(result.operationId))!;
    const r = retryDriver(d, "declined", row.nextRetryAt!);
    expect(await r.driver.run(row.nextRetryAt!, 50)).toEqual([{ operationId: result.operationId, status: "refused" }]);
    expect(r.execute).toHaveBeenCalledTimes(1);
  }
  const exhausted = (await store.read(result.operationId))!;
  expect(exhausted).toMatchObject({ state: "waiting", retryAttempt: 4, nextRetryAt: null });
  expect((await runtime.query("SELECT status,next_retry_at,expired_at FROM public.subscription_dunning_cases WHERE id=$1", [exhausted.caseId])).rows)
    .toEqual([{ status: "open", next_retry_at: null, expired_at: null }]);
  expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].status).toBe("active");
  const beforeExhausted = await allPublicRows(admin), noMore = retryDriver(d, "declined", days(now, 50));
  expect(await noMore.driver.run(days(now, 50), 50)).toEqual([]); expect(noMore.execute).not.toHaveBeenCalled();
  expect(await allPublicRows(admin)).toEqual(beforeExhausted);
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: `missing:${f.subscriptionId}`, expectedState: "healthy", healthState: "method_missing", methodRef: facts.methodRef, evidenceRef: "sandbox-missing" });
  const liveNow = (await admin.query("SELECT now() AS now")).rows[0].now.toISOString();
  const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
  expect(await rpc("dunning_lifecycle_issue_recovery_token", [exhausted.caseId, tokenHash, days(liveNow, 2)])).toMatchObject({ issued: true });
  const token = (await runtime.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [tokenHash])).rows[0].id;
  const beforeUnhealthy = await allPublicRows(admin);
  await expect(store.authorizeRecovery(result.operationId, token, facts.methodRef, "fresh-sandbox-evidence", liveNow)).rejects.toMatchObject({ code: "22023" });
  expect(await allPublicRows(admin)).toEqual(beforeUnhealthy);
  await writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: `repaired:${f.subscriptionId}`, expectedState: "method_missing", healthState: "healthy", methodRef: facts.methodRef, evidenceRef: "fresh-sandbox-evidence" });
  expect(await writer.readMethod(f.subscriptionId)).toMatchObject({ healthState: "healthy", evidenceRef: "fresh-sandbox-evidence" });
  const auth = await store.authorizeRecovery(result.operationId, token, facts.methodRef, "fresh-sandbox-evidence", liveNow);
  expect(await store.authorizeRecovery(result.operationId, token, facts.methodRef, "fresh-sandbox-evidence", liveNow)).toEqual(auth);
  await expect(store.authorizeRecovery(result.operationId, token, "changed", "fresh-sandbox-evidence", liveNow)).rejects.toMatchObject({ code: "23505" });
  await store.scheduleRecovery(result.operationId, `schedule:${result.operationId}`, String(auth.id), liveNow);
  const recovery = retryDriver(d, "succeeded", liveNow);
  expect(await recovery.driver.run(liveNow, 50)).toEqual([{ operationId: result.operationId, status: "succeeded" }]);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  expect(await store.read(result.operationId)).toMatchObject({ state: "recovered", retryAttempt: 4 });
  expect((await runtime.query("SELECT consumed_at FROM public.subscription_retry_recovery_authorizations WHERE id=$1", [auth.id])).rows[0].consumed_at).not.toBeNull();
  expect((await runtime.query("SELECT revoked_at FROM public.commerce_checkout_recovery_tokens WHERE id=$1", [token])).rows[0].revoked_at).not.toBeNull();
});

it("never redispatches an ambiguous prepared retry, accepts matching late evidence, and extends by eleven whole past days once", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  const refusedBefore = await allPublicRows(admin), wrongMethod = retryDriver(d, "ambiguous", retryAt, "changed-method");
  expect(await wrongMethod.driver.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "frozen_mandate_mismatch" }]);
  expect(wrongMethod.execute).not.toHaveBeenCalled(); expect(await allPublicRows(admin)).toEqual(refusedBefore);
  const pending = retryDriver(d, "ambiguous", retryAt);
  const raced = await Promise.all([pending.driver.run(retryAt, 50), pending.driver.run(retryAt, 50)]);
  // A contender may have selected its receipt projection before the other
  // committed prepare. The donor reports that stale read as a row-local error;
  // the durable fence and the next exact read, not both status strings, matter.
  expect(raced.flat().every(row => row.operationId === first.operationId && ["awaiting_provider", "error"].includes(row.status))).toBe(true);
  expect(raced.flat()).toContainEqual({ operationId: first.operationId, status: "awaiting_provider" });
  expect(pending.execute).toHaveBeenCalledTimes(1);
  expect(await store.read(first.operationId)).toMatchObject({ state: "prepared", externalAttemptSequence: 1 });
  const afterContention = retryDriver(d, "ambiguous", retryAt);
  expect(await afterContention.driver.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
  expect(afterContention.execute).not.toHaveBeenCalled();
  const prepared = (await runtime.query("SELECT receipt_key,input,result FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='prepare'", [first.operationId])).rows[0];
  await expect(store.prepare(first.operationId, `other-key:${first.operationId}`, prepared.input, days(retryAt, 1))).rejects.toThrow("ambiguous");
  await expect(store.prepare(first.operationId, prepared.receipt_key, { ...prepared.input, paymentMethodRef: "changed" }, retryAt)).rejects.toMatchObject({ code: "23505" });
  await restartDatabase();
  expect(await freshRetryReadback(first.operationId, days(retryAt, 1))).toEqual({ results: [{ operationId: first.operationId, status: "awaiting_provider" }], executions: 0, reads: 1 });
  // New driver instances reconstruct only persisted preparation, never execute.
  const before = await allPublicRows(admin);
  for (let n = 0; n < 2; n++) {
    const restarted = retryDriver(d, "ambiguous", days(retryAt, 1));
    expect(await restarted.driver.run(days(retryAt, 1), 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
    expect(restarted.execute).not.toHaveBeenCalled();
  }
  expect(await allPublicRows(admin)).toEqual(before);
  const recoveredAt = days(d.due.scheduledAt, 11.25);
  expect(Date.parse(recoveredAt)).toBeLessThan(Date.now());
  const recovery = retryDriver(d, "succeeded", recoveredAt);
  expect(await recovery.driver.run(recoveredAt, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(recovery.execute).not.toHaveBeenCalled();
  const expected = days(d.due.scheduledAt, 28 + 11);
  expect((await runtime.query("SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0]).toEqual({ next_cycle_at: new Date(expected), status: "active" });
  const paid = await allPublicRows(admin);
  expect(await retryDriver(d, "succeeded", recoveredAt).driver.run(days(recoveredAt, 1), 50)).toEqual([]);
  expect(await allPublicRows(admin)).toEqual(paid);
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_cycles WHERE subscription_id=$1", [f.subscriptionId])).rows[0].n).toBe(2);
});


it("retains protected admission after mode rollback, then resumes the same frozen schedule only after actual arrival", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded", days(now, 8));
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('protect')");
  const shipmentId = await parcel(f.orderId), input = { ...d.input, store: api.withNativeDeliveryAlignmentRenewalAdmission(d.input.store, executor) };
  expect(await api.runOneAutomaticSubscriptionRenewal(input, d.due, now)).toMatchObject({ status: "deferred" });
  const original = (await input.store.readRenewal(d.codec.identity(await input.store.buildCycleSnapshots(d.due))))!;
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  expect(await api.runOneAutomaticSubscriptionRenewal(input, d.due, later)).toMatchObject({ status: "deferred" });
  expect(d.execute).not.toHaveBeenCalled();
  await fulfillment.createPostgresDeliveryAlignmentPort(executor).recordArrival({ requestKey: `protect-arrival:${shipmentId}`, parcelRef: shipmentId,
    deliveredAt: days(d.due.scheduledAt, 7), evidenceRef: `evidence:${shipmentId}` });
  expect((await runtime.query("SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([{ state: "released" }]);
  expect((await runtime.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].next_cycle_at.toISOString()).toBe(d.due.scheduledAt);
  const resumed = await api.runOneAutomaticSubscriptionRenewal(input, d.due, days(later, 8));
  expect(resumed).toMatchObject({ status: "succeeded", operationId: original.operationId });
  expect((await input.store.readRenewal(original.identityKey))!.cycleSnapshot).toEqual(original.cycleSnapshot);
  expect(d.execute).toHaveBeenCalledTimes(1);
});


it("forwards the payment owner's captured observation into the real recovery writer", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const store = api.createPostgresRetryStore(executor), row = (await store.read(first.operationId))!;
  const recoveredAt = row.nextRetryAt!, recovery = retryDriver(d, "succeeded", recoveredAt);
  let sourceEvidence: Awaited<ReturnType<NativeRetryDriverOptions["payments"]["readOutcome"]>>["sourceEvidence"];
  const read = recovery.options.payments.readOutcome;
  recovery.options.payments.readOutcome = async (...input) => {
    const result = await read(...input); sourceEvidence = result.sourceEvidence; return result;
  };
  expect(await recovery.driver.run(recoveredAt, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  const receipt = (await runtime.query(`SELECT receipt_key,input FROM public.subscription_retry_receipts
    WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='recovery'`, [first.operationId])).rows[0];
  expect(receipt.input).toMatchObject({ ...sourceEvidence, evidenceKey: `sandbox:${sourceEvidence!.sourceReference}` });
  const before = await allPublicRows(admin);
  await store.recordRecovery(first.operationId, receipt.receipt_key, receipt.input);
  await expect(store.recordRecovery(first.operationId, receipt.receipt_key, { ...receipt.input, attemptRef: randomUUID() })).rejects.toMatchObject({ code: "23505" });
  expect(await allPublicRows(admin)).toEqual(before);
});

it("captures populated retry, token, destination and draft rows, restores cleanly, completes a pending duty and continues", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const store = api.createPostgresRetryStore(executor), row = (await store.read(first.operationId))!;
  const liveNow = (await admin.query("SELECT now() AS now")).rows[0].now.toISOString();
  const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
  expect(await rpc("dunning_lifecycle_issue_recovery_token", [row.caseId, tokenHash, days(liveNow, 2)])).toMatchObject({ issued: true });
  const token = (await runtime.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [tokenHash])).rows[0].id;
  const authorization = await store.authorizeRecovery(first.operationId, token, facts.methodRef, facts.methodEvidenceRef, liveNow);
  await store.scheduleRecovery(first.operationId, `transfer-recovery:${first.operationId}`, String(authorization.id), liveNow);
  const pending = retryDriver(d, "ambiguous", liveNow);
  expect(await pending.driver.run(liveNow, 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
  expect(pending.execute).toHaveBeenCalledTimes(1);
  const next = await active(), waiting = await deps(next.subscriptionId, "succeeded");
  await stock(0);
  await binding(waiting, () => now).services.run();
  const tables = ["subscription_retry_obligations", "subscription_retry_receipts", "subscription_retry_recovery_authorizations",
    "commerce_checkout_recovery_tokens", "subscription_stock_wait_cases", "subscription_dunning_cases", "subscription_dunning_notifications"];
  for (const table of tables) expect(Number((await runtime.query(`SELECT count(*) AS n FROM public.${table}`)).rows[0].n)).toBeGreaterThan(0);
  const receipts = (await admin.query("SELECT response_payload FROM public.commerce_order_draft_receipts")).rows;
  expect(receipts.length).toBeGreaterThan(0);
  expect(receipts.every(row => row.response_payload.orderDraft.quoteSnapshot)).toBe(true);
  expect(Number((await admin.query("SELECT count(*) AS n FROM public.fulfillment_stock_operations")).rows[0].n)).toBeGreaterThan(0);
  const profile = new Set<string>(connectedNativeStoreTables), outside: string[] = [];
  const relations = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename } of relations) {
    if (profile.has(tablename) || tablename === "platform_schema_migrations") continue;
    const identifier = String(tablename).replaceAll('"', '""');
    if ((await admin.query(`SELECT 1 FROM public."${identifier}" LIMIT 1`)).rows.length) outside.push(tablename);
  }
  expect(outside).toEqual([]);
  await stock(1000);
  const pendingPurchase = await purchase();
  const fault = { async query(sql: string, args?: unknown[]) {
    if (sql.includes("subscription_complete_renewal_attachment")) throw new Error("synthetic_completion_unavailable");
    return executor.query(sql, args);
  } };
  const duty = await api.activateNativePurchaseWithRenewal(fault, { ...pendingPurchase, facts });
  expect(duty.renewalAttachment).toBe("pending");
  const before = await allPublicRows(admin), packet = await captureStore(admin, "public-renewal-source");
  expect(await allPublicRows(admin)).toEqual(before);
  for (const table of [...tables, "commerce_destinations", "commerce_destination_bindings", "commerce_order_draft_receipts"]) {
    const index = packet.owned.findIndex(relation => relation.table === table), relation = packet.owned[index]!;
    expect(relation.rows.length).toBeGreaterThan(0);
    const prior = [...packet.compatible.tables, ...packet.owned.slice(0, index)];
    const rows = prior.reduce((n, row) => n + row.rows.length, 0) + relation.rows.length;
    const bytes = [...prior, relation].reduce((n, row) => n + row.rows.reduce((sum, value) => sum + Buffer.byteLength(value), 0), 0);
    await expect(captureStore(admin, "renewal-row-bound", { maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: "limit_exceeded", table });
    await expect(captureStore(admin, "renewal-byte-bound", { maximumRows: 10000, maximumBytes: bytes - 1 })).rejects.toMatchObject({ code: "limit_exceeded", table });
  }
  await withRestoredStore(packet, async target => {
    for (const table of tables) expect((await target.runtime.query(`SELECT count(*) AS n FROM public.${table}`)).rows)
      .toEqual((await runtime.query(`SELECT count(*) AS n FROM public.${table}`)).rows);
    expect((await target.runtime.query("SELECT token_hash FROM public.commerce_checkout_recovery_tokens WHERE id=$1", [token])).rows[0].token_hash).toBe(tokenHash);
    const recovered = retryDriver(d, "succeeded", liveNow, facts.methodRef, { executor: target.runtime, transaction: target.transaction });
    expect(await recovered.driver.run(liveNow, 50)).toContainEqual({ operationId: first.operationId, status: "succeeded" });
    expect(recovered.execute).not.toHaveBeenCalled();
    await api.createPostgresPurchaseRenewalWriter(target.runtime).complete(pendingPurchase.orderId);
    const codec = api.createNativeRenewalCodec(), store = api.createPostgresRenewalStore(target.runtime, codec, target.transaction);
    const due = (await store.listDue(500, now)).find(row => row.subscriptionId === duty.activation.subscriptionId)!;
    expect(due).toBeDefined();
    const lifecycle = api.createPostgresRetryLifecycleBinding({ executor: target.runtime, withTransaction: target.transaction,
      settlement: db => settlement(codec, db), correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
    const rail = api.createPostgresSandboxRenewalRail(target.runtime, { scenario: "succeeded", now: () => now }), execute = vi.spyOn(rail, "execute");
    const input = { ...d.input, store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
      inventory: inventory.createPostgresRenewalReservationPort(target.runtime), paymentRails: { resolve: () => rail } };
    expect(await api.runOneAutomaticSubscriptionRenewal(input, due, now)).toMatchObject({ status: "succeeded" });
    expect(execute).toHaveBeenCalledTimes(1);
    const paid = await allPublicRows(target.owner);
    expect(await api.runOneAutomaticSubscriptionRenewal(input, due, later)).toMatchObject({ status: "terminal_replay" });
    expect(execute).toHaveBeenCalledTimes(1); expect(await allPublicRows(target.owner)).toEqual(paid);
    const address = await destinations.createPostgresDestinationPort(target.runtime).read("subscription", due.subscriptionId);
    expect((await store.readRenewal(codec.identity(await store.buildCycleSnapshots(due))))!.cycleSnapshot.orderSnapshot.shippingAddressRef).toBe(address.destinationId);
  });
}, 65_000);

it("views the current and pinned shipment destination without writes or waiting for dispatch locks", async () => {
  const f = await active(), shipmentId = await parcel(f.orderId);
  const expected = await destinations.createPostgresDestinationPort(executor).read("order", f.orderId);
  for (const pinned of [false, true]) {
    if (pinned) await destinations.createPostgresDestinationPort(executor).read("shipment", shipmentId);
    const before = await allPublicRows(admin), holder = await admin.connect(), reader = await runtime.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`native-dispatch|${shipmentId}`]);
      await holder.query("SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE", [shipmentId]);
      await reader.query("BEGIN READ ONLY"); await reader.query("SET LOCAL statement_timeout='500ms'");
      const result = (await reader.query("SELECT public.commerce_view_shipment_destination($1::uuid) AS value", [shipmentId])).rows[0].value;
      expect(result).toEqual({ ...expected, pinned });
      await reader.query("COMMIT");
    } finally { await reader.query("ROLLBACK"); reader.release(); await holder.query("ROLLBACK"); holder.release(); }
    expect(await allPublicRows(admin)).toEqual(before);
  }
  await expect(rpc("commerce_view_shipment_destination", [null])).rejects.toMatchObject({ code: "22023", message: "commerce_destination_invalid_scope" });
  await expect(rpc("commerce_view_shipment_destination", [randomUUID()])).rejects.toMatchObject({ code: "22023", message: "commerce_destination_parent_missing" });
});

it("settles one destination-bound sub-millisecond cycle and replays without another charge or cycle", async () => {
  const paidAt = at.replace(/\.\d{3}Z$/, ".123456Z"), f = await purchase(true, true, paidAt);
  const activated = await api.activateNativePurchaseWithRenewal(executor, { ...f, facts });
  expect(activated.renewalAttachment).toBe("complete");
  const subscriptionId = String(activated.activation.subscriptionId), d = await deps(subscriptionId, "succeeded");
  expect(d.due.scheduledAt).toMatch(/\.123456Z$/);
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.scheduledAt).toBe(d.due.scheduledAt); expect(snapshot.scheduledInstant).toBe(Date.parse(snapshot.scheduledAt));
  const results = await Promise.all([api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now),
    api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)]);
  const result = results.find(row => row.status === "succeeded")!;
  expect(result).toBeDefined(); expect(results.every(row => ["succeeded", "lease_active", "terminal_replay"].includes(row.status))).toBe(true);
  expect(d.execute).toHaveBeenCalledTimes(1);
  const read = (await d.input.store.readRenewal(result.identityKey))!;
  expect(read.claimGeneration).toBe(1); expect(read.cycleSnapshot.scheduledAt).toBe(snapshot.scheduledAt);
  const destination = await destinations.createPostgresDestinationPort(executor).read("subscription", subscriptionId);
  expect(read.cycleSnapshot.orderSnapshot.shippingAddressRef).toBe(destination.destinationId);
  expect(read.cycleSnapshot.orderSnapshot.shippingQuoteRef).toEqual({ kind: "zero_shipping", shippingAmountMinor: 0 });
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_renewal_operations WHERE subscription_id=$1", [subscriptionId])).rows[0].n).toBe(1);
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_cycles WHERE subscription_id=$1", [subscriptionId])).rows[0].n).toBe(2);
  const before = await allPublicRows(admin);
  expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, later)).toMatchObject({ status: "terminal_replay", operationId: result.operationId });
  expect(d.execute).toHaveBeenCalledTimes(1); expect(await allPublicRows(admin)).toEqual(before);
});

it("refuses a non-zero renewal shipping amount through the restricted purchase writer", async () => {
  const f = await purchase(), before = await allPublicRows(admin);
  await expect(api.createPostgresPurchaseRenewalWriter(executor).register(f.orderId,
    { ...facts, shippingAmountMinor: 1 } as unknown as NativeRenewalPurchaseFacts)).rejects.toMatchObject({ code: "22023" });
  expect(await allPublicRows(admin)).toEqual(before);
});

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

// Two-session witness measured 1.2 s solo before repair; allow 30 s under load.
it("locks the subscription before prepare so a concurrent claim creates one artifact set", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  const claim = await d.input.store.claimDue({ snapshot, workerId: "lock-order", now });
  expect((await inventory.createPostgresRenewalReservationPort(executor).reserve({
    operationId: claim.operationId, claimToken: claim.claimToken, now,
  })).reserved).toBe(true);
  const operation = (await d.input.store.readRenewal(d.codec.identity(snapshot)))!;
  const before = await allPublicRows(admin), a = await runtime.connect(), b = await runtime.connect();
  const run = async (db: typeof a, sql: string, values: unknown[]) => {
    try {
      const result = (await db.query(sql, values)).rows[0].result;
      await db.query("COMMIT"); return { result, code: null };
    } catch (error) {
      await db.query("ROLLBACK"); return { result: null, code: (error as { code: string }).code };
    }
  };
  try {
    await a.query("BEGIN"); await b.query("BEGIN");
    await a.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscriptionId]);
    const aPid = Number((await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const bPid = Number((await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const preparation = run(b, "SELECT public.commerce_prepare_subscription_renewal($1::uuid,$2::uuid,$3::timestamptz) AS result",
      [claim.operationId, claim.claimToken, now]);
    let blockers: number[] = [];
    for (let n = 0; n < 500; n++) {
      blockers = (await a.query("SELECT pg_blocking_pids($1) AS pids", [bPid])).rows[0].pids;
      if (blockers.includes(aPid)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blockers).toContain(aPid);
    // B is blocked by A's subscription lock; B must not already own the operation.
    await a.query("SAVEPOINT operation_probe");
    let operationAvailable = true;
    try { await a.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE NOWAIT", [claim.operationId]); }
    catch (error) {
      expect(error).toMatchObject({ code: "55P03" }); operationAvailable = false;
      await a.query("ROLLBACK TO SAVEPOINT operation_probe");
    }
    const reclaim = run(a, "SELECT public.subscription_claim_due_renewal($1::text,$2::text,$3::jsonb,'lock-order',300,$4::timestamptz) AS result",
      [operation.identityKey, operation.operationFingerprint, JSON.stringify(d.codec.encode(operation.cycleSnapshot)), now]);
    const [prepared, replay] = await Promise.all([preparation, reclaim]);
    console.log(JSON.stringify({ witness: "renewal-lock-order", operationAvailable, codes: [prepared.code, replay.code] }));
    expect([prepared.code, replay.code]).toEqual([null, null]);
    expect(operationAvailable).toBe(true);
    expect(prepared.result).toMatchObject({ replayed: false, state: "attempt_prepared" });
    expect(replay.result).toMatchObject({ acquired: false, replayed: true });
    for (const table of ["subscription_cycles", "commerce_orders", "commerce_settlement_intents"]) {
      expect((await runtime.query(`SELECT count(*)::integer AS n FROM public.${table} WHERE renewal_operation_id=$1`, [claim.operationId])).rows[0].n).toBe(1);
    }
    const after = await allPublicRows(admin);
    for (const table of Object.keys(before).filter(table => /^(payment_|subscription_delivery_|subscription_method|subscriptions$)/.test(table))) {
      expect(after[table]).toEqual(before[table]);
    }
    expect(d.execute).not.toHaveBeenCalled();
    expect(await rpc("commerce_prepare_subscription_renewal", [claim.operationId, claim.claimToken, now])).toMatchObject({ replayed: true });
    expect(await allPublicRows(admin)).toEqual(after);
    await expect(rpc("commerce_prepare_subscription_renewal", [randomUUID(), claim.claimToken, now]))
      .rejects.toMatchObject({ code: "22023", message: "commerce_renewal_operation_not_found" });
    expect(await allPublicRows(admin)).toEqual(after);
  } finally {
    await a.query("ROLLBACK"); await b.query("ROLLBACK"); a.release(); b.release();
  }
}, 30_000);

// Real two-session admission refusals are subsecond; allow 30 s for installed-consumer work.
it.each(["generic", "native"] as const)("keeps %s reservation busy retryable without charge, dunning, terminal outcome or message", async path => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded"), a = await runtime.connect();
  let clock = now;
  const b = binding(d, () => clock);
  const effects = async () => {
    const rows = await allPublicRows(admin);
    // Claim is a durable retry obligation; every other public row must stay identical on busy.
    delete rows.subscription_renewal_operations;
    return rows;
  };
  let before = await effects();
  try {
    if (path === "generic") {
      await a.query("BEGIN"); await a.query("SELECT pg_advisory_xact_lock(846832106,1)");
      await expect(api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now))
        .rejects.toMatchObject({ code: "55P03", message: "inventory_admission_busy" });
      await a.query("ROLLBACK");
    } else {
      // Enter contention only at reservation, after the batch's expiry and claim steps.
      b.queries.mockImplementation(async (sql, values) => {
        if (!sql.includes("public.subscription_stock_wait_admit(")) return executor.query(sql, values);
        const atReservation = await effects();
        console.info("busy witness pre-reservation maintenance", Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(atReservation[key])));
        before = atReservation; // Batch discovery may close earlier, cancelled stock-wait cases.
        await a.query("BEGIN"); await a.query("SELECT pg_advisory_xact_lock(846832106,1)");
        try { return await executor.query(sql, values); }
        finally { await a.query("ROLLBACK"); }
      });
      expect(await b.services.run()).toMatchObject({ renewals: [{ status: "error", reason: "renewal_processing_failed" }] });
      b.queries.mockImplementation(executor.query);
    }
    expect(d.execute).not.toHaveBeenCalled();
    expect(await effects()).toEqual(before);
    const operation = (await runtime.query("SELECT id,state,terminal_outcome,terminal_reason,attempt_prepared_at FROM public.subscription_renewal_operations WHERE subscription_id=$1", [f.subscriptionId])).rows;
    expect(operation).toMatchObject([{ state: "claimed", terminal_outcome: null, terminal_reason: null, attempt_prepared_at: null }]);
    expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows).toEqual([{ status: "active" }]);
    clock = later; // Past the existing claim lease; the schedule remains due.
    const result = path === "generic" ? await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, later) : await b.services.run();
    expect(result).toMatchObject(path === "generic" ? { status: "succeeded", operationId: operation[0].id } : { renewals: [{ status: "succeeded", operationId: operation[0].id }] });
    expect(d.execute).toHaveBeenCalledTimes(1);
    expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_renewal_operations WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([{ n: 1 }]);
  } finally { await a.query("ROLLBACK"); a.release(); }
}, 30_000);


// The existing stock-wait flow is subsecond per mutation; allow 30 s for the installed consumer.
it("matches frozen stock-wait UUID bindings by value and keeps changed identities refused", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  await stock(0);
  expect(await binding(d, () => now).services.run()).toMatchObject({ renewals: [{ status: "refused", reason: "inventory_unavailable" }] });
  const waiting = (await runtime.query("SELECT id FROM public.subscription_stock_wait_cases WHERE subscription_id=$1", [f.subscriptionId])).rows[0];
  await stock(1000);
  expect(await binding(d, () => later).services.run()).toMatchObject({ renewals: [{ status: "succeeded" }] });
  const row = (await runtime.query(`SELECT c.id AS "caseId",cycle.id AS "cycleId",ord.id AS "orderId",intent.id AS "paymentId",op.identity_key AS "engineIdempotencyKey"
    FROM public.subscription_stock_wait_cases c JOIN public.subscription_renewal_operations op ON op.id=c.renewal_operation_id
    JOIN public.subscription_cycles cycle ON cycle.renewal_operation_id=op.id
    JOIN public.commerce_orders ord ON ord.renewal_operation_id=op.id
    JOIN public.commerce_settlement_intents intent ON intent.renewal_operation_id=op.id WHERE c.id=$1::uuid`, [waiting.id])).rows[0];
  const store = api.createPostgresStockWaitStore({ executor, codec: d.codec, withTransaction: transaction, workerId: "uuid-readback" });
  const original = await store.readFrozenCase(row);
  const before = await allPublicRows(admin);
  expect(original).toMatchObject({ caseId: waiting.id, binding: row });
  for (const key of ["cycleId", "orderId", "paymentId", "caseId"] as const) {
    expect(await store.readFrozenCase({ ...row, [key]: row[key].toUpperCase() })).toEqual(original);
  }
  for (const key of ["cycleId", "orderId", "paymentId"] as const) {
    await expect(store.readFrozenCase({ ...row, [key]: randomUUID() })).rejects.toThrow("stock_wait_frozen_binding_changed");
    await expect(store.readFrozenCase({ ...row, [key]: "invalid-uuid" })).rejects.toThrow("stock_wait_frozen_binding_changed");
  }
  await expect(store.readFrozenCase({ ...row, engineIdempotencyKey: row.engineIdempotencyKey + ":changed" })).rejects.toThrow("stock_wait_frozen_binding_changed");
  expect(await allPublicRows(admin)).toEqual(before);
  expect(d.execute).toHaveBeenCalledTimes(1);
}, 30_000);

// Admission mutations measured below one second; retain a 30 s installed-consumer bound.
it("canonicalizes frozen recovery UUIDs before the SQL binding comparison", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  await stock(0);
  expect(await binding(d, () => now).services.run()).toMatchObject({ renewals: [{ status: "refused", reason: "inventory_unavailable" }] });
  const store = api.createPostgresStockWaitStore({ executor, codec: d.codec, withTransaction: transaction, workerId: "uuid-recovery" });
  const frozen = (await store.readFrozen(d.due))!;
  const op = (await runtime.query("SELECT claim_token FROM public.subscription_renewal_operations WHERE id=$1", [frozen.operationId])).rows[0];
  const input = { operationId: frozen.operationId, claimToken: op.claim_token, snapshot: frozen.frozenSnapshot, now: later };
  const db = await runtime.connect();
  try {
    await db.query("BEGIN");
    const local = api.createPostgresStockWaitStore({ executor: db, codec: d.codec, withTransaction: transaction, workerId: "uuid-recovery" });
    const original = await local.admit({ ...input, recovery: frozen.binding });
    expect(original).toMatchObject({ waiting: true, caseId: frozen.binding.caseId });
    expect(await local.admit({ ...input, recovery: { ...frozen.binding, caseId: frozen.binding.caseId!.toUpperCase() } })).toEqual(original);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_stock_wait_cases WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([{ n: 1 }]);
  const before = await allPublicRows(admin);
  for (const caseId of [randomUUID(), "invalid-uuid"]) {
    await expect(store.admit({ ...input, recovery: { ...frozen.binding, caseId } }))
      .rejects.toMatchObject({ code: "23505", message: "stock_wait_frozen_binding_changed" });
  }
  await expect(store.admit({ ...input, recovery: { ...frozen.binding, engineIdempotencyKey: frozen.binding.engineIdempotencyKey + ":changed" } }))
    .rejects.toMatchObject({ code: "23505", message: "stock_wait_frozen_binding_changed" });
  expect(await allPublicRows(admin)).toEqual(before);
  expect(d.execute).not.toHaveBeenCalled();
}, 30_000);

// Prepared simulator recovery is subsecond per case; retain the measured 30 s consumer bound.
it.each(["sourceReference", "attemptRef", "externalAttemptRef", "all"] as const)("matches sandbox recovery UUID evidence by value (%s)", async field => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  const recovery = retryDriver(d, "succeeded", retryAt), original = recovery.options;
  let observed: Awaited<ReturnType<typeof original.payments.readOutcome>> | undefined;
  const prepare = api.createNativeRetryDriver({ ...original, payments: { ...original.payments,
    readOutcome: async (prepared, snapshot) => { observed = await original.payments.readOutcome(prepared, snapshot); return { ...observed, disposition: "ambiguous" }; } } });
  expect(await prepare.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  expect(await store.read(first.operationId)).toMatchObject({ state: "prepared" });
  const evidence = observed!, errors: { code?: string; message?: string }[] = [];
  const guarded = { query: async (sql: string, values?: unknown[]) => {
    try { return await executor.query(sql, values); } catch (error) { errors.push(error as { code?: string; message?: string }); throw error; }
  } };
  const before = await allPublicRows(admin);
  for (const key of ["sourceReference", "attemptRef"] as const) {
    const refused = api.createNativeRetryDriver({ ...original, executor: guarded,
      payments: { ...original.payments, readOutcome: async () => ({ ...evidence, sourceEvidence: { ...evidence.sourceEvidence!, [key]: randomUUID() } }) } });
    expect(await refused.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "error" }]);
    expect(errors.at(-1)).toMatchObject({ code: "22023", message: "wrong_attempt" });
    expect(await allPublicRows(admin)).toEqual(before);
  }
  const upper = { ...evidence, sourceEvidence: { ...evidence.sourceEvidence! } };
  if (field === "all" || field === "externalAttemptRef") upper.externalAttemptRef = evidence.externalAttemptRef!.toUpperCase();
  for (const key of ["sourceReference", "attemptRef"] as const) if (field === "all" || field === key) upper.sourceEvidence[key] = evidence.sourceEvidence![key].toUpperCase();
  const finish = api.createNativeRetryDriver({ ...original, payments: { ...original.payments, readOutcome: async () => upper } });
  expect(await finish.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(await store.read(first.operationId)).toMatchObject({ state: "recovered", externalAttemptSequence: 1 });
  expect((await runtime.query(`SELECT
    (SELECT count(*)::integer FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND outcome='captured') AS captures,
    (SELECT status FROM public.commerce_settlement_intents WHERE id=$1) AS status,
    (SELECT count(*)::integer FROM public.subscription_dunning_cases WHERE id=$2 AND status='open') AS unpaid`, [row.settlementIntentId, row.caseId])).rows[0])
    .toEqual({ captures: 1, status: "settled", unpaid: 0 });
  const receipt = (await runtime.query("SELECT input FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='recovery'", [first.operationId])).rows;
  expect(receipt).toHaveLength(1);
  expect(receipt[0].input).toMatchObject({ sourceReference: evidence.sourceEvidence!.sourceReference, attemptRef: evidence.sourceEvidence!.attemptRef, externalRef: evidence.externalAttemptRef });
  const after = await allPublicRows(admin);
  expect(await finish.run(retryAt, 50)).toEqual([]);
  expect(await allPublicRows(admin)).toEqual(after);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
}, 30_000);

// The two ACK/outcome mutations are subsecond; allow 30 s for the installed artifact.
it("matches UUID-shaped external settlement references and preserves opaque reference spelling", async () => {
  for (const ref of [randomUUID(), "Opaque-Attempt-Ref"]) {
    const f = await active(), d = await deps(f.subscriptionId, "succeeded");
    const snapshot = await d.input.store.buildCycleSnapshots(d.due);
    const claim = await d.input.store.claimDue({ snapshot, workerId: "uuid-ack", now });
    expect(await d.input.inventory.reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now })).toMatchObject({ reserved: true });
    const port = settlement(d.codec);
    await port.prepareRenewal({ operationId: claim.operationId, claimToken: claim.claimToken, now });
    await port.acknowledgeExternalAttempt({ operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, externalAttemptRef: ref, acknowledgedAt: now });
    const equivalent = ref === "Opaque-Attempt-Ref" ? ref : ref.toUpperCase();
    expect(await port.acknowledgeExternalAttempt({ operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, externalAttemptRef: equivalent, acknowledgedAt: now })).toMatchObject({ replayed: true, externalAttemptRef: ref });
    const acknowledged = await allPublicRows(admin);
    await expect(port.acknowledgeExternalAttempt({ operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, externalAttemptRef: randomUUID(), acknowledgedAt: now })).rejects.toMatchObject({ code: "23505" });
    expect(await allPublicRows(admin)).toEqual(acknowledged);
    const terminal = { operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, eventKey: `uuid-ref:${claim.operationId}`, outcome: "refused" as const, reason: "fixture", occurredAt: now };
    await port.recordTerminalOutcome({ ...terminal, externalRef: equivalent });
    const before = await allPublicRows(admin);
    expect(await port.recordTerminalOutcome({ ...terminal, externalRef: ref })).toMatchObject({ replayed: true });
    await expect(port.acknowledgeExternalAttempt({ operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, externalAttemptRef: randomUUID(), acknowledgedAt: now })).rejects.toThrow();
    if (ref === "Opaque-Attempt-Ref") await expect(port.recordTerminalOutcome({ ...terminal, externalRef: ref.toUpperCase() })).rejects.toMatchObject({ code: "23505" });
    expect(await allPublicRows(admin)).toEqual(before);
    expect(d.execute).not.toHaveBeenCalled();
  }
}, 30_000);

// This maps synthetic platform references to the simulator namespace; each DB mutation is subsecond.
it("matches UUID-shaped mandate references and dispatches canonical request UUIDs", async () => {
  const p = await purchase(), authorizationRef = randomUUID(), methodRef = randomUUID(), payerAccountRef = randomUUID();
  const activation = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts: { ...facts, authorizationRef, methodRef, payerAccountRef } });
  const subscriptionId = String(activation.activation.subscriptionId), d = await deps(subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal({ ...d.input, policy: api.createSandboxRenewalPolicy(methodRef) }, d.due, now);
  const store = api.createPostgresRetryStore(executor), row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  const recovery = retryDriver(d, "succeeded", retryAt, methodRef), original = recovery.options;
  const simulator = payments.createPostgresSandboxPaymentSimulator(executor, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  const execute = vi.fn(async (input: Parameters<typeof original.payments.execute>[0]) => {
    expect(input).toMatchObject({ paymentIntentId: row.settlementIntentId, orderRef: row.orderId, orderId: row.orderId,
      clientId: p.clientId, customerRef: payerAccountRef, paymentMethodRef: methodRef });
    const attempt = await simulator.beginAttempt({ settlementIntentId: input.paymentIntentId, idempotencyKey: input.executionIdempotencyKey,
      requestFingerprint: input.requestFingerprint, methodFacts: { authorizationRef: `sandbox:${authorizationRef}`,
        unattendedChargeAuthorizedAt: d.due.unattendedChargeAuthorizedAt, payerAccountRef: `sandbox:${input.customerRef}`,
        methodRef: `sandbox:${input.paymentMethodRef}`, methodEvidenceRef: facts.methodEvidenceRef }, at: retryAt });
    return { status: "pending" as const, externalAttemptRef: attempt.id };
  });
  const mandate = { authorized: true, authorizationRef: authorizationRef.toUpperCase(), paymentMethodRef: methodRef.toUpperCase() };
  const options = { ...original, readFrozenMandate: async () => ({ ...mandate, authorized: (await api.createPostgresPurchaseRenewalWriter(executor).readMethod(subscriptionId))?.healthState === "healthy" }),
    retryInput: (snapshot: Parameters<typeof original.retryInput>[0], obligation: Parameters<typeof original.retryInput>[1]) => {
      const supplied = original.retryInput(snapshot, obligation);
      return { ...supplied, paymentIntentId: supplied.paymentIntentId.toUpperCase(), orderRef: supplied.orderRef.toUpperCase(),
        orderId: supplied.orderId.toUpperCase(), clientId: supplied.clientId.toUpperCase(), customerRef: supplied.customerRef!.toUpperCase(), paymentMethodRef: supplied.paymentMethodRef.toUpperCase() };
    }, payments: { ...original.payments, execute } };
  const before = await allPublicRows(admin);
  for (const key of ["authorizationRef", "paymentMethodRef"] as const) {
    const refused = api.createNativeRetryDriver({ ...options, readFrozenMandate: async () => ({ ...mandate, [key]: randomUUID() }) });
    expect(await refused.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "frozen_mandate_mismatch" }]);
    expect(await allPublicRows(admin)).toEqual(before);
  }
  const driver = api.createNativeRetryDriver(options);
  const result = await driver.run(retryAt, 50);
  expect(result, JSON.stringify({ result, executed: execute.mock.calls.length })).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await store.read(first.operationId)).toMatchObject({ state: "recovered" });
  expect((await runtime.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [row.settlementIntentId])).rows).toEqual([{ status: "settled" }]);
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND outcome='captured'", [row.settlementIntentId])).rows).toEqual([{ n: 1 }]);
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_dunning_cases WHERE id=$1 AND status='open'", [row.caseId])).rows).toEqual([{ n: 0 }]);
  const after = await allPublicRows(admin); expect(await driver.run(retryAt, 50)).toEqual([]);
  expect(await allPublicRows(admin)).toEqual(after); expect(execute).toHaveBeenCalledTimes(1);
}, 30_000);

// Retry failure and receipt replay are subsecond, with the same 30 s installed-consumer allowance.
it("canonicalizes a failed retry's UUID-shaped external reference at the host boundary", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, recovery = retryDriver(d, "declined", row.nextRetryAt!), original = recovery.options;
  let externalRef = "";
  const driver = api.createNativeRetryDriver({ ...original, payments: { ...original.payments, readOutcome: async (prepared, snapshot) => {
    const evidence = await original.payments.readOutcome(prepared, snapshot); externalRef = evidence.externalAttemptRef!;
    return { ...evidence, externalAttemptRef: externalRef.toUpperCase() };
  } } });
  expect(await driver.run(row.nextRetryAt!, 50)).toEqual([{ operationId: first.operationId, status: "refused" }]);
  const receipt = (await runtime.query("SELECT receipt_key,input FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='failure' AND attempt_sequence=1", [first.operationId])).rows[0];
  expect(receipt.input.externalRef).toBe(externalRef);
  const before = await allPublicRows(admin);
  expect(await driver.propagateFailure(first.operationId.toUpperCase(), receipt.receipt_key, { ...receipt.input, externalRef: externalRef.toUpperCase() })).toMatchObject({ replayed: true, caseAdvanced: true });
  await expect(driver.propagateFailure(first.operationId, receipt.receipt_key, { ...receipt.input, externalRef: randomUUID() })).rejects.toMatchObject({ code: "23505" });
  expect(await allPublicRows(admin)).toEqual(before); expect(recovery.execute).toHaveBeenCalledTimes(1);
}, 30_000);

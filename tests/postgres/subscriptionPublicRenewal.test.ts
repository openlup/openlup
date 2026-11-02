import { captureConnectedNativeStore, connectedNativeStoreTables } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import { api, active, admin, at, composition, days, deps, executor, facts, fulfillment, later, now, retire, restartDatabase, freshRetryReadback, rpc, runtime, settlement, stock, transaction } from "./subscriptionPublicRenewalFixture.js";
import type { NativeRetryDriverOptions } from "@openlup/platform/subscriptions";
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
  const native = api.createNativeSubscriptionBinding({ enabled: true, population: `public-renewal:${d.due.subscriptionId}`, executor,
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
  return { ...native, ...composition.createSubscriptionContribution({ version: "fixture", requiredSchema: native.schema, run: native.services.run, cadenceSeconds: 60 }) };
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

function retryDriver(d: Awaited<ReturnType<typeof deps>>, observation: "ambiguous" | "declined" | "succeeded", observedAt: string, method = facts.methodRef) {
  const execute = vi.fn(async () => ({ status: "pending" as const, externalAttemptRef: "fixture-retry" }));
  // Trusted payment-owner evidence fixture until the joined simulator proof.
  // It is reconstructed against the exact durable prepared receipt after restart;
  // no retry attempt table or aggregate-handle lookup is introduced here.
  const options: NativeRetryDriverOptions = { executor, withTransaction: transaction, decode: d.codec.decode,
    readFrozenMandate: async snapshot => ({ authorized: (await api.createPostgresPurchaseRenewalWriter(executor).readMethod(snapshot.subscriptionId))?.healthState === "healthy",
      authorizationRef: snapshot.authorizationRef, paymentMethodRef: facts.methodRef }),
    retryInput: (snapshot, row) => ({ ...api.createSandboxRenewalPolicy(method).executionInput(d.due,
      { cycleSnapshot: snapshot, identityKey: row.identityKey, operationFingerprint: row.requestFingerprint } as RenewalReadback,
      { settlementIntentId: row.settlementIntentId, orderId: row.orderId }),
      executionIdempotencyKey: `${row.identityKey}:retry:${row.retryAttempt}`, externalIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}` }),
    validateInput: d.input.policy.validateInput, classifyFailure: () => "temporary", failureTemplate: "failed", recoveredTemplate: "recovered", recoveryPath: "/recover",
    payments: { execute, readOutcome: async (prepared, snapshot) => ({
      status: observation === "succeeded" ? "succeeded" : observation === "declined" ? "failed" : "unknown",
      disposition: observation === "ambiguous" ? "ambiguous" : "observed", operationId: d.codec.identity(snapshot) === prepared.identityKey ?
        (await d.input.store.readRenewal(prepared.identityKey))!.operationId : "wrong-operation",
      eventKey: `fixture-observation:${prepared.obligationId}:${prepared.attemptSequence}`,
      requestFingerprint: prepared.operationFingerprint, verifiedEvidenceRef: observation === "ambiguous" ? "" : `fixture-evidence:${prepared.obligationId}:${prepared.attemptSequence}`,
      externalAttemptRef: `fixture-attempt:${prepared.obligationId}:${prepared.attemptSequence}`, occurredAt: observation === "ambiguous" ? null : observedAt,
      observedAt, firstRecordedAt: observedAt, amountMinor: snapshot.pricingSnapshot.totalAmountMinor, currency: snapshot.pricingSnapshot.currency,
      reason: observation === "declined" ? "fixture_declined" : null,
    }) },
  };
  return { driver: api.createNativeRetryDriver(options), execute, options };
}

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
  // Labelled observation fixture until the payment-owner simulator joins this stack.
  const sourceEvidence = { sourceKind: "accepted_event" as const, sourceReference: randomUUID(),
    attemptRef: randomUUID(), observedStatus: "captured", observedAt: recoveredAt, payloadFingerprint: "a".repeat(64) };
  const read = recovery.options.payments.readOutcome;
  recovery.options.payments.readOutcome = async (...input) => ({ ...await read(...input),
    verifiedEvidenceRef: `sandbox:${sourceEvidence.sourceReference}`, sourceEvidence });
  expect(await recovery.driver.run(recoveredAt, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  const receipt = (await runtime.query(`SELECT receipt_key,input FROM public.subscription_retry_receipts
    WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='recovery'`, [first.operationId])).rows[0];
  expect(receipt.input).toMatchObject({ ...sourceEvidence, evidenceKey: `sandbox:${sourceEvidence.sourceReference}` });
  const before = await allPublicRows(admin);
  await store.recordRecovery(first.operationId, receipt.receipt_key, receipt.input);
  await expect(store.recordRecovery(first.operationId, receipt.receipt_key, { ...receipt.input, attemptRef: randomUUID() })).rejects.toMatchObject({ code: "23505" });
  expect(await allPublicRows(admin)).toEqual(before);
});

it("populates the retry, token, authorization and stock-wait transfer set using writers and refuses missing stock transfer entries", async () => {
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
  expect(outside).toEqual(["fulfillment_inventory_reservation_lines", "fulfillment_inventory_reservations", "fulfillment_stock_current"]);
  const before = await allPublicRows(admin);
  // The earlier stock row's three profile entries are deliberately absent here.
  // At the instructed main merge this becomes full clean-target restore and
  // continuation proof; do not delete/filter writer-created reservation facts.
  await expect(captureConnectedNativeStore({ sourceId: "public-renewal-source", catalogueId: "same-qualified-catalogue",
    maximumRows: 10000, maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
      const db = await admin.connect();
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try { const result = await work({ query: (sql, values) => db.query(sql, values ? [...values] : undefined) });
        await db.query("COMMIT"); return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    } } }).catch(error => {
      console.info("renewal-transfer-refusal", JSON.stringify({ code: error.code, table: error.table }));
      throw error;
    })).rejects.toMatchObject({ code: "unsupported_table", table: expect.stringMatching(/^public\.fulfillment_(inventory_reservation|stock_current)/) });
  expect(await allPublicRows(admin)).toEqual(before);
});

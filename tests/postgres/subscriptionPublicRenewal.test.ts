import { createPostgresCommerceOmsPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresRenewalSettlementPort as mainSettlement } from "../../server/adapters/postgres/commerce/renewalSettlement.js";
import { createPostgresAutomaticRenewalPort, automaticRenewalIdentity, automaticRenewalFingerprint } from "../../server/adapters/postgres/subscription/automaticRenewal.js";
import { connectedNativeStoreTables, readPrivacyDeclarationCensus, requiredPrivacyDeclarationTable } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseError, Pool } from "pg";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { beforeEach, expect, it, vi } from "vitest";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import { api, active, purchase, admin, at, composition, payments, destinations, inventory, captureStore, withRestoredStore, days, deps, executor, facts, fulfillment, later, now, retire, requireIsolatedRenewalContainer, restartDatabase, freshRetryReadback, normalRenewalWorkerPopulation, rpc, runtime, settlement, stock, transaction, withNormalRenewalWorker, loginConnection, runtimeLogin, runtimeUrl, withOccupiedRenewalPrefix, expectFrozenGenerationShape, frozenGenerationSignature, frozenGenerationSql, generationForward } from "./subscriptionPublicRenewalFixture.js";
requireIsolatedRenewalContainer();
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

function binding(d: Awaited<ReturnType<typeof deps>>, clock: () => string, transact = transaction, dbPool = runtime,
  retry?: ReturnType<typeof retryDriver>["options"]) {
  const unused = async (): Promise<never> => { throw new Error("unexpected_retry_on_stock_fixture"); };
  const queries = vi.fn<typeof executor.query>((sql, values) => dbPool.query(sql, values));
  const prepare = vi.fn(async (db: Parameters<typeof settlement>[1], request: Parameters<ReturnType<typeof settlement>["prepareRenewal"]>[0]) =>
    api.createPostgresRenewalSettlementPort(db ?? dbPool, d.codec, transact).prepareRenewal(request));
  const native = api.createNativeSubscriptionBinding({ enabled: true, batchLimit: 7, population: `public-renewal:${d.due.subscriptionId}`, executor: { query: queries },
    withTransaction: transact, withRunLease: async (_population, work) => {
      const db = await dbPool.connect();
      try {
        if (!(await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", ["g7-population"])).rows[0].acquired) return null;
        try { return await work(); } finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["g7-population"]); }
      } finally { db.release(); }
    }, codec: d.codec, settlement: db => ({ ...settlement(d.codec, db), prepareRenewal: request => prepare(db, request) }), inventory: d.input.inventory,
    paymentRails: d.input.paymentRails, policy: d.input.policy,
    retry: retry ?? { readFrozenMandate: unused, retryInput: () => { throw new Error("unexpected_retry"); }, payments: { execute: unused, readOutcome: unused }, recoveredTemplate: "recovered" },
    failureTemplate: "failed", recoveryPath: "/recover", workerId: "public-binding", now: clock,
    catalogue: { version: "complete-test-catalogue", migration: "native-test-catalogue" },
    readiness: async () => ({ state: "ready", candidate: { artifact: "fixture", configuration: "fixture", environment: "disposable", database: "fixture", schema: "complete" }, loadedPackages: [], issues: [] }),
  });
  return { ...native, queries, prepare, ...composition.createSubscriptionContribution({ version: "fixture", requiredSchema: native.schema, run: native.services.run, cadenceSeconds: 60 }) };
}

async function resizeForRenewal(f: Awaited<ReturnType<typeof active>>, transact = transaction,
  variantId = "22222222-2222-4222-8222-222222222222") {
  const store = api.createPostgresSubscriptionCommandStore({ withTransaction: transact });
  const request = { actorId: randomUUID(), clientId: f.clientId, subscriptionId: f.subscriptionId,
    idempotencyKey: randomUUID(), action: "resize_bundle" as const, now: days(at, 1),
    payload: { expectedTemplateVersion: 1, cadenceDays: 28,
      coreLines: [{ variantId, qty: 3 }],
      compositionConstraint: { kind: "units" as const, value: 3 } } };
  const preview = await store.preview(request);
  expect(preview.status).toBe("previewed");
  if (preview.status !== "previewed") throw new Error("expected_resize_preview");
  expect(await store.apply({ ...request, payload: { ...request.payload, acceptedQuoteHash: preview.quoteHash } }))
    .toMatchObject({ status: "applied", templateVersion: 2 });
}

const staleClaim = {
  code: "22023", message: "subscription_renewal_snapshot_stale", detail: "/cycleSnapshot",
  hint: "Re-read the due subscription and rebuild its cycle snapshot before claiming again.",
};
const webhookProvider = "fixture-gateway";

function signal() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it("rebuilds one stale mounted renewal at the accepted amount on the next tick", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const held = await d.input.store.buildCycleSnapshots(d.due);
  expect(held.templateSnapshot).toMatchObject({ version: 1, lines: [{ quantity: 2, unitAmountMinor: 100 }] });
  expect(held.pricingSnapshot.totalAmountMinor).toBe(200);
  await resizeForRenewal(f);
  expect((await runtime.query(`SELECT s.template_version,s.cadence_days,s.next_cycle_at=$2::timestamptz AS same,t.catalog_acceptance
    FROM public.subscriptions s JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1`,
  [f.subscriptionId, d.due.scheduledAt])).rows).toEqual([{ template_version: 2, cadence_days: 28, same: true, catalog_acceptance: null }]);
  const before = await allPublicRows(admin), errors: unknown[] = [];
  const build = vi.spyOn(d.codec, "freeze").mockReturnValueOnce(held);
  let clock = now;
  const b = binding(d, () => clock, async work => {
    try { return await transaction(work); }
    catch (error) { errors.push(error); throw error; }
  });
  const [job] = b.contributions[0].schedules!;
  expect(job.id).toBe("subscriptions-renewal");
  const charged = () => d.execute.mock.calls.map(([input]) => input.amountMinor);
  const first = await job.run();
  expect(charged(), JSON.stringify(first)).toEqual([]);
  expect(first).toMatchObject({ renewals: [{ subscriptionId: f.subscriptionId, status: "error", reason: "renewal_processing_failed" }] });
  expect(errors).toMatchObject([staleClaim]);
  expect(await allPublicRows(admin)).toEqual(before);
  clock = new Date(Date.parse(now) + 60_000).toISOString();
  const second = await job.run() as Awaited<ReturnType<typeof b.services.run>>;
  expect(second).toMatchObject({ renewals: [{ status: "succeeded", identityKey: d.codec.identity(held) }] });
  const operation = (await d.input.store.readRenewal(d.codec.identity(held)))!;
  expect(operation.cycleSnapshot).toMatchObject({ scheduledAt: held.scheduledAt, cycle: held.cycle,
    templateSnapshot: { version: 2, lines: [{ quantity: 3, unitAmountMinor: 100 }] },
    pricingSnapshot: { totalAmountMinor: 300 } });
  expect(operation.operationFingerprint).not.toBe(d.codec.fingerprint(held));
  expect((await runtime.query(`SELECT o.total_amount_minor::int AS ordered,i.amount_minor::int AS payable
    FROM public.commerce_orders o JOIN public.commerce_settlement_intents i ON i.order_id=o.id WHERE o.id=$1`, [operation.orderId])).rows)
    .toEqual([{ ordered: 300, payable: 300 }]);
  expect(await job.run()).toMatchObject({ renewals: [] });
  expect(charged()).toEqual([300]);
  expect(build).toHaveBeenCalledTimes(2);
}, 30_000);

async function renewalPurchase(retained = false, target = { db: runtime, connectionString: runtimeUrl }, paidAt = at,
  providerBacked = false) {
  const f = await purchase(true, true, paidAt, target);
  let renewalFacts = facts;
  if (providerBacked) {
    const methodRef = `pm_${f.clientId}`, payerAccountRef = `cus_${f.clientId}`;
    const method = await payments.createPostgresPaymentMethodStore(target.db).upsert({ key: `method:${f.clientId}`,
      clientId: f.clientId, subscriptionId: null, provider: webhookProvider, methodKind: "card", customer: payerAccountRef,
      reference: methodRef, mandate: null, status: "active", active: true, expiresAt: null, consent: {}, payload: {} });
    renewalFacts = { ...facts, settlementChannelKey: webhookProvider, payerAccountRef, methodRef, methodEvidenceRef: method.id };
  }
  const activation = await api.activateNativePurchaseWithRenewal(target.db, { ...f, facts: {
    ...renewalFacts, ...(retained ? { renewalTerms: { version: "native.renewal-terms.v1" as const, minimumPayableMinor: 1 } } : {}),
  } });
  expect(activation.renewalAttachment).toBe("complete");
  return { ...f, subscriptionId: String(activation.activation.subscriptionId), methodRef: renewalFacts.methodRef };
}

async function bindRenewalDestination(d: Awaited<ReturnType<typeof deps>>,
  snapshot: Awaited<ReturnType<typeof d.input.store.buildCycleSnapshots>>, db = runtime) {
  const destination = await rpc<{ destinationId: string }>("commerce_read_destination", ["subscription", d.due.subscriptionId], db);
  return d.codec.withDestination!(snapshot, destination.destinationId);
}

function claimWire(d: Awaited<ReturnType<typeof deps>>, snapshot: Awaited<ReturnType<typeof d.input.store.buildCycleSnapshots>>, wire = d.codec.encode(snapshot), when = now) {
  return [d.codec.identity(snapshot), d.codec.fingerprint(snapshot), JSON.stringify(wire), when];
}

it.each([false, true])("checks current native renewal wires in SQL and the store (retained=%s)", async retained => {
  const f = await renewalPurchase(retained), d = await deps(f.subscriptionId, "succeeded");
  const held = await d.input.store.buildCycleSnapshots(d.due);
  expect(held.frozenRevision).toBe(retained ? "native.purchase-renewal.v2" : "native.purchase-renewal.v1");
  const stale = await bindRenewalDestination(d, held);
  await resizeForRenewal(f);
  const before = await allPublicRows(admin);
  await expect(runtime.query(rawClaim, claimWire(d, stale))).rejects.toMatchObject(staleClaim);
  await expect(d.input.store.claimDue({ snapshot: held, workerId: "transactional", now })).rejects.toMatchObject(staleClaim);
  const direct = api.createPostgresRenewalStore(executor, d.codec);
  await expect(direct.claimDue({ snapshot: stale, workerId: "direct", now })).rejects.toMatchObject(staleClaim);
  expect(await allPublicRows(admin)).toEqual(before);

  const fresh = await d.input.store.buildCycleSnapshots(d.due);
  expect(fresh.templateSnapshot).toMatchObject({ version: 2, lines: [{ quantity: 3, unitAmountMinor: 100 }] });
  expect(fresh.pricingSnapshot.totalAmountMinor).toBe(300);
  const bound = await bindRenewalDestination(d, fresh);
  const wire = d.codec.encode(bound);
  for (const bad of [
    { ...wire, templateSnapshot: undefined },
    { ...wire, templateSnapshot: { ...fresh.templateSnapshot, version: "2" } },
    { ...wire, frozenRevision: undefined, templateSnapshot: { version: null } },
  ]) {
    await expect(runtime.query(rawClaim, claimWire(d, bound, bad))).rejects.toMatchObject({
      code: "22023", message: "subscription_renewal_claim_invalid_snapshot",
    });
  }
  if (retained) {
    const different = { ...fresh, payerAccountRef: "sandbox:other-payer" };
    different.frozenFingerprint = d.codec.fingerprint(different);
    await expect(d.input.store.claimDue({ snapshot: different, workerId: "fingerprint", now })).rejects.toMatchObject({
      ...staleClaim, message: "subscription_renewal_snapshot_fingerprint_mismatch",
    });
    expect(await allPublicRows(admin)).toEqual(before);
  }
  const future = { ...wire, frozenRevision: "native.purchase-renewal.test-revision" };
  const laterWire = await runtime.connect();
  try {
    await laterWire.query("BEGIN");
    expect(JSON.parse((await laterWire.query(rawClaim, claimWire(d, bound, future))).rows[0].result)).toMatchObject({ acquired: true });
  } finally {
    await laterWire.query("ROLLBACK");
    laterWire.release();
  }
  expect(await d.input.store.claimDue({ snapshot: fresh, workerId: "fresh", now })).toMatchObject({ acquired: true });
}, 30_000);

it("requires positive build evidence on legacy PostgreSQL billing claims and preserves exact replay", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const legacy = createPostgresAutomaticRenewalPort(executor);
  const held = await legacy.buildCycleSnapshots(d.due);
  expect(held.totalAmountMinor).toBe(200);
  const identity = automaticRenewalIdentity(f.subscriptionId, held.scheduledAt);
  const heldFingerprint = automaticRenewalFingerprint(held);

  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    const transactional = createPostgresAutomaticRenewalPort({ query: (sql, values) => client.query(sql, values) });
    const sameVersion = await transactional.buildCycleSnapshots(d.due);
    await admin.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=999 WHERE subscription_id=$1", [f.subscriptionId]);
    expect(await transactional.claimDue({ snapshot: sameVersion, workerId: "same-version", now }))
      .toMatchObject({ acquired: true, cycleSnapshot: { totalAmountMinor: 200 } });
    await client.query("ROLLBACK");
    await admin.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=100 WHERE subscription_id=$1", [f.subscriptionId]);

    await resizeForRenewal(f);
    const before = await allPublicRows(admin);
    await expect(legacy.claimDue({ snapshot: held, workerId: "unversioned", now })).rejects.toMatchObject(staleClaim);
    expect(await allPublicRows(admin)).toEqual(before);

    await client.query("BEGIN");
    const bare = JSON.parse((await client.query(rawClaim, [identity, heldFingerprint, held, now])).rows[0].result);
    expect(bare).toMatchObject({ acquired: true, operationFingerprint: heldFingerprint, cycleSnapshot: held });
    await client.query("ROLLBACK");
    expect(await allPublicRows(admin)).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  const fresh = await legacy.buildCycleSnapshots(d.due);
  expect(fresh.totalAmountMinor).toBe(300);
  const claim = await legacy.claimDue({ snapshot: fresh, workerId: "unversioned", now });
  expect(claim).toMatchObject({ acquired: true, cycleSnapshot: fresh, operationFingerprint: automaticRenewalFingerprint(fresh) });
  expect((await runtime.query("SELECT cycle_snapshot,operation_fingerprint FROM public.subscription_renewal_operations WHERE id=$1",
    [claim.operationId])).rows).toEqual([{ cycle_snapshot: fresh, operation_fingerprint: automaticRenewalFingerprint(fresh) }]);
  expect(JSON.parse((await runtime.query(rawClaim, [identity, claim.operationFingerprint, fresh, now])).rows[0].result))
    .toMatchObject({ replayed: true, operationId: claim.operationId, cycleSnapshot: fresh });
  expect(await legacy.claimDue({ snapshot: fresh, workerId: "unversioned", now }))
    .toMatchObject({ replayed: true, operationId: claim.operationId, cycleSnapshot: fresh });
}, 30_000);

it("prepares a post-forward claim at its frozen amount after an accepted edit", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  const claim = await d.input.store.claimDue({ snapshot, workerId: "first", leaseSeconds: 30, now });
  expect(claim.acquired).toBe(true);
  await resizeForRenewal(f);
  expect((await runtime.query("SELECT claimed_before_rnw_1 FROM public.subscription_renewal_operations WHERE id=$1",
    [claim.operationId])).rows).toEqual([{ claimed_before_rnw_1: false }]);
  expect((await renewalUpgradeReport(runtime)).some(row => row.operation_id === claim.operationId)).toBe(false);

  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, days(now, 1 / 1440));
  expect(result).toMatchObject({ status: "succeeded", operationId: claim.operationId });
  expect(d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([200]);

  const next = (await d.input.store.listDue(100, days(now, 30))).find(row => row.subscriptionId === f.subscriptionId)!;
  expect(next).toBeDefined();
  expect(await d.input.store.buildCycleSnapshots(next)).toMatchObject({
    templateSnapshot: { version: 2 }, pricingSnapshot: { totalAmountMinor: 300 },
  });
}, 30_000);

it("checks template freshness after a concurrent accepted edit releases the subscription lock", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const stale = await bindRenewalDestination(d, await d.input.store.buildCycleSnapshots(d.due));
  const a = await runtime.connect(), b = await runtime.connect();
  const entered = signal(), release = signal();
  let transactions = 0;
  const edit = resizeForRenewal(f, async work => {
    if (++transactions === 1) return transaction(work);
    await a.query("BEGIN");
    try {
      const result = await work(a);
      entered.resolve();
      await release.promise;
      await a.query("COMMIT");
      return result;
    } catch (error) { entered.reject(error); await a.query("ROLLBACK"); throw error; }
  });
  edit.catch(entered.reject);
  try {
    await entered.promise;
    const pids = await Promise.all([a.query("SELECT pg_backend_pid() AS pid"), b.query("SELECT pg_backend_pid() AS pid")]);
    const [editor, claimer] = pids.map(result => result.rows[0].pid);
    await b.query("SET statement_timeout='10s'");
    const claiming = b.query(rawClaim, claimWire(d, stale)).catch(error => error);
    await expect.poll(async () => (await a.query("SELECT pg_blocking_pids($1) AS pids", [claimer])).rows[0].pids).toContain(editor);
    release.resolve();
    await edit;
    expect(await claiming).toMatchObject(staleClaim);
    expect((await runtime.query("SELECT id FROM public.subscription_renewal_operations WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([]);
  } finally {
    release.resolve();
    await edit.catch(() => {});
    a.release();
    b.release(true);
  }
}, 30_000);

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

it.each(["SIGKILL", "disconnect"] as const)("resumes an acknowledged normal renewal without redispatch after %s", async stopAfterDispatch => {
  const { subscriptionId } = await active();
  const operations = () => admin.query(`SELECT id, identity_key, state, operation_fingerprint, external_attempt_ref, scheduled_at,
    claimed_by, claim_generation, lease_expires_at FROM public.subscription_renewal_operations WHERE subscription_id=$1`, [subscriptionId]);
  const afterLease = (at: Date) => new Date(at.getTime() + 1).toISOString();
  const first = await withNormalRenewalWorker({ when: now, workerId: "before-crash", stopAfterDispatch }, async (message, pid) => {
    const { rows } = await operations();
    expect(rows).toEqual([expect.objectContaining({ state: "attempt_prepared", claimed_by: "before-crash", claim_generation: "1",
      external_attempt_ref: expect.stringContaining("sandbox-renewal:") })]);
    expect(message).toMatchObject({ stage: "acknowledged", executions: 1, reads: 0, externalAttemptRef: rows[0].external_attempt_ref });
    await withNormalRenewalWorker({ when: now, workerId: "contender" }, async (contending, otherPid) => {
      expect(otherPid).not.toBe(pid);
      expect(contending).toEqual({ stage: "complete", result: null, executions: 0, reads: 0 });
    });
    return { operation: rows[0], pid };
  });
  const { operation } = first;
  // The child exit and the database's release of its advisory lock are asynchronous.
  await transaction(async db => {
    await db.query("SET LOCAL statement_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [normalRenewalWorkerPopulation]);
  });

  const reclaimed = await withNormalRenewalWorker({ when: afterLease(operation.lease_expires_at), workerId: "after-crash" }, async (message, pid) => {
    expect(pid).not.toBe(first.pid);
    expect(message).toMatchObject({ stage: "complete", result: { retries: [], renewals: [{ operationId: operation.id, status: "awaiting_provider" }] }, executions: 0, reads: 1 });
    const { rows } = await operations();
    expect(rows).toEqual([expect.objectContaining({ ...operation, claimed_by: "after-crash", claim_generation: "2", lease_expires_at: expect.any(Date) })]);
    return rows[0];
  });

  const when = afterLease(reclaimed.lease_expires_at);
  await api.createPostgresSandboxRenewalRail(executor, { scenario: "ambiguous" }).observe({ operationId: operation.id,
    fingerprint: operation.operation_fingerprint, externalAttemptRef: operation.external_attempt_ref, outcome: "succeeded", occurredAt: when });
  const completed = await withNormalRenewalWorker({ when, workerId: "after-observation" }, async message => {
    expect(message).toMatchObject({ stage: "complete", result: { retries: [], renewals: [{ operationId: operation.id, status: "succeeded" }] }, executions: 0, reads: 1 });
    const { rows } = await operations();
    return rows;
  });
  expect(completed).toEqual([expect.objectContaining({ ...operation, state: "succeeded",
    claimed_by: "after-observation", claim_generation: "3", lease_expires_at: expect.any(Date) })]);
  expect((await admin.query(`SELECT event_key, outcome FROM public.subscription_renewal_outcomes
    WHERE renewal_operation_id=$1 ORDER BY event_key`, [operation.id])).rows).toEqual([
    { event_key: `sandbox-observation:${operation.id}`, outcome: "succeeded" },
    { event_key: `${operation.identity_key}:provider-success:${operation.external_attempt_ref}`, outcome: "succeeded" },
  ]);
  expect((await admin.query(`SELECT count(*)::int AS paid FROM public.subscription_cycles WHERE subscription_id=$1 AND status='paid'`, [subscriptionId])).rows)
    .toEqual([{ paid: 2 }]);
  expect((await admin.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows)
    .toEqual([{ next_cycle_at: new Date(days(operation.scheduled_at.toISOString(), facts.cadenceDays)) }]);
}, 45_000);

async function parcel(orderId: string) {
  // Parcel facts use the bounded writer and the installation's synthetic port.
  const spine = fulfillment.createPostgresFulfillmentShipmentSpinePort(executor, { portKey: "g7-parcels" });
  return (await spine.createShipment({ idempotencyKey: `parcel:${orderId}`, orderId, requestedAt: at })).shipmentId;
}

it.each([false, true])("aligns late arrival with an empty ledger after a mounted stale refusal (retained=%s)", async retained => {
  const f = await renewalPurchase(retained), d = await deps(f.subscriptionId, "succeeded");
  const held = await d.input.store.buildCycleSnapshots(d.due);
  const stale = await bindRenewalDestination(d, held);
  const shipmentId = await parcel(f.orderId);
  await resizeForRenewal(f);
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
  let clock = now;
  const b = binding(d, () => clock);
  const [job] = b.contributions[0].schedules!;
  const noOldOccurrence = async () => {
    expect((await runtime.query("SELECT id FROM public.subscription_renewal_operations WHERE subscription_id=$1 AND scheduled_at=$2",
      [f.subscriptionId, held.scheduledAt])).rows).toEqual([]);
    expect((await runtime.query("SELECT id FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2",
      [f.subscriptionId, held.scheduledAt])).rows).toEqual([]);
  };
  expect((await runtime.query("SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([]);
  vi.spyOn(d.codec, "freeze").mockReturnValueOnce(held);
  expect(await job.run()).toMatchObject({ renewals: [{ status: "error", reason: "renewal_processing_failed" }] });
  expect((await runtime.query("SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([]);
  await noOldOccurrence();
  expect(d.execute).not.toHaveBeenCalled();

  const deliveredAt = days(d.due.scheduledAt, 7), shifted = days(deliveredAt, 28);
  const arrival = fulfillment.createPostgresDeliveryAlignmentPort(executor);
  const input = { requestKey: `late:${shipmentId}`, parcelRef: shipmentId, deliveredAt, evidenceRef: `evidence:${shipmentId}` as const };
  expect(await arrival.recordArrival(input)).toMatchObject({ disposition: "aligned", nextCycleAt: shifted });
  expect(await arrival.recordArrival(input)).toMatchObject({ replayed: true, nextCycleAt: shifted });
  expect(await arrival.recordArrival({ ...input, requestKey: `older:${shipmentId}`, deliveredAt: days(deliveredAt, -1) }))
    .toMatchObject({ nextCycleAt: shifted });
  expect((await runtime.query(`SELECT state,evidence_kind,observed_next_cycle_at,aligned_next_cycle_at
    FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1`, [f.subscriptionId])).rows)
    .toEqual([{ state: "aligned", evidence_kind: "overdue_renewal", observed_next_cycle_at: new Date(held.scheduledAt),
      aligned_next_cycle_at: new Date(shifted) }]);

  clock = days(shifted, -1);
  expect(await job.run()).toMatchObject({ renewals: [] });
  expect(d.execute).not.toHaveBeenCalled();
  clock = shifted;
  const noDue = { code: "22023", message: "subscription_renewal_claim_not_due" };
  await expect(runtime.query(rawClaim, claimWire(d, stale, undefined, clock))).rejects.toMatchObject(noDue);
  await expect(d.input.store.claimDue({ snapshot: held, workerId: "old-offer", now: clock }))
    .rejects.toThrow(retained ? /^subscription_renewal_snapshot_not_found$/ : /^subscription_renewal_claim_not_due$/);
  const shiftedSnapshot = await d.input.store.buildCycleSnapshots({ ...d.due, scheduledAt: shifted, scheduledInstant: Date.parse(shifted) });
  expect(shiftedSnapshot.cycle).toEqual(held.cycle);
  const newIdentity = d.codec.identity(shiftedSnapshot);
  expect(newIdentity).not.toBe(d.codec.identity(held));
  expect(await job.run()).toMatchObject({ renewals: [{ status: "succeeded", identityKey: newIdentity }] });
  const shiftedOperation = (await d.input.store.readRenewal(newIdentity))!;
  expect(await renewalAmounts(runtime, shiftedOperation.orderId!)).toEqual([{ order: 300, intent: 300 }]);
  await noOldOccurrence();
  expect(await job.run()).toMatchObject({ renewals: [] });
  expect(d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([300]);
}, 30_000);

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

it.each(["canonical", "uppercase", "compact", "braced", "grouped"] as const)("matches prepare UUIDs by value for retry and recovery (%s)", async spelling => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  if (spelling === "uppercase") {
    const snapshot = await d.input.store.buildCycleSnapshots(d.due);
    expect(d.codec.withDestination!(snapshot, snapshot.orderSnapshot.shippingAddressRef!.toUpperCase())).toMatchObject({ orderSnapshot: { shippingAddressRef: snapshot.orderSnapshot.shippingAddressRef!.toUpperCase() }, pricingSnapshot: snapshot.pricingSnapshot });
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
}, 15_000);


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

it("does not report retry-driver success when capture is retained for review after OMS cancellation", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const row = (await api.createPostgresRetryStore(executor).read(first.operationId))!;
  const operator = randomUUID();
  await admin.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Synthetic operator')", [operator]);
  const recovery = retryDriver(d, "succeeded", row.nextRetryAt!), read = recovery.options.payments.readOutcome;
  let counter: number | undefined;
  recovery.options.payments.readOutcome = async (...input) => {
    const attempt = await payments.createPostgresSandboxPaymentSimulator(executor, {
      dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered"
    }).readAttempt({ settlementIntentId: row.settlementIntentId! });
    // Accept cancellation on terminal unpaid work before the provider's late capture.
    await rpc("payment_simulator_record_observation", [attempt!.id, `expired:${attempt!.id}`, "e".repeat(64), "expired", row.nextRetryAt!]);
    await createPostgresCommerceOmsPort(executor).cancelOrder({ idempotencyKey: `cancel:${row.orderId}`, orderId: row.orderId, reason: "synthetic cancellation", actorUserId: operator });
    counter = Number((await runtime.query("SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscriptionId])).rows[0].next_cycle_number);
    return read(...input);
  };
  expect(await recovery.driver.run(row.nextRetryAt!, 50)).toEqual([{ operationId: first.operationId, status: "error" }]);
  expect((await runtime.query("SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscriptionId])).rows[0].next_cycle_number).toBe(counter);
  expect((await api.createPostgresRetryStore(executor).read(first.operationId))!.state).toBe("prepared");
  expect((await runtime.query("SELECT kind FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='recovery'", [first.operationId])).rows).toEqual([]);
  expect((await runtime.query("SELECT review_required_at IS NOT NULL AS review,settlement_transition_id FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND outcome='captured'", [row.settlementIntentId])).rows).toEqual([{ review: true, settlement_transition_id: null }]);
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
    if (profile.has(tablename) || tablename === "platform_schema_migrations" || tablename === requiredPrivacyDeclarationTable) continue;
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
  expect(packet.requiredPrivacyContributorIds).toEqual(await readPrivacyDeclarationCensus(admin));
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
}, 95_000);

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
      expect(await b.services.run()).toEqual({ retries: [], renewals: [] });
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
it("preserves exact frozen recovery JSON and keeps changed bindings refused", async () => {
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
    expect(await local.admit({ ...input, recovery: frozen.binding })).toEqual(original);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.subscription_stock_wait_cases WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([{ n: 1 }]);
  const before = await allPublicRows(admin);
  // Await rollback before the next probe can try the transaction advisory lock.
  const admitWithRecovery = (recovery: typeof frozen.binding) => transaction(pinned =>
    api.createPostgresStockWaitStore({ executor: pinned, codec: d.codec, withTransaction: transaction, workerId: "uuid-recovery" })
      .admit({ ...input, recovery }));
  for (const caseId of [randomUUID(), "invalid-uuid"]) {
    await expect(admitWithRecovery({ ...frozen.binding, caseId }))
      .rejects.toMatchObject({ code: "23505", message: "stock_wait_frozen_binding_changed" });
  }
  await expect(admitWithRecovery({ ...frozen.binding, engineIdempotencyKey: frozen.binding.engineIdempotencyKey + ":changed" }))
    .rejects.toMatchObject({ code: "23505", message: "stock_wait_frozen_binding_changed" });
  expect(await allPublicRows(admin)).toEqual(before);
  expect(d.execute).not.toHaveBeenCalled();
}, 30_000);

// Prepared simulator recovery is subsecond per case; retain the measured 30 s consumer bound.
it.each(["sourceReference", "attemptRef", "externalAttemptRef", "all"] as const)("preserves raw recovery identity and fails closed on uppercase sandbox evidence (%s)", async field => {
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
  if (field !== "externalAttemptRef") {
    const refused = api.createNativeRetryDriver({ ...original, executor: guarded, payments: { ...original.payments, readOutcome: async () => upper } });
    expect(await refused.run(retryAt, 50)).toEqual([{ operationId: first.operationId, status: "error" }]);
    expect(errors.at(-1)).toMatchObject({ code: "22023", message: "wrong_attempt" });
    expect(await allPublicRows(admin)).toEqual(before);
    upper.sourceEvidence = { ...evidence.sourceEvidence! };
  }
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
  expect(receipt[0].input).toMatchObject({ sourceReference: evidence.sourceEvidence!.sourceReference, attemptRef: evidence.sourceEvidence!.attemptRef, externalRef: upper.externalAttemptRef });
  const after = await allPublicRows(admin);
  expect(await finish.run(retryAt, 50)).toEqual([]);
  expect(await allPublicRows(admin)).toEqual(after);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
}, 30_000);

// ACK/outcome mutations measured below one second; allow 30 s for the installed artifact.
it.each(["new completion", "historical outcome"] as const)("replays an old uppercase ACK and accepts %s with exact provider references", async terminalPath => {
  for (const ref of [randomUUID().toUpperCase(), "Opaque-Attempt-Ref"]) {
    const f = await active(), d = await deps(f.subscriptionId, "succeeded");
    const snapshot = await d.input.store.buildCycleSnapshots(d.due);
    const claim = await d.input.store.claimDue({ snapshot, workerId: "raw-ack", now });
    expect(await d.input.inventory.reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now })).toMatchObject({ reserved: true });
    const port = settlement(d.codec), old = mainSettlement(executor);
    await port.prepareRenewal({ operationId: claim.operationId, claimToken: claim.claimToken, now });
    const ack = { operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, externalAttemptRef: ` ${ref} `, acknowledgedAt: now };
    await old.acknowledgeExternalAttempt(ack);
    expect((await runtime.query("SELECT external_attempt_ref FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId])).rows).toEqual([{ external_attempt_ref: ref }]);
    const acknowledged = await allPublicRows(admin);
    expect(await port.acknowledgeExternalAttempt(ack)).toMatchObject({ replayed: true, externalAttemptRef: ref });
    await expect(port.acknowledgeExternalAttempt({ ...ack, externalAttemptRef: randomUUID() })).rejects.toMatchObject({ code: "23505" });
    await expect(port.acknowledgeExternalAttempt({ ...ack, externalAttemptRef: "  " })).rejects.toThrow("subscription_renewal_external_attempt_ref_required");
    expect(await allPublicRows(admin)).toEqual(acknowledged);
    const terminal = { operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, eventKey: `raw-ref:${claim.operationId}`, outcome: "succeeded" as const, externalRef: ref, occurredAt: now };
    await expect(port.recordTerminalOutcome({ ...terminal, externalRef: ` ${ref} ` })).rejects.toMatchObject({ code: "23505" });
    await expect(port.recordTerminalOutcome({ ...terminal, externalRef: null })).rejects.toThrow("subscription_renewal_success_external_ref_required");
    expect(await allPublicRows(admin)).toEqual(acknowledged);
    if (terminalPath === "historical outcome") await old.recordTerminalOutcome(terminal);
    expect(await port.recordTerminalOutcome(terminal)).toMatchObject({ state: "succeeded", replayed: terminalPath === "historical outcome" });
    const before = await allPublicRows(admin);
    expect(await port.recordTerminalOutcome(terminal)).toMatchObject({ replayed: true });
    await expect(port.recordTerminalOutcome({ ...terminal, externalRef: randomUUID() })).rejects.toMatchObject({ code: "23505" });
    await expect(port.recordTerminalOutcome({ ...terminal, externalRef: ref.toLowerCase() })).rejects.toMatchObject({ code: "23505" });
    expect(await allPublicRows(admin)).toEqual(before);
    expect((await runtime.query(`SELECT
      (SELECT count(*)::integer FROM public.subscription_cycles WHERE renewal_operation_id=$1) AS cycles,
      (SELECT count(*)::integer FROM public.commerce_orders WHERE renewal_operation_id=$1) AS orders,
      (SELECT count(*)::integer FROM public.commerce_settlement_intents WHERE renewal_operation_id=$1) AS intents,
      (SELECT count(*)::integer FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1) AS outcomes,
      (SELECT status FROM public.commerce_settlement_intents WHERE renewal_operation_id=$1) AS status`, [claim.operationId])).rows[0])
      .toEqual({ cycles: 1, orders: 1, intents: 1, outcomes: 1, status: "settled" });
    expect(d.execute).not.toHaveBeenCalled();
  }
}, 30_000);

// This maps synthetic platform references to the simulator namespace; each DB mutation is subsecond.
it("preserves stored uppercase provider references and canonicalizes only prepare ids", async () => {
  const p = await purchase(), authorizationRef = randomUUID().toUpperCase(), methodRef = randomUUID().toUpperCase(), payerAccountRef = randomUUID().toUpperCase();
  const activation = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts: { ...facts, authorizationRef, methodRef, payerAccountRef } });
  const subscriptionId = String(activation.activation.subscriptionId), d = await deps(subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal({ ...d.input, policy: api.createSandboxRenewalPolicy(methodRef) }, d.due, now);
  const store = api.createPostgresRetryStore(executor), row = (await store.read(first.operationId))!, retryAt = row.nextRetryAt!;
  const recovery = retryDriver(d, "succeeded", retryAt, methodRef), original = recovery.options;
  const simulator = payments.createPostgresSandboxPaymentSimulator(executor, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  const execute = vi.fn(async (input: Parameters<typeof original.payments.execute>[0]) => {
    expect(input).toMatchObject({ paymentIntentId: row.settlementIntentId, orderRef: row.orderId, orderId: row.orderId,
      clientId: p.clientId, customerRef: payerAccountRef.toUpperCase(), paymentMethodRef: methodRef });
    const attempt = await simulator.beginAttempt({ settlementIntentId: input.paymentIntentId, idempotencyKey: input.executionIdempotencyKey,
      requestFingerprint: input.requestFingerprint, methodFacts: { authorizationRef: `sandbox:${authorizationRef}`,
        unattendedChargeAuthorizedAt: d.due.unattendedChargeAuthorizedAt, payerAccountRef: `sandbox:${input.customerRef}`,
        methodRef: `sandbox:${input.paymentMethodRef}`, methodEvidenceRef: facts.methodEvidenceRef }, at: retryAt });
    return { status: "pending" as const, externalAttemptRef: attempt.id };
  });
  const mandate = { authorized: true, authorizationRef: authorizationRef.toUpperCase(), paymentMethodRef: methodRef };
  const options = { ...original, readFrozenMandate: async () => ({ ...mandate, authorized: (await api.createPostgresPurchaseRenewalWriter(executor).readMethod(subscriptionId))?.healthState === "healthy" }),
    retryInput: (snapshot: Parameters<typeof original.retryInput>[0], obligation: Parameters<typeof original.retryInput>[1]) => {
      const supplied = original.retryInput(snapshot, obligation);
      return { ...supplied, paymentIntentId: supplied.paymentIntentId.toUpperCase(), orderRef: supplied.orderRef.toUpperCase(),
        orderId: supplied.orderId, clientId: supplied.clientId, customerRef: supplied.customerRef, paymentMethodRef: supplied.paymentMethodRef };
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
it("replays a pre-fix uppercase failure receipt without changing its identity", async () => {
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
  expect(receipt.input.externalRef).toBe(externalRef.toUpperCase());
  // Literal pre-fix receipt bytes: replay must preserve the uppercase identity.
  await admin.query("UPDATE public.subscription_retry_receipts SET input=$2::jsonb WHERE receipt_key=$1", [receipt.receipt_key, { ...receipt.input, externalRef: externalRef.toUpperCase() }]);
  const before = await allPublicRows(admin);
  expect(await driver.propagateFailure(first.operationId.toUpperCase(), receipt.receipt_key, { ...receipt.input, externalRef: externalRef.toUpperCase() })).toMatchObject({ replayed: true, caseAdvanced: true });
  await expect(driver.propagateFailure(first.operationId, receipt.receipt_key, { ...receipt.input, externalRef: randomUUID() })).rejects.toMatchObject({ code: "23505" });
  expect(await allPublicRows(admin)).toEqual(before); expect(recovery.execute).toHaveBeenCalledTimes(1);
}, 30_000);

// Whole-input replay witnesses are subsecond; use the measured 30 s database allowance.
it.each(["sourceReference", "attemptRef", "externalRef"] as const)("replays a pre-fix uppercase recovery receipt (%s) without another effect", async field => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, recovery = retryDriver(d, "succeeded", row.nextRetryAt!);
  expect(await recovery.driver.run(row.nextRetryAt!, 50)).toEqual([{ operationId: first.operationId, status: "succeeded" }]);
  const receipt = (await runtime.query("SELECT receipt_key,input FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='recovery'", [first.operationId])).rows[0];
  // A literal pre-fix receipt fixture preserves an already-accepted historical JSON spelling.
  const historical = { ...receipt.input, [field]: receipt.input[field].toUpperCase() };
  await admin.query("UPDATE public.subscription_retry_receipts SET input=$2::jsonb WHERE receipt_key=$1", [receipt.receipt_key, historical]);
  const before = await allPublicRows(admin);
  expect(await store.recordRecovery(first.operationId.toUpperCase(), receipt.receipt_key, historical)).toMatchObject({ state: "recovered" });
  await expect(store.recordRecovery(first.operationId, receipt.receipt_key, { ...historical, [field]: randomUUID() })).rejects.toMatchObject({ code: "23505" });
  expect(await allPublicRows(admin)).toEqual(before);
  expect(recovery.execute).toHaveBeenCalledTimes(1);
  expect((await runtime.query("SELECT count(*)::integer AS n FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND outcome='captured'", [row.settlementIntentId])).rows).toEqual([{ n: 1 }]);
}, 30_000);

// Prepare/replay mutations are subsecond; retain the measured 30 s consumer bound.
it("accepts uppercase prepare ids, replays once, and preserves a historical raw method reference", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "declined");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now), store = api.createPostgresRetryStore(executor);
  const row = (await store.read(first.operationId))!, recovery = retryDriver(d, "ambiguous", row.nextRetryAt!), original = recovery.options;
  const driver = api.createNativeRetryDriver({ ...original, retryInput: (snapshot, obligation) => {
    const input = original.retryInput(snapshot, obligation);
    return { ...input, paymentIntentId: input.paymentIntentId.toUpperCase(), orderRef: input.orderRef.toUpperCase() };
  } });
  expect(await driver.run(row.nextRetryAt!, 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
  const receipt = (await runtime.query("SELECT receipt_key,input FROM public.subscription_retry_receipts WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) AND kind='prepare'", [first.operationId])).rows[0];
  expect(receipt.input).toMatchObject({ paymentIntentId: row.settlementIntentId, orderRef: row.orderId });
  const before = await allPublicRows(admin);
  expect(await driver.run(row.nextRetryAt!, 50)).toEqual([{ operationId: first.operationId, status: "awaiting_provider" }]);
  expect(await allPublicRows(admin)).toEqual(before); expect(recovery.execute).toHaveBeenCalledTimes(1);
  const historical = { ...receipt.input, paymentMethodRef: randomUUID().toUpperCase() };
  await admin.query("UPDATE public.subscription_retry_receipts SET input=$2::jsonb WHERE receipt_key=$1", [receipt.receipt_key, historical]);
  const saved = await allPublicRows(admin);
  expect(await store.prepare(first.operationId.toUpperCase(), receipt.receipt_key, historical, row.nextRetryAt!)).toMatchObject({ replayed: true, execute: false });
  await expect(store.prepare(first.operationId, receipt.receipt_key, { ...historical, paymentMethodRef: randomUUID() }, row.nextRetryAt!)).rejects.toMatchObject({ code: "23505" });
  expect(await allPublicRows(admin)).toEqual(saved); expect(recovery.execute).toHaveBeenCalledTimes(1);
}, 30_000);

it("accepts an uppercase subscription UUID through the restricted installed renewal runner", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const upper = f.subscriptionId.toUpperCase();
  expect(upper).not.toBe(f.subscriptionId);
  const due = { ...d.due, subscriptionId: upper };
  const snapshot = await d.input.store.buildCycleSnapshots(due);
  expect(snapshot.subscriptionId).toBe(f.subscriptionId);
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, due, now);
  expect(result.status).toBe("succeeded");
  expect(d.execute).toHaveBeenCalledTimes(1);
  const before = await allPublicRows(admin);
  expect(await api.runOneAutomaticSubscriptionRenewal(d.input, due, later))
    .toMatchObject({ status: "terminal_replay", operationId: result.operationId });
  expect(d.execute).toHaveBeenCalledTimes(1);
  expect(await allPublicRows(admin)).toEqual(before);
}, 30_000);

function normalWorkerRendezvous(candidateIds: ReadonlySet<string>) {
  const entered = new Set<string>();
  let releasePeer!: () => void;
  const peer = new Promise<void>(resolve => { releasePeer = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let missingPeer = false;
  let inFlight = 0, peak = 0;
  return {
    get peak() { return peak; },
    get missingPeer() { return missingPeer; },
    async query(sql: string, values?: unknown[]) {
      const id = String(values?.[0]);
      if (!sql.startsWith("SELECT cycle_snapshot FROM public.subscription_renewal_operations") || !candidateIds.has(id) || entered.has(id)) {
        return executor.query(sql, values);
      }
      if (entered.size === 0) timer = setTimeout(() => { missingPeer = true; releasePeer(); }, 1_000);
      entered.add(id);
      if (entered.size === 2) { clearTimeout(timer); releasePeer(); }
      peak = Math.max(peak, ++inFlight);
      try {
        await peer;
        if (missingPeer) throw new Error("Normal renewal worker did not reach the rendezvous");
        return await executor.query(sql, values);
      } finally { inFlight--; }
    },
  };
}

it("drains normal due renewals concurrently with zero duplicate dispatch and monotonic cycle advance", async () => {
  const subs = [await active(), await active(), await active(), await active()];
  const candidateIds = new Set(subs.map(s => s.subscriptionId));
  const d = await deps(subs[0].subscriptionId, "succeeded");
  const executedByOrder = new Map<string, number>();
  const baseRail = d.input.paymentRails.resolve("sandbox")!;
  const countedRail = {
    ...baseRail,
    async execute(input: Parameters<typeof baseRail.execute>[0]) {
      executedByOrder.set(input.orderId, (executedByOrder.get(input.orderId) ?? 0) + 1);
      return baseRail.execute(input);
    },
  };
  const unused = async (): Promise<never> => { throw new Error("unexpected_retry_on_concurrent_renewal"); };
  let clock = now;
  let rendezvous: ReturnType<typeof normalWorkerRendezvous> | undefined;
  let admit = executor.query;
  const bindingFor = (concurrency: number) => api.createNativeSubscriptionBinding({
    enabled: true, batchLimit: 10, concurrency, population: `concurrent-renewal:${subs[0].subscriptionId}`,
    executor: { query: (sql, values) => sql.startsWith("SELECT public.subscription_stock_wait_admit(")
      ? admit(sql, values) : (rendezvous?.query ?? executor.query)(sql, values) },
    withTransaction: transaction,
    withRunLease: async (_population, work) => work(),
    codec: d.codec, settlement: db => settlement(d.codec, db), inventory: d.input.inventory,
    paymentRails: { resolve: channel => channel === "sandbox" ? countedRail : null },
    policy: d.input.policy,
    retry: { readFrozenMandate: unused, retryInput: () => { throw new Error("unexpected_retry"); }, payments: { execute: unused, readOutcome: unused }, recoveredTemplate: "recovered" },
    failureTemplate: "failed", recoveryPath: "/recover", workerId: "concurrent-worker", now: () => clock,
    catalogue: { version: "complete-test-catalogue", migration: "native-test-catalogue" },
    readiness: async () => ({ state: "ready", candidate: { artifact: "fixture", configuration: "fixture", environment: "disposable", database: "fixture", schema: "complete" }, loadedPackages: [], issues: [] }),
  });

  const serial = normalWorkerRendezvous(candidateIds);
  rendezvous = serial;
  expect(await bindingFor(1).services.run()).toMatchObject({ renewals: Array.from(candidateIds, () => ({ status: "error" })) });
  expect(serial.missingPeer).toBe(true);
  expect(serial.peak).toBe(1);
  expect(executedByOrder.size).toBe(0);

  rendezvous = normalWorkerRendezvous(candidateIds);
  const native = bindingFor(4);
  const settledIds: string[] = [];
  for (let pass = 0; pass < 4 && settledIds.length < 4; pass++) {
    const run = await transaction(async lockDb => {
      let winner: ReturnType<typeof executor.query> | undefined;
      let busyLock: ReturnType<typeof executor.query> | undefined;
      admit = async (sql, values) => {
        if (!winner) {
          winner = executor.query(sql, values);
          return winner;
        }
        // Once the first real admission commits, force the other rows down the real busy path.
        busyLock ??= winner.then(() => lockDb.query("SELECT pg_advisory_xact_lock(846832106,1)"));
        await busyLock;
        return executor.query(sql, values);
      };
      try { return await native.services.run(); }
      finally { admit = executor.query; }
    });
    if (rendezvous) {
      expect(rendezvous.missingPeer, "Normal renewal worker did not reach the rendezvous").toBe(false);
      expect(rendezvous.peak).toBeGreaterThanOrEqual(2);
      // This counts four fixture candidates. The batch helper test exercises the worker cap with more rows.
      expect(rendezvous.peak).toBeLessThanOrEqual(4);
      rendezvous = undefined;
    }
    expect(run).not.toBeNull();
    const renewals = "renewals" in run! ? run.renewals : [];
    expect(renewals).toHaveLength(1);
    expect(renewals.every(r => r.status === "succeeded")).toBe(true);
    settledIds.push(...renewals.map(r => r.subscriptionId));
    // Rows omitted by 55P03 hot-SKU admission busy retain their 5-minute claim lease until expiry.
    if (settledIds.length < 4) clock = new Date(Date.parse(clock) + 6 * 60_000).toISOString();
  }
  expect(settledIds).toHaveLength(4);
  expect(new Set(settledIds)).toEqual(candidateIds);
  expect(executedByOrder.size).toBe(4);
  expect([...executedByOrder.values()].every(count => count === 1)).toBe(true);

  const schedules = (await runtime.query("SELECT id, next_cycle_at FROM public.subscriptions WHERE id = ANY($1::uuid[])", [subs.map(s => s.subscriptionId)])).rows;
  expect(schedules).toHaveLength(4);
  for (const row of schedules) {
    expect(new Date(String(row.next_cycle_at)).getTime()).toBeGreaterThan(Date.parse(now));
  }

  // Re-running immediately must find no due renewals and dispatch nothing again.
  const dispatches = [...executedByOrder];
  expect(await native.services.run()).toMatchObject({ renewals: [] });
  expect([...executedByOrder]).toEqual(dispatches);
}, 30_000);

const generationErrorKeys = ["length", "name", "message", "severity", "code", "detail", "hint", "position",
  "internalPosition", "internalQuery", "where", "schema", "table", "column", "dataType",
  "constraint", "file", "line", "routine"].sort();

const generationText = `${frozenGenerationSql}::text AS projection`;
const rawClaim = "SELECT public.subscription_claim_due_renewal($1::text,$2::text,$3::jsonb,'renewal-witness',300,$4::timestamptz)::text AS result";
const rawPrepare = "SELECT public.commerce_prepare_subscription_renewal($1::uuid,$2::uuid,$3::timestamptz)::text AS result";
const rawReadback = "SELECT public.subscription_read_renewal($1::text)::text AS result";

const renewalTemplateForward = /_subscription_renewal_current_template\.sql$/u;
const staleSnapshotSignature = "subscription_renewal_snapshot_is_stale(integer,jsonb,integer)";
const stalePreparation = {
  ...staleClaim, hint: "Reconcile the stored renewal operation before resuming it. See the renewal upgrade report.",
};
type UpgradeTarget = Parameters<Parameters<typeof withOccupiedRenewalPrefix>[0]>[0];
const withTemplateUpgrade = (work: (target: UpgradeTarget) => Promise<void>) =>
  withOccupiedRenewalPrefix(work, file => renewalTemplateForward.test(file));
const upgradeTransaction = (db: Pool): typeof transaction => work => transaction(work, db);

async function upgradeRenewal(target: UpgradeTarget, options: {
  retained?: boolean; scenario?: "succeeded" | "declined" | "ambiguous"; edited?: boolean; variantId?: string;
  paidAt?: string; claimAt?: string; providerBacked?: boolean;
} = {}) {
  const claimAt = options.claimAt ?? now;
  const f = await renewalPurchase(options.retained, target, options.paidAt, options.providerBacked);
  const d = await deps(f.subscriptionId, options.scenario ?? "succeeded", claimAt, target.db);
  const held = await d.input.store.buildCycleSnapshots(d.due);
  const snapshot = await bindRenewalDestination(d, held, target.db);
  if (options.edited !== false) await resizeForRenewal(f, upgradeTransaction(target.db), options.variantId);
  const claim = () => api.createPostgresRenewalStore(target.db, d.codec)
    .claimDue({ snapshot, workerId: "before-upgrade", now: claimAt });
  return { f, d, held, snapshot, claim };
}

async function reserveIncumbent(d: Awaited<ReturnType<typeof deps>>, claim: RenewalReadback) {
  expect(await d.input.inventory.reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now }))
    .toMatchObject({ reserved: true });
}

function runHeldRenewal(entry: Awaited<ReturnType<typeof upgradeRenewal>>, when = now) {
  const { d, snapshot, claim } = entry;
  return api.runOneAutomaticSubscriptionRenewal({ ...d.input, store: {
    ...d.input.store, buildCycleSnapshots: async () => snapshot, claimDue: claim,
  } }, d.due, when);
}

async function closeWaitingRetry(db: Pool, { f }: Awaited<ReturnType<typeof upgradeRenewal>>, id: string, when: string) {
  await transaction(async tx => {
    await rpc("subscription_apply_lifecycle_action", [f.clientId, `cancel:${id}`, f.subscriptionId, "cancel", "{}", when], tx);
    await rpc("subscription_terminalize_unpaid_artifacts", [f.subscriptionId, when, "subscription_cancelled", "cancelled"], tx);
  }, db);
}

async function frozenOperation(db: Pool, id: string) {
  const { rows: [row] } = await db.query(`SELECT identity_key,operation_fingerprint,cycle_snapshot::text AS wire
    FROM public.subscription_renewal_operations WHERE id=$1`, [id]);
  return row;
}

async function renewalAmounts(db: Pool, orderId: string) {
  return (await db.query(`SELECT o.total_amount_minor::int AS "order",i.amount_minor::int AS intent
    FROM public.commerce_orders o JOIN public.commerce_settlement_intents i ON i.order_id=o.id WHERE o.id=$1`, [orderId])).rows;
}

async function renewalUpgradeReport(db: Pool, hooks: { beforeCut?: () => Promise<void>; afterCut?: () => Promise<void> } = {}) {
  const guide = readFileSync("packages/core/docs/guide/upgrade/database-migrations.md", "utf8");
  const sql = guide.split("## Reconcile stale native renewals")[1]!.split("```sql\n")[1]!.split("```")[0]!;
  const statements = sql.trim().split(/;\s*(?:\n|$)/u).filter(Boolean);
  expect(statements).toHaveLength(4);
  const [begin, readCut, population, commit] = statements as [string, string, string, string];
  const client = await db.connect();
  try {
    await client.query(begin);
    await hooks.beforeCut?.();
    expect((await client.query(readCut)).rows).toEqual([{ cut_snapshot: expect.stringMatching(/^\d+:\d+:/u),
      cut_statement_started_at: expect.any(Date) }]);
    expect((await client.query("SHOW transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
    expect((await client.query("SHOW transaction_isolation")).rows).toEqual([{ transaction_isolation: "repeatable read" }]);
    await hooks.afterCut?.();
    const { rows } = await client.query(population);
    await client.query(commit);
    return rows;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

it("upgrades occupied renewal roots, refuses stale preparation without writes, and rebuilds held offers", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target, transact = upgradeTransaction(db);
    const baseline = await upgradeRenewal(target);
    vi.spyOn(baseline.d.codec, "freeze").mockReturnValueOnce(baseline.held);
    const beforeJob = binding(baseline.d, () => now, transact, db).contributions[0].schedules![0]!;
    expect(await beforeJob.run()).toMatchObject({ renewals: [{ subscriptionId: baseline.f.subscriptionId, status: "succeeded" }] });
    const old = (await baseline.d.input.store.readRenewal(baseline.d.codec.identity(baseline.held)))!;
    expect(await renewalAmounts(db, old.orderId!)).toEqual([{ order: 200, intent: 200 }]);
    expect(baseline.d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([200]);

    const claimed = await upgradeRenewal(target, { retained: true });
    const c = await claimed.claim();
    const reserved = await upgradeRenewal(target);
    const r = await reserved.claim();
    await reserveIncumbent(reserved.d, r);
    const ready = await upgradeRenewal(target, { retained: true });
    const p = await ready.claim();
    await reserveIncumbent(ready.d, p);
    await db.query(rawPrepare, [p.operationId, p.claimToken, now]);
    const preparedReplay = (await db.query(rawPrepare, [p.operationId, p.claimToken, now])).rows;

    const replacement = randomUUID();
    await owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
      VALUES($1,'11111111-1111-4111-8111-111111111111','G7-REPLACEMENT','Replacement',true)`, [replacement]);
    await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES('33333333-3333-4333-8333-333333333333',$1,'any',100,'2026-01-01')`, [replacement]);
    const waitOpenedAt = days(now, -6 / 1440);
    const waiting = await upgradeRenewal(target, { variantId: replacement, paidAt: days(at, -8 / 1440), claimAt: waitOpenedAt });
    const w = await waiting.claim();
    await stock(0, randomUUID(), db);
    await stock(1000, randomUUID(), db, "G7-REPLACEMENT");
    expect(await api.createPostgresStockWaitStore({ executor: db, withTransaction: transact, codec: waiting.d.codec, workerId: "before-upgrade" })
      .admit({ operationId: w.operationId, claimToken: w.claimToken, now: waitOpenedAt, snapshot: w.cycleSnapshot })).toMatchObject({ waiting: true });
    const laterOffer = { paidAt: days(at, 4 / 1440), claimAt: later };
    const held = await Promise.all([upgradeRenewal(target, laterOffer), upgradeRenewal(target, { ...laterOffer, retained: true })]);
    const graph = [c, r, p, w], readFrozen = () => Promise.all(graph.map(x => frozenOperation(db, x.operationId)));
    const original = await readFrozen();
    expect((await applyForward()).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
    expect(await generationAcl(owner, staleSnapshotSignature)).toEqual([{ owner: "postgres", definer: false, volatility: "s",
      config: ["search_path=pg_catalog, pg_temp"], acl: [["postgres", "EXECUTE", false], ["service_role", "EXECUTE", false]] }]);
    expect(await readFrozen()).toEqual(original);
    expect((await db.query("SELECT DISTINCT claimed_before_rnw_1 FROM public.subscription_renewal_operations WHERE id=ANY($1::uuid[])",
      [graph.map(op => op.operationId)])).rows).toEqual([{ claimed_before_rnw_1: true }]);
    expect((await owner.query(`SELECT data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='subscription_renewal_operations' AND column_name='claimed_before_rnw_1'`)).rows)
      .toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
    for (const [op, stored] of graph.map((op, index) => [op, original[index]] as const)) {
      const codec = api.createNativeRenewalCodec();
      const wire = codec.encode(op.cycleSnapshot);
      expect(JSON.parse(stored.wire)).toEqual(wire);
      expect(JSON.parse((await db.query(rawClaim, [op.identityKey, op.operationFingerprint, wire, now])).rows[0].result))
        .toMatchObject({ operationId: op.operationId, replayed: true, acquired: false, cycleSnapshot: wire });
    }
    expect((await db.query(rawPrepare, [p.operationId, p.claimToken, now])).rows).toEqual(preparedReplay);
    await expect(db.query(rawPrepare, [r.operationId, randomUUID(), now])).rejects.toMatchObject({ code: "40001", message: "commerce_renewal_stale_claim" });
    await expect(db.query(rawPrepare, [c.operationId, c.claimToken, now])).rejects.toMatchObject({ message: "commerce_renewal_reservation_required" });
    const beforePrepare = await allPublicRows(owner);
    for (let i = 0; i < 2; i++) await expect(db.query(rawPrepare, [r.operationId, r.claimToken, now])).rejects.toMatchObject(stalePreparation);
    expect(await allPublicRows(owner)).toEqual(beforePrepare);

    // With only the edited SKU available, the mounted stock wait still owns the original basket.
    const noStock = binding(waiting.d, () => now, transact, db);
    expect(await noStock.services.run()).toMatchObject({ renewals: expect.arrayContaining([
      expect.objectContaining({ operationId: w.operationId, status: "deferred", reason: "inventory_unavailable" }),
    ]) });
    expect(noStock.prepare.mock.calls.some(([, request]) => request.operationId === w.operationId)).toBe(false);
    expect(waiting.d.execute).not.toHaveBeenCalled();
    expect(await renewalUpgradeReport(db)).toEqual(expect.arrayContaining([expect.objectContaining({ operation_id: w.operationId, stock_wait_state: "waiting" })]));
    await stock(1000, randomUUID(), db);

    for (const entry of held) {
      expect((await db.query("SELECT id FROM public.subscription_renewal_operations WHERE subscription_id=$1", [entry.f.subscriptionId])).rows).toEqual([]);
      await expect(entry.claim()).rejects.toMatchObject(staleClaim);
    }
    let clock = later;
    const mounted = binding(claimed.d, () => clock, transact, db);
    const tick = await mounted.services.run();
    if (!tick || !("renewals" in tick)) throw new Error("expected_mounted_renewal_result");
    expect(tick.renewals.filter(row => row.subscriptionId === claimed.f.subscriptionId)).toMatchObject([
      { status: "error", reason: "renewal_processing_failed" },
    ]);
    const prepared = mounted.prepare.mock.calls.findIndex(([, request]) => request.operationId === c.operationId);
    expect(mounted.prepare.mock.settledResults[prepared]).toMatchObject({ type: "rejected", value: stalePreparation });
    const after = await readFrozen();
    expect(after).toEqual(original);
    expect((await db.query("SELECT claim_generation::int,claimed_before_rnw_1 FROM public.subscription_renewal_operations WHERE id=$1", [c.operationId])).rows)
      .toEqual([{ claim_generation: 2, claimed_before_rnw_1: true }]);
    expect((await db.query(`SELECT id FROM public.subscription_cycles WHERE renewal_operation_id=ANY($1::uuid[])`, [[c.operationId, r.operationId, w.operationId]])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM public.subscription_delivery_alignment_cases")).rows).toEqual([]);
    for (const entry of held) {
      const result = tick.renewals.find(row => row.subscriptionId === entry.f.subscriptionId);
      expect(result).toMatchObject({ status: "succeeded", identityKey: entry.d.codec.identity(entry.held) });
      const next = (await entry.d.input.store.readRenewal(result!.identityKey))!;
      expect(next.cycleSnapshot).toMatchObject({ cycle: entry.held.cycle, scheduledAt: entry.held.scheduledAt,
        templateSnapshot: { version: 2 }, pricingSnapshot: { totalAmountMinor: 300 } });
      expect(await renewalAmounts(db, next.orderId!)).toEqual([{ order: 300, intent: 300 }]);
    }
    expect(claimed.d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([300, 300]);
    clock = new Date(Date.parse(later) + 60_000).toISOString();
    await mounted.services.run();
    expect(claimed.d.execute).toHaveBeenCalledTimes(2);
  });
}, postgresSetupTimeoutMs);

async function prepareWebhookRenewal(target: UpgradeTarget) {
  const { db } = target, transact = upgradeTransaction(db);
  const { f, d, claim } = await upgradeRenewal(target, { providerBacked: true });
  const op = await claim();
  await reserveIncumbent(d, op);
  const prepared = await d.input.settlement.prepareRenewal({ operationId: op.operationId, claimToken: op.claimToken, now });
  const intentId = prepared.settlementIntentId, providerPaymentId = `pi_${op.operationId}`;
  const event = { provider: webhookProvider, providerEventId: `evt_${op.operationId}`, providerPaymentRef: providerPaymentId,
    intentRef: intentId, providerOccurredAt: later, outcome: "succeeded" as const, money: { amountMinor: 200, currency: "XXX" } };
  const body = Buffer.from(JSON.stringify(event));
  const sign = (raw: Uint8Array) => createHmac("sha256", "synthetic-renewal-signature").update(raw).digest("hex");
  const unexpected = async (): Promise<never> => { throw new Error("unexpected_provider_request"); };
  const adapter: Parameters<typeof payments.createPostgresProviderPaymentRail>[0]["adapter"] = {
    capabilities: { providerKind: webhookProvider, captureFlows: [], requiresStoredMandateEvidence: false,
      assessMandate: () => ({ chargeable: true }), unattendedChargeFlow: "off_session_payment",
      payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
      methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
      terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
      mandateUpsertIsSubscriptionScoped: false, supportedCurrencies: ["XXX"], unattended: "supported",
      readback: "unsupported", close: "unsupported", exactAbsence: "unsupported", refundObservation: "unsupported",
      refundCreate: "unsupported", authorizationCaptureSplit: "unsupported" },
    attemptPort: { validateInput() { throw new Error("unexpected_dispatch"); }, execute: unexpected },
    readbackPort: { readPayment: unexpected },
    verifyPort: { async verifyAndNormalize({ rawBody, headers }) {
      if (rawBody.length !== body.length || !body.equals(rawBody) || headers["x-fixture-signature"] !== sign(rawBody)) {
        return { kind: "refusal", reason: "malformed" };
      }
      return { ...event, kind: "money", attemptRef: null, fingerprint: sign(rawBody), capturedAmountBasis: "provider_capture_v1",
        providerAuditPayload: { livemode: false, captureTimeBasis: "signed_event_v1", providerAccountRef: "acct_fixture" } };
    } },
  };
  const truth = { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
  const bindingOptions = { enabled: true, channelKey: webhookProvider, executor: db, withTransaction: transact,
    codec: d.codec, truth, settlement: (tx: Parameters<typeof settlement>[1]) => settlement(d.codec, tx),
    now: () => later, search: async () => [] };
  const rail = payments.createPostgresProviderPaymentRail({ executor: db, adapter, mode: "test", truth,
    resolveMethodOwner: async () => null, resolveSavedMethodOwner: async () => null,
    composeWebhook: (event, control) => bindingForWebhook.composeWebhook(event, control) });
  const bindingForWebhook = api.createPostgresProviderRenewalBinding({ ...bindingOptions, paymentRail: rail });
  const request = { paymentIntentId: intentId, providerIdempotencyKey: `${op.identityKey}:provider`, providerRequestFingerprint: op.operationFingerprint };
  await rail.control.createIntent({ idempotencyKey: `${op.identityKey}:provider-intent`, targetKind: "subscription_cycle",
    orderId: prepared.orderId, subscriptionId: d.due.subscriptionId, subscriptionCycleId: prepared.cycleId,
    amountMinor: 200, currency: "XXX", channelKey: webhookProvider, metadata: {}, at: now });
  const { paymentAttemptId } = await rail.control.prepareProviderAttempt({ ...request, idempotencyKey: `${op.identityKey}:provider-prepare`,
    provider: webhookProvider, providerFlow: "off_session_payment", paymentMethodRef: f.methodRef, requestPayload: {} });
  await rail.control.finalizeProviderAttempt({ ...request, idempotencyKey: `${op.identityKey}:provider-finalize`, paymentAttemptId,
    providerAttemptId: providerPaymentId, providerSessionId: null, attemptStatus: "processing", nextActionKind: null,
    requestPayload: {}, responsePayload: {} });
  await d.input.settlement.acknowledgeExternalAttempt({ operationId: op.operationId, operationFingerprint: op.operationFingerprint,
    externalAttemptRef: providerPaymentId, acknowledgedAt: now });
  return { id: op.operationId, async deliver() {
    expect(await rail.ingress.receive({ rawBody: body, headers: { "x-fixture-signature": sign(body) }, receivedAt: later }))
      .toMatchObject({ status: 200 });
    expect((await db.query("SELECT state FROM public.subscription_renewal_operations WHERE id=$1", [op.operationId])).rows)
      .toEqual([{ state: "succeeded" }]);
  } };
}

it("reports each stale incumbent once at the read-only upgrade cut and preserves prepared payment truth", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target, transact = upgradeTransaction(db);
    const retryTarget = { executor: db, transaction: transact };
    const claimed = await (await upgradeRenewal(target)).claim();
    const r = await upgradeRenewal(target, { retained: true });
    const reserved = await r.claim();
    await reserveIncumbent(r.d, reserved);
    const prepared = await upgradeRenewal(target, { scenario: "ambiguous" });
    const outstanding = await runHeldRenewal(prepared);
    expect(outstanding.status).toBe("awaiting_provider");
    expect(prepared.d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([200]);
    const original = (await prepared.d.input.store.readRenewal(outstanding.identityKey))!;
    const replay = () => db.query(rawPrepare, [original.operationId, original.claimToken, now]);
    const originalReplay = (await replay()).rows, originalWire = await frozenOperation(db, original.operationId);
    const fresh = await upgradeRenewal(target, { edited: false });
    const control = await fresh.claim();
    await reserveIncumbent(fresh.d, control);
    await db.query(rawPrepare, [control.operationId, control.claimToken, now]);

    const waiting = await upgradeRenewal(target), uncaptured = await upgradeRenewal(target);
    const wait = await waiting.claim(), missingWait = await uncaptured.claim();
    await stock(0, randomUUID(), db);
    expect(await api.createPostgresStockWaitStore({ executor: db, withTransaction: transact, codec: waiting.d.codec, workerId: "before-upgrade" })
      .admit({ operationId: wait.operationId, claimToken: wait.claimToken, now, snapshot: wait.cycleSnapshot })).toMatchObject({ waiting: true });
    await uncaptured.d.input.store.refuseBeforePayment({ operationId: missingWait.operationId,
      claimToken: missingWait.claimToken, occurredAt: now, reason: "inventory_unavailable" });
    expect((await db.query("SELECT renewal_operation_id FROM public.subscription_stock_wait_cases")).rows).toEqual([{ renewal_operation_id: wait.operationId }]);
    await stock(1000, randomUUID(), db);

    async function declined() {
      const f = await upgradeRenewal(target, { scenario: "declined" });
      const result = await runHeldRenewal(f);
      expect(result.status).toBe("refused");
      return { ...f, id: result.operationId };
    }
    const retryStore = api.createPostgresRetryStore(db);
    const unpaid = await declined();
    for (let i = 0; i < 3; i++) {
      const retryAt = (await retryStore.read(unpaid.id))!.nextRetryAt!;
      expect(await retryDriver(unpaid.d, "declined", retryAt, undefined, retryTarget).driver.run(retryAt, 1))
        .toEqual([{ operationId: unpaid.id, status: "refused" }]);
    }
    expect(await retryStore.read(unpaid.id)).toMatchObject({ state: "waiting", nextRetryAt: null });
    const pending = await declined(), retryAt = (await retryStore.read(pending.id))!.nextRetryAt!;
    const retry = retryDriver(pending.d, "ambiguous", retryAt, undefined, retryTarget);
    expect(await retry.driver.run(retryAt, 50)).toContainEqual({ operationId: pending.id, status: "awaiting_provider" });
    const waitingRetry = await declined();
    await owner.query("UPDATE public.subscription_retry_obligations SET renewal_quarantined_until=$2 WHERE renewal_operation_id=$1",
      [waitingRetry.id, days(retryAt, 1)]);
    const closed = await declined();
    await closeWaitingRetry(db, closed, closed.id, later);
    expect((await db.query(`SELECT c.status AS cycle,i.status AS intent,r.next_retry_at
      FROM public.subscription_retry_obligations r JOIN public.subscription_cycles c ON c.id=r.cycle_id
      JOIN public.commerce_settlement_intents i ON i.id=r.settlement_intent_id WHERE r.renewal_operation_id=$1`, [closed.id])).rows)
      .toEqual([{ cycle: "cancelled", intent: "cancelled", next_retry_at: null }]);

    const beforeCut = await prepareWebhookRenewal(target), afterCut = await prepareWebhookRenewal(target);
    const historical = await upgradeRenewal(target, { edited: false });
    const legacy = await createPostgresAutomaticRenewalPort(db).buildCycleSnapshots(historical.d.due);
    const historicalClaim = JSON.parse((await db.query(rawClaim, [
      automaticRenewalIdentity(legacy.subscriptionId, legacy.scheduledAt), automaticRenewalFingerprint(legacy), legacy, now,
    ])).rows[0].result);
    await resizeForRenewal(historical.f, transact);
    const v3 = await upgradeRenewal(target), tagged = await v3.claim();
    await reserveIncumbent(v3.d, tagged);
    // The dormant storage has no v3 producer. Model its persisted wire at the database boundary.
    await owner.query(`UPDATE public.subscription_renewal_operations
      SET cycle_snapshot = (cycle_snapshot - 'settlementChannelKey') || '{"contractVersion":"platform.subscription.renewal.v3"}'::jsonb
      WHERE id=$1`, [tagged.operationId]);
    expect((await applyForward()).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
    const postForward = await upgradeRenewal(target, { edited: false });
    const postForwardClaim = await postForward.claim();
    await resizeForRenewal(postForward.f, transact);
    expect((await db.query(`SELECT id,claimed_before_rnw_1 FROM public.subscription_renewal_operations
      WHERE id=ANY($1::uuid[])`, [[tagged.operationId, historicalClaim.operationId, postForwardClaim.operationId]])).rows)
      .toEqual(expect.arrayContaining([
        { id: tagged.operationId, claimed_before_rnw_1: false },
        { id: historicalClaim.operationId, claimed_before_rnw_1: true },
        { id: postForwardClaim.operationId, claimed_before_rnw_1: false },
      ]));
    const before = await allPublicRows(owner);
    const expected = [claimed.operationId, reserved.operationId, original.operationId, wait.operationId, missingWait.operationId,
      unpaid.id, waitingRetry.id, pending.id, beforeCut.id, afterCut.id].sort();
    const report = await renewalUpgradeReport(db);
    expect(report.map(row => row.operation_id)).toEqual(expected);
    expect(report).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation_id: claimed.operationId, operation_state: "claimed" }),
      expect.objectContaining({ operation_id: reserved.operationId, operation_state: "reserved" }),
      expect.objectContaining({ operation_id: original.operationId, operation_state: "attempt_prepared", frozen_amount_minor: 200, currency: "XXX" }),
      expect.objectContaining({ operation_id: wait.operationId, stock_wait_state: "waiting" }),
      expect.objectContaining({ operation_id: missingWait.operationId, stock_wait_state: "uncaptured" }),
      expect.objectContaining({ operation_id: unpaid.id, retry_state: "waiting" }),
      expect.objectContaining({ operation_id: pending.id, retry_state: "prepared" }),
    ]));
    expect(await allPublicRows(owner)).toEqual(before);
    await expect(db.query(rawPrepare, [tagged.operationId, tagged.claimToken, now]))
      .rejects.toMatchObject({ code: "22023", message: "commerce_renewal_invalid_snapshot" });
    expect(await allPublicRows(owner)).toEqual(before);
    const atCut = await renewalUpgradeReport(db, { beforeCut: beforeCut.deliver, afterCut: afterCut.deliver });
    expect(atCut.map(row => row.operation_id)).toEqual(expected.filter(id => id !== beforeCut.id));
    expect((await renewalUpgradeReport(db)).map(row => row.operation_id)).toEqual(expected.filter(id => id !== beforeCut.id && id !== afterCut.id));

    expect((await replay()).rows).toEqual(originalReplay);
    expect(await frozenOperation(db, original.operationId)).toEqual(originalWire);
    const rail = prepared.d.input.paymentRails.resolve("sandbox")!;
    const read = vi.spyOn(rail, "readOutcome");
    expect(await api.runOneAutomaticSubscriptionRenewal(prepared.d.input, prepared.d.due, later))
      .toMatchObject({ status: "awaiting_provider", operationId: original.operationId });
    expect(read).toHaveBeenCalledOnce();
    expect(prepared.d.execute).toHaveBeenCalledTimes(1);
    expect(await frozenOperation(db, original.operationId)).toEqual(originalWire);
  });
}, postgresSetupTimeoutMs);

it("drains in-flight retry dispatch before the forward and resumes without a stale charge", async () => {
  await withTemplateUpgrade(async target => {
    const { db, applyForward } = target, transact = upgradeTransaction(db);
    const first = await upgradeRenewal(target, { scenario: "declined" });
    const held = await upgradeRenewal(target, { scenario: "declined", claimAt: days(now, 2) });
    async function incurRetry(entry: typeof first, at: string) {
      const result = await runHeldRenewal(entry, at);
      expect(result.status).toBe("refused");
      return result.operationId;
    }
    const firstId = await incurRetry(first, now), heldId = await incurRetry(held, days(now, 2));
    const retryStore = api.createPostgresRetryStore(db);
    const firstRetryAt = (await retryStore.read(firstId))!.nextRetryAt!;
    const heldRetryAt = (await retryStore.read(heldId))!.nextRetryAt!;
    const retry = retryDriver(first.d, "ambiguous", firstRetryAt, undefined, { executor: db, transaction: transact });
    const atDispatch = signal(), allowDispatch = signal();
    const cutoverCharges: number[] = [];
    let forwardStarted = false;
    const delayed: typeof retry.options = { ...retry.options, payments: { ...retry.options.payments,
      async execute(input) {
        atDispatch.resolve();
        await allowDispatch.promise;
        if (forwardStarted) cutoverCharges.push(input.amountMinor);
        return retry.execute(input);
      },
    } };
    const oldInvocation = binding(first.d, () => firstRetryAt, transact, db, delayed).services.run();
    const outcome = oldInvocation.catch(error => { atDispatch.reject(error); throw error; });
    const reportIds: string[] = [];
    try {
      await Promise.race([atDispatch.promise, outcome.then(() => { throw new Error("retry_finished_before_dispatch_barrier"); })]);
      const section = readFileSync("packages/core/docs/guide/upgrade/database-migrations.md", "utf8")
        .split("## Reconcile stale native renewals")[1]!.split("Use the first report result")[0]!;
      const steps = [...section.matchAll(/^\d\. (Pause and drain|Apply|Run|Verify|Resume)\b/gmu)].map(match => match[1]);
      expect(new Set(steps)).toEqual(new Set(["Pause and drain", "Apply", "Run", "Verify", "Resume"]));
      for (const step of steps) {
        if (step === "Pause and drain") {
          allowDispatch.resolve();
          expect(await outcome).toMatchObject({ retries: [{ operationId: firstId, status: "awaiting_provider" }] });
        }
        if (step === "Apply") {
          forwardStarted = true;
          expect((await applyForward()).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
        }
        if (step === "Run") {
          const rows = await renewalUpgradeReport(db);
          reportIds.push(...rows.filter(row => row.retry_state === "waiting").map(row => row.operation_id));
        }
        if (step === "Verify") {
          expect(reportIds).toEqual([heldId]);
          await closeWaitingRetry(db, held, heldId, heldRetryAt);
          expect((await renewalUpgradeReport(db)).map(row => row.operation_id)).not.toContain(heldId);
        }
        if (step === "Resume") {
          const resumed = retryDriver(first.d, "ambiguous", heldRetryAt, undefined, { executor: db, transaction: transact });
          const tick = await binding(first.d, () => heldRetryAt, transact, db, resumed.options).services.run();
          if (!tick || !("retries" in tick)) throw new Error("expected_mounted_retry_result");
          expect(tick.retries).not.toContainEqual(expect.objectContaining({ operationId: heldId }));
          cutoverCharges.push(...resumed.execute.mock.calls.map(([input]) => input.amountMinor));
        }
      }
      expect(retry.execute.mock.calls.map(([input]) => input.amountMinor)).toEqual([200]);
      expect(await retryStore.read(firstId)).toMatchObject({ state: "prepared", externalAttemptSequence: 1 });
      expect(cutoverCharges).toEqual([]);
    } finally {
      allowDispatch.resolve();
      await outcome;
    }
  });
}, postgresSetupTimeoutMs);

it.each(["v1", "v2"] as const)("reads the original frozen generation for %s through takeover and late delivery", async revision => {
  const paidAt = at.replace(/\.\d{3}Z$/, ".123456Z"), f = await purchase(true, true, paidAt);
  const purchaseFacts: NativeRenewalPurchaseFacts = revision === "v2"
    ? { ...facts, renewalTerms: { version: "native.renewal-terms.v1" } } : facts;
  const activated = await api.activateNativePurchaseWithRenewal(executor, { ...f, facts: purchaseFacts });
  const d = await deps(String(activated.activation.subscriptionId), "succeeded");
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
  const shipmentId = await parcel(f.orderId);
  const aligned = api.withNativeDeliveryAlignmentRenewalAdmission(d.input.store, executor);
  expect(await aligned.admitDeliveryAlignment({ ...d.due, occurredAt: now })).toMatchObject({ allowed: false, state: "protected" });
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  const claim = await d.input.store.claimDue({ snapshot, workerId: "original", now });
  expect(claim.acquired).toBe(true);
  // Distinguish the persisted root counter from both counters in the frozen wire.
  const storedCycle = (await admin.query<{ cycle_number: number }>(`UPDATE public.subscription_renewal_operations
    SET cycle_number=17 WHERE id=$1 RETURNING cycle_number`, [claim.operationId])).rows[0]!.cycle_number;
  expect(storedCycle).toBe(17);
  const pair = [claim.operationId, claim.operationId], absent = randomUUID();
  const inherited = new Pool({ connectionString: loginConnection(runtimeUrl, runtimeLogin()) });
  try {
    expect((await inherited.query("SELECT current_user,session_user")).rows).toEqual([
      { current_user: runtimeLogin(), session_user: runtimeLogin() },
    ]);
    const initial = (await inherited.query(generationText, pair)).rows[0].projection;
    const legacy = JSON.parse((await inherited.query(rawReadback, [claim.identityKey])).rows[0].result);
    expect(legacy).toMatchObject({ cycleNumber: storedCycle, cycleSnapshot: { frozenRevision: `native.purchase-renewal.${revision}`,
      cycle: { nativeRenewalCounter: 1, logicalCycleNumber: 2 } } });
    const projection = JSON.parse(initial);
    expect(projection).toMatchObject({ operationId: claim.operationId, commercialGenerationId: claim.operationId,
      scheduledAt: d.due.scheduledAt, cycleNumber: String(storedCycle), operationFingerprint: claim.operationFingerprint,
      logicalCycle: { activationCycleId: legacy.cycleSnapshot.cycle.activationCycleId, evidenceRef: legacy.cycleSnapshot.cycle.evidenceRef },
      discountTerms: null, shippingTerms: null, linePricing: [] });
    expect(projection.scheduledAt).toMatch(/\.123456Z$/);
    expect(expectFrozenGenerationShape(projection)).toEqual(["lines[].unitAmountMinor"]);
    const noWrites = await allPublicRows(admin);
    for (const [ids, code, message, hint] of [
      [[null, absent], "22023", "subscription_renewal_generation_invalid_input", "Recover both coordinates from the operation owner and recheck the lookup."],
      [[absent, null], "22023", "subscription_renewal_generation_invalid_input", "Recover both coordinates from the operation owner and recheck the lookup."],
      [[absent, claim.operationId], "22023", "subscription_renewal_generation_mismatch", "Recover the original operation and generation binding through its owner and recheck it."],
      [[absent, absent], "22023", "commerce_renewal_operation_not_found", "Verify the selected installation and recover the stored operation through its owner. Recheck the original pair."],
      [["malformed", absent], "22P02", 'invalid input syntax for type uuid: "malformed"', undefined],
    ] as const) {
      const error: unknown = await inherited.query(generationText, [...ids]).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DatabaseError);
      expect(Object.getPrototypeOf(error)).toBe(DatabaseError.prototype);
      expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toStrictEqual(generationErrorKeys);
      expect(error).toMatchObject({ code, message, hint, constraint: undefined });
      expect(await allPublicRows(admin)).toEqual(noWrites);
    }
    const peer = await admin.connect();
    try {
      await peer.query("BEGIN");
      await peer.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [claim.operationId]);
      const underLock = await transaction(async db => {
        await db.query("SET TRANSACTION READ ONLY");
        await db.query("SET LOCAL lock_timeout='750ms'");
        await db.query("SET LOCAL TIME ZONE 'Etc/GMT-9'");
        return (await db.query(generationText, [claim.operationId.toUpperCase(), claim.operationId])).rows[0].projection;
      }, inherited);
      expect(underLock).toBe(initial);
    } finally { await peer.query("ROLLBACK"); peer.release(); }
    expect(await allPublicRows(admin)).toEqual(noWrites);

    const takeover = await d.input.store.claimDue({ snapshot, workerId: "takeover", now: later });
    expect(takeover).toMatchObject({ operationId: claim.operationId, claimGeneration: 2, acquired: true });
    expect(takeover.claimToken).not.toBe(claim.claimToken);
    const afterTakeover = (await inherited.query(generationText, pair)).rows[0].projection;
    expect(JSON.parse(afterTakeover).cycleNumber).toBe(String(storedCycle));
    expect(afterTakeover).toBe(initial);
    const deliveredAt = days(d.due.scheduledAt, 7);
    const arrival = fulfillment.createPostgresDeliveryAlignmentPort(executor);
    expect(await arrival.recordArrival({ requestKey: `delivery:${shipmentId}`, parcelRef: shipmentId, deliveredAt,
      evidenceRef: `evidence:${shipmentId}` })).toMatchObject({ disposition: "aligned", nextCycleAt: days(deliveredAt, 28) });
    const moved = await allPublicRows(admin);
    expect((await inherited.query(generationText, pair)).rows[0].projection).toBe(initial);
    expect(JSON.parse((await inherited.query(rawReadback, [claim.identityKey])).rows[0].result))
      .toMatchObject({ operationId: claim.operationId, identityKey: claim.identityKey, claimGeneration: 2, cycleSnapshot: { scheduledAt: d.due.scheduledAt } });
    expect(await allPublicRows(admin)).toEqual(moved);
  } finally { await inherited.end(); }
}, 30_000);

async function generationAcl(owner: Pool, signature = frozenGenerationSignature) {
  const info = (await owner.query(`SELECT p.proowner::regrole::text AS owner, p.prosecdef AS definer,
    p.provolatile AS volatility, p.proconfig AS config,
    (SELECT jsonb_agg(jsonb_build_array(grantee::regrole::text,privilege_type,is_grantable) ORDER BY grantee::regrole::text)
      FROM aclexplode(p.proacl)) AS acl
    FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [signature])).rows;
  return info;
}

it("checks exact generation ACLs on a native installation without the service role", async () => {
  const container = await runPostgresContainer({ name: `renewal-bare-${process.pid}`, password: randomUUID() });
  const owner = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const { baseline, forward } = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
    const boundary = forward.findIndex(unit => renewalTemplateForward.test(unit.file));
    expect(boundary).toBeGreaterThan(0);
    for (const { file } of [baseline, ...forward.slice(0, boundary + 1)]) await owner.query(readFileSync(file, "utf8"));
    await owner.query("CREATE ROLE renewal_unrelated NOLOGIN");
    expect((await owner.query("SELECT to_regrole('service_role') AS service")).rows).toEqual([{ service: null }]);
    expect(await generationAcl(owner)).toEqual([{ owner: "postgres", definer: false, volatility: "s",
      config: ["search_path=pg_catalog, pg_temp"], acl: [["postgres", "EXECUTE", false]] }]);
    expect(await generationAcl(owner, staleSnapshotSignature)).toEqual([{ owner: "postgres", definer: false, volatility: "s",
      config: ["search_path=pg_catalog, pg_temp"], acl: [["postgres", "EXECUTE", false]] }]);
    expect((await owner.query(`SELECT rolname FROM pg_roles WHERE NOT rolsuper AND has_function_privilege(oid,$1,'EXECUTE')`,
      [frozenGenerationSignature])).rows).toEqual([]);
    const id = randomUUID();
    await expect(owner.query(generationText, [id, id])).rejects.toMatchObject({ code: "22023", message: "commerce_renewal_operation_not_found" });
  } finally { await closePostgres(container, owner); }
}, postgresSetupTimeoutMs);

it("upgrades occupied v1 and retained v2 roots with exact legacy bytes and one private signature", async () => {
  await withOccupiedRenewalPrefix(async target => {
    const { owner, db, applyForward } = target;
    const withTransaction: typeof transaction = work => transaction(work, db);
    const codec = api.createNativeRenewalCodec(), store = api.createPostgresRenewalStore(db, codec, withTransaction);
    const graphs: { claim: RenewalReadback; wire: Record<string, unknown>; retained: boolean }[] = [];
    for (const retained of [false, true]) {
      const f = await purchase(true, true, at, target);
      const activation = await api.activateNativePurchaseWithRenewal(db, { ...f, facts: { ...facts,
        ...(retained ? { renewalTerms: { version: "native.renewal-terms.v1" as const, minimumPayableMinor: 23, normalCadenceDays: [30],
          shippingTerms: { version: "shipping-threshold.v1" as const, currency: "XXX", flatMinor: 37, freeThresholdMinor: 150 },
          starterPack: { schemaVersion: "1" as const, starterIntervalDays: 28, basisTemplateVersion: 777,
            delivery2: { discountBps: 2500, discountMinor: 51, basisSubtotalMinor: 200 }, graduation: { cadenceDays: 30,
              lines: [{ sku: facts.lines[0]!.sku, qty: 2, sortOrder: 0, isAddon: false,
                quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 200 } } }] } } } } : {}) } });
      const due = (await store.listDue(100, now)).find(row => row.subscriptionId === String(activation.activation.subscriptionId))!;
      expect(due).toBeDefined();
      const snapshot = await store.buildCycleSnapshots(due);
      const claim = await store.claimDue({ snapshot, now, workerId: "renewal-witness" });
      expect(claim.acquired).toBe(true);
      expect(await inventory.createPostgresRenewalReservationPort(db).reserve({ operationId: claim.operationId,
        claimToken: claim.claimToken, now })).toMatchObject({ reserved: true });
      let firstPrepare: string | undefined;
      const incumbentSettlement = api.createPostgresRenewalSettlementPort(db, codec, work => withTransaction(tx => work({
        async query(sql, values) {
          if (!sql.includes("public.commerce_prepare_subscription_renewal(")) return tx.query(sql, values);
          await tx.query("SET LOCAL TIME ZONE 'UTC'");
          const result = await tx.query(`WITH result AS MATERIALIZED (${sql}) SELECT response,response::text AS raw FROM result`, values);
          firstPrepare = String(result.rows[0]?.raw);
          return result;
        },
      })));
      const prepared = await incumbentSettlement.prepareRenewal({ operationId: claim.operationId, claimToken: claim.claimToken, now });
      expect(firstPrepare).toBeDefined();
      expect(JSON.parse(firstPrepare!)).toMatchObject({ replayed: false, orderId: prepared.orderId, operationId: claim.operationId });
      expect((await owner.query(`SELECT o.total_amount_minor::int AS total,
        (SELECT sum(promotion_discount_allocated_minor)::int FROM public.commerce_order_items WHERE order_id=o.id) AS discount,
        (SELECT sum(amount_minor)::int FROM public.commerce_order_adjustments WHERE order_id=o.id) AS shipping
        FROM public.commerce_orders o WHERE id=$1`, [prepared.orderId])).rows)
        .toEqual([{ total: retained ? 186 : 200, discount: retained ? 51 : null, shipping: retained ? 37 : null }]);
      graphs.push({ claim, wire: codec.encode(claim.cycleSnapshot), retained });
    }

    const replay = () => withTransaction(async tx => {
      await tx.query("SET LOCAL TIME ZONE 'UTC'");
      async function raw(sql: string, values: unknown[]) {
        const value = (await tx.query(sql, values)).rows[0]?.result;
        if (typeof value !== "string") throw new Error("Expected raw PostgreSQL JSONB text");
        return value;
      }
      const results: { stored: string; claimReplay: string; prepareReplay: string; readback: string }[] = [];
      for (const { claim, wire } of graphs) {
        const stored = await raw("SELECT cycle_snapshot::text AS result FROM public.subscription_renewal_operations WHERE id=$1", [claim.operationId]);
        const claimReplay = await raw(rawClaim, [claim.identityKey, claim.operationFingerprint, JSON.stringify(wire), now]);
        const prepareReplay = await raw(rawPrepare, [claim.operationId, claim.claimToken, now]);
        const readback = await raw(rawReadback, [claim.identityKey]);
        expect(JSON.parse(claimReplay)).toMatchObject({ claimToken: claim.claimToken, replayed: true, reason: "lease_active" });
        expect(JSON.parse(prepareReplay)).toMatchObject({ replayed: true, operationId: claim.operationId });
        expect(JSON.parse(readback).cycleSnapshot).toEqual(wire);
        expect(JSON.parse(stored)).toEqual(wire);
        results.push({ stored, claimReplay, prepareReplay, readback });
      }
      return results;
    });
    const definitions = async () => (await owner.query(`SELECT p.oid::regprocedure::text AS name,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p') ORDER BY 1`)).rows;
    const relationAcl = async () => (await owner.query(`SELECT relname,relacl::text,relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname`)).rows;
    const applicationRows = async () => {
      const rows = await allPublicRows(owner);
      delete rows.platform_schema_migrations;
      return rows;
    };
    const rows = await applicationRows(), routines = await definitions(), relations = await relationAcl();
    const before = await replay();
    expect(await applicationRows()).toEqual(rows);
    expect(await generationAcl(owner)).toEqual([]);
    expect(await applyForward()).toEqual({ applied: [generationForward] });
    expect(await applyForward()).toEqual({ applied: [] });
    expect(await replay()).toEqual(before);
    const after = await definitions();
    expect(after.filter(row => row.name.startsWith("subscription_read_frozen_renewal_generation("))).toHaveLength(1);
    expect(after.filter(row => !row.name.startsWith("subscription_read_frozen_renewal_generation("))).toEqual(routines);
    expect(await relationAcl()).toEqual(relations);
    expect(await generationAcl(owner)).toEqual([{ owner: "postgres", definer: false, volatility: "s", config: ["search_path=pg_catalog, pg_temp"],
      acl: [["postgres", "EXECUTE", false], ["service_role", "EXECUTE", false]] }]);
    for (const { claim, retained } of graphs) {
      const pair = [claim.operationId, claim.operationId];
      const result = (await db.query(generationText, pair)).rows[0].projection;
      expect(JSON.parse(result)).toMatchObject({ operationId: claim.operationId, operationFingerprint: claim.operationFingerprint,
        shippingTerms: retained ? { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 37, freeThresholdMinor: 150 } : null });
      expect(await withTransaction(async tx => {
        await tx.query("SET LOCAL ROLE service_role");
        expect((await tx.query("SELECT current_user")).rows).toEqual([{ current_user: "service_role" }]);
        return (await tx.query(generationText, pair)).rows[0].projection;
      })).toBe(result);
    }
    const { operationId } = graphs[0]!.claim, pair = [operationId, operationId];
    for (const role of ["anon", "authenticated"]) {
      await expect(withTransaction(async tx => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        await tx.query(generationText, pair);
      })).rejects.toMatchObject({ code: "42501", message: "permission denied for function subscription_read_frozen_renewal_generation" });
    }
    const loginPassword = randomUUID();
    await owner.query(`CREATE ROLE renewal_unrelated LOGIN PASSWORD '${loginPassword}';
      ALTER ROLE openlup_catalog_publication PASSWORD '${loginPassword}'`);
    for (const role of ["openlup_catalog_publication", "renewal_unrelated"]) {
      const url = new URL(target.connectionString); url.username = role; url.password = loginPassword;
      const restricted = new Pool({ connectionString: url.toString() });
      try {
        expect((await restricted.query("SELECT current_user,session_user")).rows).toEqual([{ current_user: role, session_user: role }]);
        await expect(restricted.query(generationText, pair)).rejects.toMatchObject({
          code: "42501", message: "permission denied for function subscription_read_frozen_renewal_generation",
        });
      } finally { await restricted.end(); }
    }
    expect(await applicationRows()).toEqual(rows);
  });
}, postgresSetupTimeoutMs);

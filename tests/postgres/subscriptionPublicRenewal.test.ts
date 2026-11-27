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
  retry?: ReturnType<typeof retryDriver>["options"], batchLimit = 7) {
  const unused = async (): Promise<never> => { throw new Error("unexpected_retry_on_stock_fixture"); };
  const queries = vi.fn<typeof executor.query>((sql, values) => dbPool.query(sql, values));
  const prepare = vi.fn(async (db: Parameters<typeof settlement>[1], request: Parameters<ReturnType<typeof settlement>["prepareRenewal"]>[0]) =>
    api.createPostgresRenewalSettlementPort(db ?? dbPool, d.codec, transact).prepareRenewal(request));
  const native = api.createNativeSubscriptionBinding({ enabled: true, batchLimit, population: `public-renewal:${d.due.subscriptionId}`, executor: { query: queries },
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
  providerBacked: boolean | string = false) {
  const f = await purchase(true, true, paidAt, target);
  let renewalFacts = facts;
  if (providerBacked) {
    const provider = typeof providerBacked === "string" ? providerBacked : webhookProvider;
    const methodRef = `pm_${f.clientId}`, payerAccountRef = `cus_${f.clientId}`;
    const method = await payments.createPostgresPaymentMethodStore(target.db).upsert({ key: `method:${f.clientId}`,
      clientId: f.clientId, subscriptionId: null, provider, methodKind: "card", customer: payerAccountRef,
      reference: methodRef, mandate: null, status: "active", active: true, expiresAt: null, consent: {}, payload: {} });
    renewalFacts = { ...facts, settlementChannelKey: provider, payerAccountRef, methodRef, methodEvidenceRef: method.id };
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
  expect((await admin.query("SELECT renewal_operation_id FROM public.subscription_renewal_upgrade_cohort WHERE renewal_operation_id=$1",
    [claim.operationId])).rows).toEqual([]);
  expect((await renewalUpgradeReport(admin)).some(row => row.operation_id === claim.operationId)).toBe(false);

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

async function parcel(orderId: string, db = executor) {
  // Parcel facts use the bounded writer and the installation's synthetic port.
  const spine = fulfillment.createPostgresFulfillmentShipmentSpinePort(db, { portKey: "g7-parcels" });
  return (await spine.createShipment({ idempotencyKey: `parcel:${orderId}`, orderId, requestedAt: at })).shipmentId;
}

async function grantArrivalAlignment(role: "renewal_column_arrival" | "upgrade_alignment_parent", owner = admin) {
  await owner.query(`GRANT EXECUTE ON FUNCTION public.subscription_delivery_alignment_get_mode(),
    public.subscription_delivery_alignment_upsert_case(uuid,uuid,uuid,uuid,integer,text,text,timestamptz,text) TO ${role};
    GRANT UPDATE (next_cycle_at,updated_at) ON public.subscriptions TO ${role};
    GRANT INSERT (shipment_id,predecessor_order_id,subscription_id,predecessor_cycle_id,predecessor_cycle_number,
      captured_mode,state,evidence_kind,observed_next_cycle_at,manual_review_reason,metadata)
      ON public.subscription_delivery_alignment_cases TO ${role};
    GRANT UPDATE (updated_at,observed_next_cycle_at,evidence_kind,state,captured_mode,manual_review_reason,
      delivered_at,aligned_next_cycle_at,aligned_at) ON public.subscription_delivery_alignment_cases TO ${role};
    GRANT SELECT ON public.fulfillment_shipments,public.subscription_delivery_alignment_cases,public.subscription_delivery_alignment_control,
      public.subscription_renewal_terms,public.subscription_renewal_operations,public.subscription_dunning_cases,
      public.subscription_delivery_alignment_cycles TO ${role}`);
}

async function columnGrantedArrivalLogin() {
  const role = "renewal_column_arrival", password = randomUUID();
  await admin.query(`CREATE ROLE renewal_column_arrival LOGIN PASSWORD '${password}';
    GRANT USAGE ON SCHEMA public TO renewal_column_arrival;
    GRANT EXECUTE ON FUNCTION public.fulfillment_record_alignment_arrival(text,uuid,timestamptz,text) TO renewal_column_arrival;
    GRANT SELECT,INSERT ON public.subscription_delivery_alignment_arrivals TO renewal_column_arrival;
    GRANT UPDATE (delivered_at,updated_at) ON public.fulfillment_shipments TO renewal_column_arrival;
    GRANT SELECT ON public.commerce_orders,public.subscription_cycles,public.subscriptions TO renewal_column_arrival`);
  await grantArrivalAlignment(role);
  const url = new URL(loginConnection(runtimeUrl, role));
  url.password = password;
  return new Pool({ connectionString: url.toString() });
}

const deliveryArrivalCases = [
  { parcels: "single", shadow: false, retained: false, columnGrants: true },
  { parcels: "single", shadow: true, retained: false, columnGrants: false },
  { parcels: "split", shadow: false, retained: false, columnGrants: false },
  { parcels: "split", shadow: true, retained: false, columnGrants: false },
  { parcels: "replacement", shadow: false, retained: false, columnGrants: false },
  { parcels: "replacement", shadow: true, retained: false, columnGrants: false },
  { parcels: "single", shadow: false, retained: true, columnGrants: false },
] as const;

it.each(deliveryArrivalCases)("aligns after a mounted stale refusal (parcels=$parcels, shadow=$shadow, retained=$retained, columnGrants=$columnGrants)", async ({ parcels, shadow, retained, columnGrants }) => {
  const f = await renewalPurchase(retained), d = await deps(f.subscriptionId, "succeeded");
  const held = await d.input.store.buildCycleSnapshots(d.due);
  const original = await parcel(f.orderId);
  const addSuccessor = async (sequence: number) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key,
      sequence_no,replaces_shipment_id,replacement_reason) VALUES($1,$2,'g7-parcels','3pl',$3,$4,$5,'lost')`,
    [id, f.orderId, `successor:${id}`, sequence, original]);
    return id;
  };
  // A split has two current parcels superseding the original.
  const earlier = parcels === "split" ? await addSuccessor(1) : null;
  let final = parcels === "split" ? await addSuccessor(2) : original;
  if (shadow) {
    await rpc("subscription_delivery_alignment_set_mode", ["shadow"], admin);
    const spine = fulfillment.createPostgresFulfillmentShipmentSpinePort(executor, { portKey: "g7-parcels" });
    await spine.raiseException({ idempotencyKey: `shadow:${original}`, shipmentId: original, reason: "provider_rejected" });
  }
  if (parcels === "replacement") final = await addSuccessor(1);
  const cases = async () => (await runtime.query<{ state: string }>(`SELECT state
    FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1`, [f.orderId])).rows.map(row => row.state);
  const before = await cases();
  expect(before).toEqual(Array.from({ length: shadow ? (parcels === "split" ? 3 : 1) : 0 }, () => "shadow"));

  await resizeForRenewal(f);
  await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], admin);
  let clock = now;
  const refusals: unknown[] = [];
  const mounted = binding(d, () => clock, async work => {
    try { return await transaction(work); }
    catch (error) { refusals.push(error); throw error; }
  });
  const [job] = mounted.contributions[0].schedules!;
  vi.spyOn(d.codec, "freeze").mockReturnValueOnce(held);
  expect(await job.run()).toMatchObject({ renewals: [{ status: "error", reason: "renewal_processing_failed" }] });
  expect(refusals).toMatchObject([staleClaim]);
  expect(mounted.queries.mock.calls.some(([sql]) => sql.includes("SELECT public.subscription_delivery_alignment_admit_renewal("))).toBe(false);
  expect(await cases()).toEqual(before);

  const originalDue = new Date(held.scheduledAt).toISOString();
  const deliveredAt = days(originalDue, 7), shifted = days(deliveredAt, facts.cadenceDays);
  const due = async () => (await runtime.query<{ next_cycle_at: Date }>(
    "SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0]!.next_cycle_at.toISOString();
  const noOldOccurrence = async () => {
    expect((await runtime.query(`SELECT EXISTS (
      SELECT FROM public.subscription_renewal_operations WHERE subscription_id=$1 AND scheduled_at=$2
      UNION ALL SELECT FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2
    ) AS found`, [f.subscriptionId, originalDue])).rows).toEqual([{ found: false }]);
  };
  await noOldOccurrence();
  expect(d.execute).not.toHaveBeenCalled();

  const direct = columnGrants ? await columnGrantedArrivalLogin() : null;
  try {
    if (direct) {
      expect((await direct.query(`SELECT session_user, current_user,
        pg_has_role(current_user,'service_role','MEMBER') AS service_member,
        has_table_privilege('public.subscriptions','UPDATE') AS subscription_update,
        has_table_privilege('public.subscription_delivery_alignment_cases','UPDATE') AS case_update`)).rows)
        .toEqual([{ session_user: "renewal_column_arrival", current_user: "renewal_column_arrival",
          service_member: false, subscription_update: false, case_update: false }]);
      expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([]);
    }
    const arrival = fulfillment.createPostgresDeliveryAlignmentPort(direct ?? executor);
    const evidence = (parcelRef: string, arrivalTime: string) =>
      ({ requestKey: `verified:${parcelRef}`, parcelRef, deliveredAt: arrivalTime, evidenceRef: `evidence:${parcelRef}` as const });
    if (earlier) {
      await arrival.recordArrival(evidence(earlier, days(deliveredAt, -1)));
      expect(await due()).toBe(originalDue);
    }
    const verified = evidence(final, deliveredAt);
    expect(await arrival.recordArrival(verified)).toMatchObject({ disposition: "aligned", nextCycleAt: shifted });
    expect(await due()).toBe(shifted);
    expect(await arrival.recordArrival(verified)).toMatchObject({ replayed: true, nextCycleAt: shifted });
    expect(await arrival.recordArrival({ ...verified, requestKey: `older:${final}`, deliveredAt: days(deliveredAt, -1) }))
      .toMatchObject({ nextCycleAt: shifted });
    expect(await due()).toBe(shifted);
    if (final !== original) {
      expect((await runtime.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1", [original])).rows)
        .toEqual([{ delivered_at: null }]);
    }
  } finally {
    if (direct) {
      await direct.end();
      await admin.query("DROP OWNED BY renewal_column_arrival; DROP ROLE renewal_column_arrival");
    }
  }

  clock = days(deliveredAt, 1 / 1440);
  expect(await job.run()).toMatchObject({ renewals: [] });
  expect(await due()).toBe(shifted);
  await noOldOccurrence();
  expect(d.execute).not.toHaveBeenCalled();

  clock = shifted;
  expect(await job.run()).toMatchObject({ renewals: [{ status: "succeeded" }] });
  expect(await job.run()).toMatchObject({ renewals: [] });
  expect(await due()).toBe(days(shifted, facts.cadenceDays));
  await noOldOccurrence();
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
const dueClaimSignature = "subscription_claim_due_renewal(text,text,jsonb,text,integer,timestamptz)";
const deliveryTriggerSignature = "subscription_delivery_alignment_on_delivery()";
const arrivalSignature = "fulfillment_record_alignment_arrival(text,uuid,timestamptz,text)";
type UpgradeTarget = Parameters<Parameters<typeof withOccupiedRenewalPrefix>[0]>[0];
const withTemplateUpgrade = (work: (target: UpgradeTarget) => Promise<void>) =>
  withOccupiedRenewalPrefix(work, file => renewalTemplateForward.test(file));
const upgradeTransaction = (db: Pool): typeof transaction => work => transaction(work, db);

async function applyTemplateForwardWithCustomGrants(owner: Pool) {
  // The qualified runner restricts catalogue access to its selected principals.
  // Apply the bundled SQL with the existing custom grants in place.
  const { forward } = selectPlatformMigrationManifest(
    JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
  const { file } = forward.find(unit => renewalTemplateForward.test(unit.file))!;
  await owner.query(readFileSync(file, "utf8"));
}

function predecessorRetryTarget(db: Pool) {
  return { executor: db, transaction: upgradeTransaction(db) };
}

async function upgradeRenewal(target: UpgradeTarget, options: {
  retained?: boolean; scenario?: "succeeded" | "declined" | "ambiguous"; edited?: boolean;
  paidAt?: string; claimAt?: string; providerBacked?: boolean | string;
} = {}) {
  const claimAt = options.claimAt ?? now;
  const f = await renewalPurchase(options.retained, target, options.paidAt, options.providerBacked);
  const d = await deps(f.subscriptionId, options.scenario ?? "succeeded", claimAt, target.db);
  const held = await d.input.store.buildCycleSnapshots(d.due);
  const snapshot = await bindRenewalDestination(d, held, target.db);
  if (options.edited !== false) await resizeForRenewal(f, upgradeTransaction(target.db));
  const claim = () => api.createPostgresRenewalStore(target.db, d.codec)
    .claimDue({ snapshot, workerId: "before-upgrade", now: claimAt });
  return { f, d, held, snapshot, claim };
}

async function reserveIncumbent(d: Awaited<ReturnType<typeof deps>>, claim: RenewalReadback) {
  expect(await d.input.inventory.reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now }))
    .toMatchObject({ reserved: true });
}

it("bills a fresh pre-forward claim exactly once at its frozen price after a later accepted edit", async () => {
  await withTemplateUpgrade(async target => {
    const { db, applyForward } = target, transact = upgradeTransaction(db);
    const { f, d, claim } = await upgradeRenewal(target, { edited: false });
    const operation = await claim();
    await applyForward();
    await resizeForRenewal(f, transact);
    const tick = binding(d, () => later, transact, db);
    expect(await tick.services.run()).toMatchObject({ renewals: [{ operationId: operation.operationId, status: "succeeded" }] });
    expect(await tick.services.run()).toMatchObject({ renewals: [] });
    expect(d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([200]);
    const bill = (await d.input.store.readRenewal(operation.identityKey))!;
    expect(await renewalAmounts(db, bill.orderId!)).toEqual([{ order: 200, intent: 200 }]);
    expect((await target.owner.query("SELECT renewal_operation_id FROM public.subscription_renewal_upgrade_cohort WHERE renewal_operation_id=$1",
      [operation.operationId])).rows).toEqual([]);
    expect(await renewalUpgradeReport(target.owner)).toEqual([]);
    const next = (await d.input.store.listDue(100, days(later, 30))).find(row => row.subscriptionId === f.subscriptionId)!;
    expect(await d.input.store.buildCycleSnapshots(next)).toMatchObject({
      templateSnapshot: { version: 2 }, pricingSnapshot: { totalAmountMinor: 300 },
    });
  });
}, postgresSetupTimeoutMs);

function runPreForwardRenewal(entry: Awaited<ReturnType<typeof upgradeRenewal>>, when = now) {
  const { d, snapshot, claim } = entry;
  return api.runOneAutomaticSubscriptionRenewal({ ...d.input, store: {
    ...d.input.store, buildCycleSnapshots: async () => snapshot, claimDue: claim,
  } }, d.due, when);
}

it("captures stale terminal history but excludes its settled graph from the report", async () => {
  await withTemplateUpgrade(async target => {
    const { db, applyForward } = target, entry = await upgradeRenewal(target);
    vi.spyOn(entry.d.codec, "freeze").mockReturnValueOnce(entry.held);
    const retry = retryDriver(entry.d, "ambiguous", now, undefined, predecessorRetryTarget(db));
    const mounted = binding(entry.d, () => now, upgradeTransaction(db), db, retry.options);
    expect(await mounted.services.run()).toMatchObject({ renewals: [{ subscriptionId: entry.f.subscriptionId, status: "succeeded" }] });
    const settled = (await entry.d.input.store.readRenewal(entry.d.codec.identity(entry.held)))!;
    expect(entry.d.execute.mock.calls.map(([request]) => request.amountMinor)).toEqual([200]);
    expect(await renewalAmounts(db, settled.orderId!)).toEqual([{ order: 200, intent: 200 }]);
    await applyForward();
    expect((await target.owner.query(`SELECT state, cohort.unknown_provenance
      FROM public.subscription_renewal_operations o
      JOIN public.subscription_renewal_upgrade_cohort cohort ON cohort.renewal_operation_id=o.id
      WHERE o.id=$1`, [settled.operationId])).rows)
      .toEqual([{ state: "succeeded", unknown_provenance: false }]);
    expect(await renewalUpgradeReport(target.owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

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

type UpgradeReportHooks = { beforeCut?: () => Promise<void>; afterCut?: () => Promise<void> };
const upgradeGuide = () => readFileSync("packages/core/docs/guide/upgrade/database-migrations.md", "utf8");
const guideSql = (heading: string) => upgradeGuide().split(heading)[1]!.split("```sql\n")[1]!.split("```")[0]!.trim();

function upgradeReportStatements() {
  const statements = guideSql("## Reconcile stale native renewals").split(/;\s*(?:\n|$)/u).filter(Boolean);
  expect(statements).toHaveLength(5);
  return statements as [string, string, string, string, string];
}

async function readRenewalUpgradeReport(db: Pool, hooks: UpgradeReportHooks = {}) {
  const [begin, readCut, population, alignmentCheck, commit] = upgradeReportStatements();
  const client = await db.connect();
  try {
    await client.query(begin);
    await hooks.beforeCut?.();
    expect((await client.query(readCut)).rows).toEqual([{ cut_snapshot: expect.stringMatching(/^\d+:\d+:/u),
      cut_statement_started_at: expect.any(Date) }]);
    expect((await client.query("SHOW transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
    expect((await client.query("SHOW transaction_isolation")).rows).toEqual([{ transaction_isolation: "repeatable read" }]);
    await hooks.afterCut?.();
    const { rows: operations } = await client.query(population);
    const { rows: alignment } = await client.query(alignmentCheck);
    await client.query(commit);
    return { operations, alignment };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function renewalUpgradeReport(db: Pool, hooks?: UpgradeReportHooks) {
  return (await readRenewalUpgradeReport(db, hooks)).operations;
}

function ownerRepairSql(subscriptionId: string) {
  return guideSql("### Repair a pending delivery alignment")
    .replace("<arrival time zone>", "UTC").replace("<subscription ID>", subscriptionId)
    .replace("/* Paste the alignment SELECT here. */", upgradeReportStatements()[3]);
}

async function repairAlignment(owner: Pool, subscriptionId: string, sql = ownerRepairSql(subscriptionId)) {
  const client = await owner.connect();
  try { await client.query(sql); }
  finally { await client.query("ROLLBACK"); client.release(); }
}

function reportGap(subscription_id: string, shipment_id: string, facts: object = {}) {
  return expect.objectContaining({ subscription_id, shipment_id, reason: "late_arrival_alignment_pending", ...facts });
}

async function alignmentState(owner: Pool, subscriptionId: string) {
  return (await owner.query(`SELECT next_cycle_at, updated_at,
    (SELECT COALESCE(jsonb_agg(c ORDER BY c.id),'[]') FROM public.subscription_delivery_alignment_cases c
      WHERE c.subscription_id=s.id) AS cases
    FROM public.subscriptions s WHERE id=$1`, [subscriptionId])).rows[0];
}

function recordArrival(shipment: string, deliveredAt: string, db: Parameters<typeof rpc>[2] = executor) {
  return rpc("fulfillment_record_alignment_arrival", [`verified:${shipment}`, shipment, deliveredAt, `evidence:${shipment}`], db);
}

it("uses persisted gaps across column INSERT, inherited authority, replay and owner repair", async () => {
  const f = await renewalPurchase(), d = await deps(f.subscriptionId, "succeeded");
  const originalDue = d.due.scheduledAt, deliveredAt = days(originalDue, 1), shifted = days(deliveredAt, facts.cadenceDays);
  const held = await d.input.store.buildCycleSnapshots(d.due);
  await resizeForRenewal(f);
  await expect(runtime.query(rawClaim, claimWire(d, held))).rejects.toMatchObject(staleClaim);
  await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], admin);
  const role = "upgrade_alignment_parent";
  await admin.query(`CREATE ROLE upgrade_alignment_parent; CREATE ROLE upgrade_arrival_member INHERIT;
    GRANT upgrade_alignment_parent TO upgrade_arrival_member;
    GRANT SELECT ON public.commerce_orders, public.subscription_cycles, public.subscriptions TO upgrade_arrival_member;
    GRANT INSERT (id, order_id, port_key, provider_type, create_idempotency_key, delivered_at)
      ON public.fulfillment_shipments TO upgrade_arrival_member`);
  try {
    await grantArrivalAlignment(role);
    await admin.query("REVOKE UPDATE (next_cycle_at) ON public.subscriptions FROM upgrade_alignment_parent");
    const shipment = randomUUID(), before = await alignmentState(admin, f.subscriptionId);
    const insert = () => transaction(async tx => {
      await tx.query("SET LOCAL ROLE upgrade_arrival_member");
      expect((await tx.query(`SELECT has_table_privilege('public.fulfillment_shipments','INSERT') AS full_insert,
        has_column_privilege('public.fulfillment_shipments','delivered_at','UPDATE') AS arrival_update`)).rows)
        .toEqual([{ full_insert: false, arrival_update: false }]);
      await tx.query(`INSERT INTO public.fulfillment_shipments(id, order_id, port_key, provider_type, create_idempotency_key, delivered_at)
        VALUES($1::uuid,$2,'g7-parcels','3pl',($1::uuid)::text,$3)`, [shipment, f.orderId, deliveredAt]);
    }, admin);
    expect(await readRenewalUpgradeReport(admin, { afterCut: insert })).toEqual({ operations: [], alignment: [] });
    expect(await alignmentState(admin, f.subscriptionId)).toEqual(before);
    const listed = reportGap(f.subscriptionId, shipment, { observed_due_at: new Date(originalDue),
      latest_delivery_at: new Date(deliveredAt), occupying_operation_id: null });
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([listed]);
    await grantArrivalAlignment(role);
    await admin.query("REVOKE INSERT (id, order_id, port_key, provider_type, create_idempotency_key, delivered_at) ON public.fulfillment_shipments FROM upgrade_arrival_member");
    // Already recorded chronology stays unchanged even when the next writer has full authority.
    expect(await recordArrival(shipment, deliveredAt, runtime)).toMatchObject({ replayed: false });
    expect(await alignmentState(admin, f.subscriptionId)).toEqual(before);
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([listed]);
    await repairAlignment(admin, f.subscriptionId);
    const repaired = await alignmentState(admin, f.subscriptionId);
    expect(repaired).toMatchObject({ next_cycle_at: new Date(shifted),
      cases: [{ shipment_id: shipment, state: "aligned", evidence_kind: "overdue_renewal" }] });
    await repairAlignment(admin, f.subscriptionId);
    expect(await alignmentState(admin, f.subscriptionId)).toEqual(repaired);
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([]);
    expect(await binding(d, () => deliveredAt).services.run()).toMatchObject({ renewals: [] });
    expect(await binding(d, () => shifted).services.run()).toMatchObject({ renewals: [{ status: "succeeded" }] });
    expect(d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([300]);
  } finally {
    await admin.query("DROP OWNED BY upgrade_arrival_member, upgrade_alignment_parent; DROP ROLE upgrade_arrival_member, upgrade_alignment_parent");
  }
}, 30_000);

it("checks delivery effects under the authority of the tracking command owner", async () => {
  const signature = "public.fulfillment_operator_record_tracking(text,uuid,jsonb,uuid)";
  const withoutTracking = "public.fulfillment_intake_record_delivery_without_tracking(text,uuid,uuid)";
  const deliveredAt = days(now, 1), shifted = new Date(days(deliveredAt, facts.cadenceDays));
  const subjects = await Promise.all([renewalPurchase(), renewalPurchase(), renewalPurchase()]);
  const [qualified, deficient, delegated] = await Promise.all(subjects.map(async f => ({ ...f, shipment: await parcel(f.orderId) })));
  await admin.query("UPDATE public.fulfillment_shipments SET status='handed_over',created_at=$2 WHERE id=ANY($1::uuid[])",
    [[qualified!.shipment, deficient!.shipment, delegated!.shipment], now]);
  await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], admin);
  const client = await admin.connect();
  try {
    await client.query(`BEGIN;
      CREATE ROLE upgrade_tracking_caller; CREATE ROLE upgrade_tracking_owner BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO upgrade_tracking_caller,upgrade_tracking_owner;
      GRANT pg_read_all_data TO upgrade_tracking_owner;
      GRANT UPDATE (updated_at) ON public.subscriptions,public.subscription_delivery_alignment_cases TO upgrade_tracking_owner;
      GRANT UPDATE (status,delivered_at,updated_at) ON public.fulfillment_shipments TO upgrade_tracking_owner;
      GRANT INSERT ON public.fulfillment_operator_receipts,public.fulfillment_shipment_operations,
        public.subscription_delivery_alignment_arrivals,public.outbox_events TO upgrade_tracking_owner;
      GRANT EXECUTE ON FUNCTION public.${arrivalSignature},public.fulfillment_emit_shipment_dispatched(uuid) TO upgrade_tracking_owner;
      GRANT EXECUTE ON FUNCTION ${signature},${withoutTracking} TO upgrade_tracking_caller`);
    const direct = (shipment: string) => rpc("fulfillment_operator_record_tracking",
      [`tracking:${shipment}`, shipment, { status: "delivered", rawEvent: { occurredAt: deliveredAt } }, null], client);
    await client.query("SET LOCAL ROLE upgrade_tracking_caller");
    expect((await client.query(`SELECT has_column_privilege('public.fulfillment_shipments','delivered_at','UPDATE') AS direct`)).rows)
      .toEqual([{ direct: false }]);
    expect(await direct(qualified!.shipment)).toMatchObject({ status: "delivered" });
    await client.query(`RESET ROLE; ALTER FUNCTION ${signature} OWNER TO upgrade_tracking_owner; SET LOCAL ROLE upgrade_tracking_caller`);
    expect(await direct(deficient!.shipment)).toMatchObject({ status: "delivered" });
    await client.query("RESET ROLE");
    const { shipment, orderId } = delegated!, dispatch = randomUUID(), event = randomUUID();
    await client.query(`INSERT INTO public.fulfillment_dispatch_refs
      (id,request_key,shipment_id,order_id,parcel_ref,mode,status,evidence)
      VALUES($1,$4,$2,$3,$4,'live','created','{"providerRef":"fixture-carrier"}')`, [dispatch, shipment, orderId, event]);
    await client.query(`INSERT INTO public.shipment_external_refs(shipment_id,ref_role,provider_kind,external_id)
      VALUES($1,'tracking','fixture-carrier',$2)`, [shipment, event]);
    await rpc("fulfillment_intake_record_observation", [event, shipment, { eventKey: event, trackingRefs: [],
      correlation: { fulfillmentRef: shipment }, intake: { occurredAt: deliveredAt, occurrenceKey: event },
      fact: { providerKind: "fixture-carrier", canonicalStatus: "delivered", occurredAt: deliveredAt,
        rawEvent: { reference: event }, provenance: { source: "provider_webhook", authority: "provider_asserted" } } }, days(deliveredAt, 0.001)], client);
    await client.query(`INSERT INTO public.fulfillment_operator_status_evidence
      (event_key,shipment_id,provider_status,occurred_at,canonical_status,occurrence_key)
      VALUES($1,$2,'delivered',$3,'delivered',$1)`, [event, shipment, deliveredAt]);
    await client.query("SET LOCAL ROLE upgrade_tracking_caller");
    expect(await rpc("fulfillment_intake_record_delivery_without_tracking", [event, dispatch, shipment], client)).toEqual({ readBack: true });
    await client.query("RESET ROLE");
    const { rows: gaps } = await client.query(upgradeReportStatements()[3]);
    expect(gaps).toEqual([deficient!, delegated!].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))
      .map(f => reportGap(f.subscriptionId, f.shipment)));
    expect((await client.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [qualified!.subscriptionId])).rows)
      .toEqual([{ next_cycle_at: shifted }]);
  } finally { await client.query("ROLLBACK"); client.release(); }
}, 30_000);

it.each([true, false])("keeps rewrites outside the report cut (deferred=%s)", async defer => {
  const f = await renewalPurchase(), shipment = await parcel(f.orderId);
  await recordArrival(shipment, days(now, 1), runtime);
  await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], admin);
  const rewrite = () => admin.query("ALTER TABLE public.fulfillment_shipments ADD COLUMN rewrite_witness timestamptz DEFAULT clock_timestamp()");
  const listed = [reportGap(f.subscriptionId, shipment)];
  try {
    const cut = await readRenewalUpgradeReport(admin, { afterCut: async () => { if (!defer) await rewrite(); } });
    expect(cut.alignment).toEqual(defer ? listed : []);
    if (defer) await rewrite();
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual(listed);
  } finally { await admin.query("ALTER TABLE public.fulfillment_shipments DROP COLUMN IF EXISTS rewrite_witness"); }
}, 30_000);

it.each(["deferred", "raced", "already present"])("fences real OMS replacements through owner repair (%s)", async arm => {
  const f = await renewalPurchase(), shipment = await parcel(f.orderId), deliveredAt = days(now, 1);
  const intake = await renewalPurchase(), intakeShipment = await parcel(intake.orderId);
  await recordArrival(shipment, deliveredAt, runtime);
  const actor = randomUUID();
  await admin.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')", [actor]);
  await rpc("fulfillment_capture_parcel_contact", [shipment, { schemaVersion: 1, source: "contact", revision: 1,
    recipientName: "Recipient", contactPhone: "+000001", line1: "Fixture street", city: "Example", postalCode: "00000", country: "ZZ",
    selectedDelivery: { providerKind: "warehouse", deliveryKind: "courier" } }], admin);
  const replace = () => rpc("commerce_oms_request_replacement_shipment",
    [`replacement:${shipment}`, f.orderId, "lost", actor, "warehouse", facts.stockSourceKey, {}], runtime);
  await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], admin);
  const before = await alignmentState(admin, f.subscriptionId);
  if (arm === "already present") {
    await replace();
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([]);
    await repairAlignment(admin, f.subscriptionId);
    expect(await alignmentState(admin, f.subscriptionId)).toEqual(before);
    return;
  }

  expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([reportGap(f.subscriptionId, shipment)]);
  const barrier = await admin.connect();
  let pending: Promise<void> | undefined;
  try {
    await barrier.query("BEGIN; SELECT pg_advisory_xact_lock(71642, 1)");
    pending = repairAlignment(admin, f.subscriptionId, ownerRepairSql(f.subscriptionId).replace(
      "    PERFORM public.subscription_delivery_alignment_upsert_case(",
      "    PERFORM pg_advisory_xact_lock(71642, 1);\n    PERFORM public.subscription_delivery_alignment_upsert_case("));
    void pending.catch(() => {});
    await expect.poll(async () => (await admin.query(`SELECT EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=71642 AND objid=1 AND NOT granted) AS waiting`)).rows,
    { timeout: 10_000 }).toEqual([{ waiting: true }]);
    if (arm === "raced") await replace();
    await recordArrival(intakeShipment, deliveredAt, runtime);
    await barrier.query("COMMIT");
    await pending;
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([]);
    expect(await alignmentState(admin, f.subscriptionId)).toMatchObject({
      next_cycle_at: new Date(days(deliveredAt, facts.cadenceDays)), cases: [{ state: "aligned" }],
    });
    expect((await admin.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE replaces_shipment_id=$1", [shipment])).rows)
      .toEqual(arm === "raced" ? [{ delivered_at: null }] : []);
    if (arm === "deferred") await replace();
  } finally {
    await barrier.query("ROLLBACK");
    await pending?.catch(() => {});
    barrier.release();
  }
}, 30_000);

async function prepareIncumbent(entry: Awaited<ReturnType<typeof upgradeRenewal>>) {
  const op = await entry.claim();
  await reserveIncumbent(entry.d, op);
  const prepared = await entry.d.input.settlement.prepareRenewal({ operationId: op.operationId, claimToken: op.claimToken, now });
  return { ...entry, op, prepared };
}

async function refuseUnprepared(entry: Awaited<ReturnType<typeof upgradeRenewal>>, op: RenewalReadback, occurredAt = now) {
  await entry.d.input.store.refuseBeforePayment({ operationId: op.operationId, claimToken: op.claimToken,
    occurredAt, reason: "upgrade_reconciled" });
}

async function closeOrder({ db, owner }: UpgradeTarget, orderId: string) {
  const actorUserId = randomUUID();
  await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Synthetic operator')", [actorUserId]);
  await createPostgresCommerceOmsPort(db).cancelOrder({ idempotencyKey: `upgrade-close:${orderId}`,
    orderId, reason: "upgrade reconciliation", actorUserId });
}

async function closeUnsent(entry: Awaited<ReturnType<typeof prepareIncumbent>>, target: UpgradeTarget) {
  await entry.d.input.settlement.recordTerminalOutcome({ operationId: entry.op.operationId,
    operationFingerprint: entry.op.operationFingerprint, eventKey: `upgrade-refusal:${entry.op.operationId}`,
    occurredAt: later, outcome: "refused", externalRef: null, reason: "upgrade_reconciled" });
  await closeOrder(target, entry.prepared.orderId);
}

const reportRow = (operation_id: string, reasons: string[], facts: object = {}) =>
  expect.objectContaining({ operation_id, reasons: expect.arrayContaining(reasons), ...facts });

it("lists the claimed, reserved, and unknown legacy cohort until reconciled", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target, transact = upgradeTransaction(db);
    const ordinary = await upgradeRenewal(target), reserved = await upgradeRenewal(target, { retained: true });
    const claim = await ordinary.claim(), reservation = await reserved.claim();
    await reserveIncumbent(reserved.d, reservation);
    const legacy = await upgradeRenewal(target, { edited: false });
    const old = await createPostgresAutomaticRenewalPort(db).buildCycleSnapshots(legacy.d.due);
    const wire = [automaticRenewalIdentity(old.subscriptionId, old.scheduledAt), automaticRenewalFingerprint(old), old];
    const legacyId = JSON.parse((await db.query(rawClaim, [...wire, now])).rows[0].result).operationId;
    await resizeForRenewal(legacy.f, transact);

    const signatures = [
      "commerce_prepare_subscription_renewal(uuid,uuid,timestamptz)",
      "subscription_retry_prepare(uuid,text,jsonb,timestamptz)",
      "payment_provider_attempt_prepare(text,uuid,text,text,text,text,text,jsonb)",
      "payment_simulator_begin_attempt(text,uuid,text,jsonb,timestamptz)",
      "commerce_acknowledge_subscription_renewal_attempt(uuid,text,text,timestamptz)",
    ];
    const owners = async () => (await owner.query(`SELECT name, pg_get_functiondef(('public.'||name)::regprocedure) AS definition,
      proacl, proowner FROM unnest($1::text[]) AS name JOIN pg_proc
      ON pg_proc.oid = ('public.'||name)::regprocedure ORDER BY name`, [signatures])).rows;
    const predecessor = await owners();
    expect(predecessor).toHaveLength(signatures.length);
    const bytes = await frozenOperation(db, claim.operationId);
    await applyForward();
    expect(await owners()).toEqual(predecessor);
    expect((await owner.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='subscription_renewal_upgrade_cohort' ORDER BY ordinal_position`)).rows)
      .toEqual([{ column_name: "renewal_operation_id", data_type: "uuid", is_nullable: "NO" },
        { column_name: "unknown_provenance", data_type: "boolean", is_nullable: "NO" }]);
    expect((await owner.query(`SELECT contype FROM pg_constraint
      WHERE conrelid='public.subscription_renewal_upgrade_cohort'::regclass AND contype IN ('p','f')`)).rows)
      .toEqual([{ contype: "p" }]);
    await expect(db.query("SELECT renewal_operation_id FROM public.subscription_renewal_upgrade_cohort"))
      .rejects.toMatchObject({ code: "42501" });
    const before = await allPublicRows(owner);
    const rows = await renewalUpgradeReport(owner);
    expect(rows.map(row => row.operation_id)).toEqual([claim.operationId, reservation.operationId, legacyId].sort());
    expect(rows).toEqual(expect.arrayContaining([
      reportRow(claim.operationId, ["first_charge"], { operation_state: "claimed" }),
      reportRow(reservation.operationId, ["first_charge"], { operation_state: "reserved", reservation_state: "held" }),
      reportRow(legacyId, ["first_charge", "unknown_provenance"], { frozen_amount_minor: 200 }),
    ]));
    expect(await allPublicRows(owner)).toEqual(before);

    const takeover = JSON.parse((await db.query(rawClaim, claimWire(ordinary.d, ordinary.snapshot, undefined, later))).rows[0].result);
    expect(takeover).toMatchObject({ operationId: claim.operationId, acquired: true, claimGeneration: 2 });
    expect(await frozenOperation(db, claim.operationId)).toEqual(bytes);
    expect((await owner.query("SELECT renewal_operation_id FROM public.subscription_renewal_upgrade_cohort WHERE renewal_operation_id=$1",
      [claim.operationId])).rows).toEqual([{ renewal_operation_id: claim.operationId }]);
    const packet = await captureStore(owner, "renewal-upgrade-source");
    await withRestoredStore(packet, async restored => {
      expect(await renewalUpgradeReport(restored.owner)).toEqual(await renewalUpgradeReport(owner));
    });
    await refuseUnprepared(ordinary, takeover, later);
    await rpc("fulfillment_release_subscription_renewal", [reservation.operationId, reservation.claimToken, "upgrade_reconciled", now], db);
    const legacyReplay = JSON.parse((await db.query(rawClaim, [...wire, now])).rows[0].result);
    expect(legacyReplay).toMatchObject({ operationId: legacyId, replayed: true });
    await rpc("fulfillment_release_subscription_renewal", [legacyId, legacyReplay.claimToken, "upgrade_reconciled", now], db);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports legacy billing with only a shipping reference in the order snapshot", async () => {
  await withTemplateUpgrade(async target => {
    const { db, owner, applyForward } = target;
    const entry = await upgradeRenewal(target, { edited: false });
    const old = await createPostgresAutomaticRenewalPort(db).buildCycleSnapshots(entry.d.due);
    const snapshot = { ...old, orderSnapshot: { shippingAddressRef: entry.snapshot.orderSnapshot.shippingAddressRef } };
    expect(snapshot.orderSnapshot).toEqual({ shippingAddressRef: expect.any(String) });
    const identity = automaticRenewalIdentity(old.subscriptionId, old.scheduledAt);
    const op = JSON.parse((await db.query(rawClaim, [identity, automaticRenewalFingerprint(snapshot), snapshot, now])).rows[0].result);
    expect(op).toMatchObject({ acquired: true });
    await resizeForRenewal(entry.f, upgradeTransaction(db));
    await applyForward();
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(op.operationId, ["first_charge", "unknown_provenance"], {
      frozen_amount_minor: 200,
    })]);

    await reserveIncumbent(entry.d, op);
    const prepared = await entry.d.input.settlement.prepareRenewal({ operationId: op.operationId, claimToken: op.claimToken, now });
    expect(await renewalAmounts(db, prepared.orderId)).toEqual([{ order: 200, intent: 200 }]);
    await mainSettlement(db).recordTerminalOutcome({ operationId: op.operationId,
      operationFingerprint: op.operationFingerprint, eventKey: `upgrade-refusal:${op.operationId}`,
      occurredAt: later, outcome: "refused", externalRef: null, reason: "upgrade_reconciled" });
    await closeOrder(target, prepared.orderId);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports historical billing markers without a usable template version", async () => {
  await withTemplateUpgrade(async target => {
    const { db, owner, applyForward } = target;
    const legacy = createPostgresAutomaticRenewalPort(db);
    const claims: { operationId: string; claimToken: string }[] = [];
    for (const markers of [
      { frozenRevision: "native.purchase-renewal.v1" },
      { templateSnapshot: { version: "1" } },
      { templateSnapshot: { version: 2147483648 } },
    ]) {
      const entry = await upgradeRenewal(target, { edited: false });
      const snapshot = { ...await legacy.buildCycleSnapshots(entry.d.due), ...markers };
      const identity = automaticRenewalIdentity(snapshot.subscriptionId, snapshot.scheduledAt);
      const op = JSON.parse((await db.query(rawClaim, [identity, automaticRenewalFingerprint(snapshot), snapshot, now])).rows[0].result);
      expect(op).toMatchObject({ acquired: true });
      claims.push(op);
      await resizeForRenewal(entry.f, upgradeTransaction(db));
    }
    await applyForward();
    expect(await renewalUpgradeReport(owner)).toEqual(claims.sort((a, b) => a.operationId.localeCompare(b.operationId))
      .map(op => reportRow(op.operationId, ["first_charge", "unknown_provenance"], { frozen_amount_minor: 200 })));
    for (const op of claims) {
      await rpc("fulfillment_release_subscription_renewal", [op.operationId, op.claimToken, "upgrade_reconciled", now], db);
    }
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

async function verifyCaseFreeArrival(owner: Pool, direct: Pool, shipmentId: string, subscriptionId: string) {
  const requestKey = `verified:${shipmentId}`, deliveredAt = days(at, 35), evidenceRef = `evidence:${shipmentId}`;
  const cases = () => owner.query("SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1", [subscriptionId]);
  const due = () => owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [subscriptionId]);
  expect((await cases()).rows).toEqual([]);
  const before = (await due()).rows;
  expect(await rpc("fulfillment_record_alignment_arrival", [requestKey, shipmentId, deliveredAt, evidenceRef], direct))
    .toEqual({ replayed: false });
  expect((await owner.query(`SELECT a.shipment_id, a.evidence_ref, a.delivered_at, s.delivered_at AS shipment_delivered_at
    FROM public.subscription_delivery_alignment_arrivals a
    JOIN public.fulfillment_shipments s ON s.id=a.shipment_id WHERE a.request_key=$1`, [requestKey])).rows)
    .toEqual([{ shipment_id: shipmentId, evidence_ref: evidenceRef,
      delivered_at: new Date(deliveredAt), shipment_delivered_at: new Date(deliveredAt) }]);
  expect((await cases()).rows).toEqual([]);
  expect((await due()).rows).toEqual(before);
}

it("preserves first claims and case-free arrivals for an existing directly granted runtime login", async () => {
  await withTemplateUpgrade(async target => {
    const { db, owner } = target;
    const before = await upgradeRenewal(target, { edited: false });
    const fresh = await upgradeRenewal(target, { edited: false });
    const stale = await upgradeRenewal(target);
    const beforeParcel = await parcel(before.f.orderId, db);
    const afterParcel = await parcel(fresh.f.orderId, db);
    const role = "renewal_direct_claim", password = randomUUID();
    await owner.query(`CREATE ROLE renewal_direct_claim LOGIN PASSWORD '${password}';
      GRANT USAGE ON SCHEMA public TO renewal_direct_claim;
      GRANT EXECUTE ON FUNCTION public.${dueClaimSignature},
        public.${arrivalSignature},
        public.subscription_renewal_identity(uuid,timestamptz),
        public.subscription_renewal_operation_response(public.subscription_renewal_operations,boolean,boolean,text) TO renewal_direct_claim;
      GRANT SELECT,UPDATE ON public.subscriptions TO renewal_direct_claim;
      GRANT SELECT,INSERT,UPDATE ON public.subscription_renewal_operations TO renewal_direct_claim;
      GRANT SELECT,INSERT ON public.subscription_delivery_alignment_arrivals TO renewal_direct_claim;
      GRANT UPDATE (delivered_at,updated_at) ON public.fulfillment_shipments TO renewal_direct_claim;
      GRANT UPDATE (updated_at) ON public.subscription_delivery_alignment_cases TO renewal_direct_claim;
      GRANT SELECT ON public.subscription_renewal_terms,public.fulfillment_inventory_reservations,
        public.subscription_cycles,public.commerce_orders,public.commerce_settlement_intents,
        public.fulfillment_shipments,public.subscription_delivery_alignment_cases TO renewal_direct_claim`);
    const url = new URL(loginConnection(target.connectionString, role));
    url.password = password;
    const direct = new Pool({ connectionString: url.toString() });
    try {
      expect((await direct.query(`SELECT session_user, current_user,
        pg_has_role(current_user,'service_role','MEMBER') AS service_member`)).rows)
        .toEqual([{ session_user: role, current_user: role, service_member: false }]);
      const claim = async (entry: typeof fresh) =>
        JSON.parse((await direct.query(rawClaim, claimWire(entry.d, entry.snapshot))).rows[0].result);
      expect(await rpc("subscription_delivery_alignment_get_mode", [], owner)).toBe("off");
      await verifyCaseFreeArrival(owner, direct, beforeParcel, before.f.subscriptionId);
      expect(await claim(before)).toMatchObject({ acquired: true });
      const readAuthority = async () => (await owner.query<{ authority: string }>(`SELECT json_build_array(
        claim.proacl::text, claim.proowner, claim.prosecdef, claim.provolatile, claim.proconfig,
        delivery.proacl::text, t.oid, t.tgrelid, t.tgfoid, t.tgenabled, pg_get_triggerdef(t.oid)
      )::text AS authority
      FROM pg_trigger t
      JOIN pg_proc delivery ON delivery.oid=t.tgfoid
      JOIN pg_proc claim ON claim.oid=$1::regprocedure
      WHERE t.tgrelid='public.fulfillment_shipments'::regclass
        AND t.tgname='trg_subscription_delivery_alignment_on_delivery'
        AND delivery.oid=$2::regprocedure`, [`public.${dueClaimSignature}`, `public.${deliveryTriggerSignature}`])).rows[0]?.authority;
      const authority = await readAuthority();
      expect(authority).toBeDefined();
      await applyTemplateForwardWithCustomGrants(owner);
      expect(await readAuthority()).toBe(authority);
      expect(await rpc("subscription_delivery_alignment_get_mode", [], owner)).toBe("off");
      await verifyCaseFreeArrival(owner, direct, afterParcel, fresh.f.subscriptionId);
      expect(await claim(fresh)).toMatchObject({ acquired: true });
      await expect(claim(stale)).rejects.toMatchObject(staleClaim);
      expect((await db.query("SELECT id FROM public.subscription_renewal_operations WHERE subscription_id=$1",
        [stale.f.subscriptionId])).rows).toEqual([]);
    } finally {
      await direct.end();
    }
  });
}, postgresSetupTimeoutMs);

it("preserves arrival and claim authority for an existing directly granted fulfillment login", async () => {
  await withTemplateUpgrade(async target => {
    const { db, owner } = target;
    const entry = await upgradeRenewal(target, { edited: false });
    const arrivals: { shipmentId: string; subscriptionId: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const { orderId, subscriptionId } = await renewalPurchase(false, target);
      arrivals.push({ shipmentId: await parcel(orderId, db), subscriptionId });
    }
    const role = "renewal_direct_arrival", password = randomUUID();
    // Model an installation that restricts the claim RPC to its renewal logins.
    await owner.query(`REVOKE EXECUTE ON FUNCTION public.${dueClaimSignature} FROM PUBLIC;
      CREATE ROLE renewal_direct_arrival LOGIN PASSWORD '${password}';
      GRANT USAGE ON SCHEMA public TO renewal_direct_arrival;
      GRANT EXECUTE ON FUNCTION public.${arrivalSignature} TO renewal_direct_arrival;
      GRANT SELECT,INSERT ON public.subscription_delivery_alignment_arrivals TO renewal_direct_arrival;
      GRANT SELECT ON public.fulfillment_shipments,public.commerce_orders,public.subscription_cycles,
        public.subscriptions,public.subscription_delivery_alignment_cases TO renewal_direct_arrival;
      GRANT UPDATE (delivered_at,updated_at) ON public.fulfillment_shipments TO renewal_direct_arrival;
      GRANT UPDATE (updated_at) ON public.subscriptions,public.subscription_delivery_alignment_cases TO renewal_direct_arrival`);
    const url = new URL(loginConnection(target.connectionString, role));
    url.password = password;
    const direct = new Pool({ connectionString: url.toString() });
    try {
      expect((await direct.query(`SELECT session_user, current_user,
        pg_has_role(current_user,'service_role','MEMBER') AS service_member,
        has_function_privilege('public.subscription_delivery_alignment_get_mode()', 'EXECUTE') AS read_mode`)).rows)
        .toEqual([{ session_user: role, current_user: role, service_member: false, read_mode: false }]);
      const arrival = ({ shipmentId, subscriptionId }: (typeof arrivals)[number]) =>
        verifyCaseFreeArrival(owner, direct, shipmentId, subscriptionId);
      const readClaimAcl = async () => (await owner.query<{ acl: string | null }>(
        "SELECT proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure", [`public.${dueClaimSignature}`])).rows[0]!.acl;
      const expectClaimRefused = async () =>
        expect(direct.query(rawClaim, claimWire(entry.d, entry.snapshot))).rejects.toMatchObject({
          code: "42501", message: "permission denied for function subscription_claim_due_renewal",
        });
      const acl = await Promise.all([deliveryTriggerSignature, arrivalSignature].map(signature => generationAcl(owner, signature)));
      expect(acl.map(([routine]) => routine.definer)).toEqual([false, false]);
      expect(await rpc("subscription_delivery_alignment_get_mode", [], owner)).toBe("off");
      await arrival(arrivals[0]!);
      const claimAcl = await readClaimAcl();
      await expectClaimRefused();
      await applyTemplateForwardWithCustomGrants(owner);
      expect(await Promise.all([deliveryTriggerSignature, arrivalSignature].map(signature => generationAcl(owner, signature))))
        .toEqual(acl);
      await arrival(arrivals[1]!);
      await expectClaimRefused();
      expect(await readClaimAcl()).toBe(claimAcl);

      // A mode reader alone still lacks the fallback's other capabilities.
      await owner.query(`GRANT EXECUTE ON FUNCTION public.subscription_delivery_alignment_get_mode() TO renewal_direct_arrival;
        GRANT SELECT ON public.subscription_delivery_alignment_control TO renewal_direct_arrival`);
      await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], owner);
      expect(await rpc("subscription_delivery_alignment_get_mode", [], direct)).toBe("auto_align");
      await arrival(arrivals[2]!);
      expect((await readRenewalUpgradeReport(owner)).alignment).toEqual(arrivals
        .sort((one, two) => one.subscriptionId.localeCompare(two.subscriptionId))
        .map(({ subscriptionId, shipmentId }) => reportGap(subscriptionId, shipmentId, { occupying_operation_id: null })));
    } finally {
      await direct.end();
    }
  });
}, postgresSetupTimeoutMs);

async function waitForSubscriptionLock(owner: Pool, blockerPid: number) {
  await expect.poll(async () => (await owner.query(`SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
    WHERE a.datname = current_database() AND $1 = ANY(pg_blocking_pids(a.pid))
      AND l.relation = 'public.subscriptions'::regclass AND l.granted
  ) AS waiting`, [blockerPid])).rows, { timeout: 20_000 }).toEqual([{ waiting: true }]);
}

it("keeps occupied gaps visible and repairs only after exact owner disposition", async () => {
  await withTemplateUpgrade(async target => {
    const { db, owner, applyForward } = target;
    const entry = await upgradeRenewal(target, { edited: false }), prepared = await upgradeRenewal(target, { edited: false });
    const { f, d, snapshot } = entry, shipment = await parcel(f.orderId, db), second = await parcel(prepared.f.orderId, db);
    const deliveredAt = days(d.due.scheduledAt, 1), shifted = days(deliveredAt, facts.cadenceDays);
    // The incumbent case-free arrival leaves the due date alone.
    await recordArrival(shipment, deliveredAt, db);
    await recordArrival(second, deliveredAt, db);
    const op = await entry.claim(), competing = await prepareIncumbent(prepared);
    const frozen = await frozenOperation(db, op.operationId);
    await applyForward();
    await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], owner);
    const expected = (state: string) => [
      reportGap(f.subscriptionId, shipment, { occupying_operation_id: op.operationId, occupying_operation_state: state }),
      reportGap(prepared.f.subscriptionId, second, { occupying_operation_id: competing.op.operationId, successor_cycle_id: competing.prepared.cycleId }),
    ];
    const report = await readRenewalUpgradeReport(owner);
    expect(report.operations).toEqual([]);
    expect(report.alignment).toHaveLength(2);
    expect(report.alignment).toEqual(expect.arrayContaining(expected("claimed")));
    for (const id of [f.subscriptionId, prepared.f.subscriptionId]) {
      const before = await alignmentState(owner, id);
      await repairAlignment(owner, id);
      expect(await alignmentState(owner, id)).toEqual(before);
    }
    await reserveIncumbent(d, op);
    const reserved = await alignmentState(owner, f.subscriptionId);
    expect((await readRenewalUpgradeReport(owner)).alignment).toEqual(expect.arrayContaining(expected("reserved")));
    await repairAlignment(owner, f.subscriptionId);
    expect(await alignmentState(owner, f.subscriptionId)).toEqual(reserved);
    const takeover = JSON.parse((await db.query(rawClaim, claimWire(d, snapshot, undefined, later))).rows[0].result);
    expect(takeover).toMatchObject({ operationId: op.operationId, acquired: true });
    await rpc("fulfillment_release_subscription_renewal", [op.operationId, takeover.claimToken, "upgrade_reconciled", later], db);
    expect((await readRenewalUpgradeReport(owner)).alignment).toEqual(expect.arrayContaining(expected("refused")));
    await repairAlignment(owner, f.subscriptionId);
    expect(await frozenOperation(db, op.operationId)).toEqual(frozen);
    expect((await readRenewalUpgradeReport(owner)).alignment).toEqual([expected("refused")[1]]);
    await closeUnsent(competing, target);
    await closeWaitingRetry(db, competing, competing.op.operationId, later);
    const tick = binding(d, () => deliveredAt, upgradeTransaction(db), db);
    expect(await tick.services.run()).toMatchObject({ renewals: [] });
    expect(await binding(d, () => shifted, upgradeTransaction(db), db).services.run())
      .toMatchObject({ renewals: [{ status: "succeeded" }] });
    expect(d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual([200]);
  });
}, postgresSetupTimeoutMs);

it.each(["READ COMMITTED", "REPEATABLE READ"])("requires fresh arrival snapshots for simultaneous split delivery (%s)", async isolation => {
  const f = await renewalPurchase(), d = await deps(f.subscriptionId, "succeeded"), original = await parcel(f.orderId);
  const { rows: [{ id: first }, { id: second }] } = await admin.query(`INSERT INTO public.fulfillment_shipments
    (order_id,port_key,provider_type,create_idempotency_key,sequence_no,replaces_shipment_id,replacement_reason)
    VALUES($1,'g7-parcels','3pl',$2,1,$4,'lost'),($1,'g7-parcels','3pl',$3,2,$4,'lost') RETURNING id`,
  [f.orderId, randomUUID(), randomUUID(), original]);
  const deliveredAt = days(d.due.scheduledAt, 1), shifted = days(deliveredAt, facts.cadenceDays);
  await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], admin);
  const one = await runtime.connect(), two = await runtime.connect();
  const update = "UPDATE public.fulfillment_shipments SET delivered_at=$2 WHERE id=$1";
  let waiting: Promise<unknown> | undefined;
  try {
    await one.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const { rows: [{ pid }] } = await one.query("SELECT pg_backend_pid() AS pid");
    await one.query(update, [first, days(deliveredAt, -0.5)]);
    await two.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await two.query("SELECT pg_current_snapshot()");
    waiting = two.query(update, [second, deliveredAt]);
    void waiting.catch(() => {});
    await waitForSubscriptionLock(admin, pid);
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual([]);
    await one.query("COMMIT");
    await waiting;
    await two.query("COMMIT");
    const qualified = isolation === "READ COMMITTED";
    expect(await alignmentState(admin, f.subscriptionId)).toMatchObject({
      next_cycle_at: new Date(qualified ? shifted : d.due.scheduledAt),
    });
    expect((await readRenewalUpgradeReport(admin)).alignment).toEqual(qualified ? [] : [reportGap(f.subscriptionId, second)]);
    await binding(d, () => deliveredAt).services.run();
    expect(d.execute.mock.calls.map(([charge]) => charge.amountMinor)).toEqual(qualified ? [] : [200]);
  } finally {
    await one.query("ROLLBACK");
    await waiting?.catch(() => {});
    await two.query("ROLLBACK");
    one.release();
    two.release();
  }
}, 30_000);

it.each(["drain", "omit drain", "keep closed", "reopen"])("fences claim admission through the cohort capture (%s)", async arm => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const stale = await upgradeRenewal(target), lockTarget = await upgradeRenewal(target), lockOp = await lockTarget.claim();
    const writer = await db.connect(), locker = await db.connect();
    const startedBefore = arm === "drain" || arm === "omit drain";
    let claim: RenewalReadback | undefined, forward: ReturnType<typeof applyForward> | undefined;
    const admit = async () => {
      await writer.query("BEGIN");
      expect((await writer.query(`SELECT catalog_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=$1`,
        [stale.f.subscriptionId])).rows).toEqual([{ catalog_acceptance: null }]);
      claim = JSON.parse((await writer.query(rawClaim, claimWire(stale.d, stale.snapshot))).rows[0].result);
      expect(claim).toMatchObject({ acquired: true });
    };
    try {
      if (startedBefore) await admit();
      if (arm === "drain") await writer.query("COMMIT");
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [lockTarget.f.subscriptionId]);
      const { rows: [{ pid }] } = await locker.query("SELECT pg_backend_pid() AS pid");
      forward = applyForward();
      void forward.catch(() => {});
      await waitForSubscriptionLock(owner, pid);
      if (arm === "reopen") await admit();
      if (arm === "omit drain" || arm === "reopen") await writer.query("COMMIT");
      await locker.query("COMMIT");
      expect((await forward).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
      await refuseUnprepared(lockTarget, lockOp);
      const cohort = (await owner.query(`SELECT c.renewal_operation_id
        FROM public.subscription_renewal_upgrade_cohort c JOIN public.subscription_renewal_operations o ON o.id=c.renewal_operation_id
        WHERE o.subscription_id=$1`, [stale.f.subscriptionId])).rows;
      expect(cohort).toEqual(arm === "drain" ? [{ renewal_operation_id: claim!.operationId }] : []);
      if (arm === "drain") {
        expect(await renewalUpgradeReport(owner)).toEqual([reportRow(claim!.operationId, ["first_charge"])]);
        await refuseUnprepared(stale, claim!);
      }
      expect(await readRenewalUpgradeReport(owner)).toEqual({ operations: [], alignment: [] });
      const tick = binding(stale.d, () => later, upgradeTransaction(db), db);
      await tick.services.run();
      await tick.services.run();
      expect(stale.d.execute.mock.calls.map(([charge]) => charge.amountMinor))
        .toEqual(arm === "keep closed" ? [300] : arm === "drain" ? [] : [200]);
      if (arm === "omit drain" || arm === "reopen") {
        expect((await stale.d.input.store.readRenewal(claim!.identityKey))?.operationId).toBe(claim!.operationId);
      }
    } finally {
      await writer.query("ROLLBACK");
      await locker.query("ROLLBACK");
      await forward?.catch(() => {});
      writer.release();
      locker.release();
    }
  });
}, postgresSetupTimeoutMs);

it("keeps v3 schedule and delivery ownership out of the check and scoped repair", async () => {
  await withTemplateUpgrade(async target => {
    const { db, owner, applyForward } = target;
    const selected = await upgradeRenewal(target), unselected = await upgradeRenewal(target), legacy = await upgradeRenewal(target);
    const op = await selected.claim();
    await reserveIncumbent(selected.d, op);
    const tag = (id: string) => owner.query(`UPDATE public.subscription_renewal_operations
      SET cycle_snapshot=jsonb_set(cycle_snapshot,'{contractVersion}',to_jsonb('platform.subscription.renewal.v3'::text)) WHERE id=$1`, [id]);
    await tag(op.operationId);
    const observedDue = days(now, 3), deliveredAt = days(observedDue, 1);
    async function gap({ f, d }: typeof selected) {
      const shipment = await parcel(f.orderId, db);
      await owner.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [f.subscriptionId, observedDue]);
      await recordArrival(shipment, deliveredAt, db);
      return { ...f, shipment, key: randomUUID(), anchor: d.due.scheduledAt };
    }
    const [booked, assigning, control] = await Promise.all([gap(selected), gap(unselected), gap(legacy)]);
    for (const subject of [booked, assigning]) {
      await owner.query(`INSERT INTO public.subscription_cycle_occurrences
        (cycle_key,subscription_id,client_id,original_anchor_at,effective_due_at,cadence_seconds,rail,lifecycle,is_current)
        VALUES($1,$2,$3,$4,$5,2419200,'v3','active',true)`,
      [subject.key, subject.subscriptionId, subject.clientId, subject.anchor, days(observedDue, 1)]);
    }
    await owner.query(`WITH generation AS (
      INSERT INTO public.subscription_cycle_generations
        (cycle_key,operation_id,commercial_generation_id,agreement,agreement_fingerprint,claim_token,lease_expires_at,lease_generation)
      SELECT $1,id,id,'{}',operation_fingerprint,claim_token,lease_expires_at,1
      FROM public.subscription_renewal_operations WHERE id=$2 RETURNING *
    ) UPDATE public.subscription_cycle_occurrences x SET operation_id=g.operation_id,commercial_generation_id=g.commercial_generation_id
      FROM generation g WHERE x.cycle_key=g.cycle_key`, [booked.key, op.operationId]);
    await applyForward();
    await rpc("subscription_delivery_alignment_set_mode", ["auto_align"], owner);
    const report = () => readRenewalUpgradeReport(owner);
    const unchanged = async (id: string) => {
      const before = await alignmentState(owner, id);
      await repairAlignment(owner, id);
      expect(await alignmentState(owner, id)).toEqual(before);
    };
    const legacyGap = [reportGap(control.subscriptionId, control.shipment)];
    expect(await report()).toEqual({ operations: [], alignment: legacyGap });
    await unchanged(booked.subscriptionId);
    await unchanged(assigning.subscriptionId);

    await owner.query(`UPDATE public.subscription_cycle_occurrences SET is_current=false,lifecycle='retired' WHERE cycle_key IN ($1,$2)`, [booked.key, assigning.key]);
    expect((await report()).alignment).toHaveLength(3);
    const operationSchedule = (when: string) => owner.query(
      "UPDATE public.subscription_renewal_operations SET scheduled_at=$2 WHERE id=$1", [op.operationId, when]);
    const beforeTag = (await report()).alignment.filter(row => row.subscription_id !== booked.subscriptionId);
    await operationSchedule(observedDue);
    expect((await report()).alignment).toEqual(beforeTag);
    await unchanged(booked.subscriptionId);
    await operationSchedule(booked.anchor);
    const linkPredecessor = (operationId: string | null) => owner.query(`UPDATE public.subscription_cycles
      SET renewal_operation_id=$2 WHERE id=(SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1)`,
    [booked.orderId, operationId]);
    await linkPredecessor(op.operationId);
    expect((await report()).alignment).toEqual(beforeTag);
    await unchanged(booked.subscriptionId);
    await linkPredecessor(null);
    await owner.query(`INSERT INTO public.subscription_cycle_delivery_assignments(obligation_ref,assigned_cycle_key)
      VALUES($1,$2)`, [assigning.orderId, assigning.key]);
    await transaction(async tx => {
      // The booked graph uses the existing paid activation at ordinal zero. Its cycle and order
      // operation links stay null, so neither the v3 tag nor the unknown-ordinal fence decides.
      await tx.query(`WITH coordinates AS (
        SELECT o.id AS order_id, c.id AS cycle_id, i.id AS intent_id, gen_random_uuid() AS payment_id
        FROM public.commerce_orders o JOIN public.subscription_delivery_alignment_cycles c ON c.order_id=o.id
        JOIN public.commerce_settlement_intents i ON i.order_id=o.id
        WHERE o.id=$3 AND o.renewal_operation_id IS NULL AND c.renewal_operation_id IS NULL AND c.cycle_number=0
      ), provider AS (
        INSERT INTO public.payment_provider_states(id,payment_id,target_kind)
        SELECT intent_id,payment_id,'one_time_order' FROM coordinates RETURNING *
      ), attempt AS (
        INSERT INTO public.payment_provider_attempts(settlement_intent_id,payment_id,provider,idempotency_key,amount_minor,currency)
        SELECT id,payment_id,'offline',id::text,200,'XXX' FROM provider RETURNING id
      ), hold AS (
        INSERT INTO public.subscription_cycle_stock_holds
        SELECT gen_random_uuid(),$1,$2,$2,id,expires_at,'held' FROM public.fulfillment_inventory_reservations
        WHERE renewal_operation_id=$2 RETURNING *
      ), calculation AS (
        INSERT INTO public.tax_calculations(calculation_id,state) VALUES(gen_random_uuid(),'erased') RETURNING calculation_id
      ), issuance AS (
        INSERT INTO public.subscription_cycle_tax_issuances
        SELECT gen_random_uuid(),$2,$2,1,h.hold_incarnation_id,c.calculation_id,repeat('a',64),NULL,now()
        FROM hold h CROSS JOIN calculation c RETURNING *
      ), binding AS (
        INSERT INTO public.subscription_cycle_tax_bindings
        SELECT gen_random_uuid(),i.evaluation_id,$1,$2,$2,1,i.issued_calculation_id,repeat('a',64),repeat('a',64),
          200,'XXX',now(),now()+interval '1 day',NULL,now() FROM issuance i RETURNING binding_ref
      )
      INSERT INTO public.subscription_cycle_preparations
      SELECT gen_random_uuid(),$1,c.cycle_id,$2,$2,b.binding_ref,1,h.hold_incarnation_id,c.order_id,c.intent_id,
        a.id,c.order_id::text,repeat('a',64),now(),NULL,NULL
      FROM coordinates c CROSS JOIN binding b CROSS JOIN hold h CROSS JOIN attempt a`, [booked.key, op.operationId, booked.orderId]);
    }, owner);
    expect((await report()).alignment).toEqual(legacyGap);
    await unchanged(booked.subscriptionId);
    await unchanged(assigning.subscriptionId);
    await repairAlignment(owner, control.subscriptionId);
    expect((await report()).alignment).toEqual([]);
    expect(await alignmentState(owner, control.subscriptionId)).toMatchObject({
      next_cycle_at: new Date(days(deliveredAt, facts.cadenceDays)), cases: [{ state: "aligned" }],
    });
  });
}, postgresSetupTimeoutMs);

it("captures an accepted edit that commits while the forward is waiting on its subscription lock", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const entry = await upgradeRenewal(target, { edited: false }), op = await entry.claim();
    const editor = await db.connect();
    const accepted = signal(), release = signal();
    let transactions = 0;
    const edit = resizeForRenewal(entry.f, async work => {
      if (++transactions === 1) return transaction(work, db);
      await editor.query("BEGIN");
      try {
        const result = await work(editor);
        accepted.resolve();
        await release.promise;
        await editor.query("COMMIT");
        return result;
      } catch (error) { accepted.reject(error); await editor.query("ROLLBACK"); throw error; }
    });
    void edit.catch(accepted.reject);
    let forward: ReturnType<typeof applyForward> | undefined;
    try {
      await accepted.promise;
      const { rows: [{ pid }] } = await editor.query("SELECT pg_backend_pid() AS pid");
      forward = applyForward();
      void forward.catch(() => {});
      await waitForSubscriptionLock(owner, pid);
      release.resolve();
      await edit;
      expect((await forward).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
      expect(await renewalUpgradeReport(owner)).toEqual([reportRow(op.operationId, ["first_charge"])]);
      await refuseUnprepared(entry, op);
      expect(await renewalUpgradeReport(owner)).toEqual([]);
    } finally {
      release.resolve();
      await edit.catch(() => {});
      await forward?.catch(() => {});
      editor.release();
    }
  });
}, postgresSetupTimeoutMs);

it("lists captured and allocator-refused frozen stock waits through recovery and closure", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target, transact = upgradeTransaction(db);
    const captured = await upgradeRenewal(target), uncaptured = await upgradeRenewal(target);
    const wait = await captured.claim(), missing = await uncaptured.claim();
    await stock(0, randomUUID(), db);
    const store = api.createPostgresStockWaitStore({ executor: db, withTransaction: transact, codec: captured.d.codec, workerId: "before-upgrade" });
    expect(await store.admit({ operationId: wait.operationId, claimToken: wait.claimToken, now, snapshot: wait.cycleSnapshot }))
      .toMatchObject({ waiting: true });
    expect(await uncaptured.d.input.inventory.reserve({ operationId: missing.operationId, claimToken: missing.claimToken, now }))
      .toMatchObject({ reserved: false, reason: "inventory_unavailable" });
    expect((await db.query("SELECT renewal_operation_id FROM public.subscription_stock_wait_cases")).rows)
      .toEqual([{ renewal_operation_id: wait.operationId }]);
    await applyForward();
    const rows = await renewalUpgradeReport(owner);
    expect(rows.map(row => row.operation_id)).toEqual([wait.operationId, missing.operationId].sort());
    expect(rows).toEqual(expect.arrayContaining([
      reportRow(wait.operationId, ["stock_wait"], { stock_wait_state: "waiting" }),
      reportRow(missing.operationId, ["stock_wait"], { stock_wait_state: "uncaptured" }),
    ]));
    await rpc("subscription_apply_lifecycle_action", [captured.f.clientId, randomUUID(), captured.f.subscriptionId, "pause", "{}", later], db);
    expect(await renewalUpgradeReport(owner)).toContainEqual(reportRow(wait.operationId, ["stock_wait"], {
      subscription_status: "paused", stock_wait_state: "waiting",
    }));
    const frozen = await frozenOperation(db, missing.operationId);
    await stock(1000, randomUUID(), db);
    const recovered = await rpc<RenewalReadback>("subscription_stock_wait_recover_refusal",
      [missing.operationId, missing.operationFingerprint, "upgrade", later], db);
    expect(recovered).toMatchObject({ state: "reserved", claimToken: expect.any(String) });
    expect(await frozenOperation(db, missing.operationId)).toEqual(frozen);
    expect(await renewalUpgradeReport(owner)).toContainEqual(reportRow(missing.operationId,
      ["first_charge", "stock_wait"], { stock_wait_state: "stock_secured", reservation_state: "held" }));

    await rpc("subscription_apply_lifecycle_action",
      [uncaptured.f.clientId, randomUUID(), uncaptured.f.subscriptionId, "cancel", "{}", later], db);
    await rpc("subscription_stock_wait_candidates", [20, later], db);
    expect(await renewalUpgradeReport(owner)).toContainEqual(reportRow(missing.operationId,
      ["first_charge"], { subscription_status: "cancelled", stock_wait_state: "closed" }));
    // Exercise direct preparation on a cancelled stock-secured occurrence without committing it.
    const conn = await db.connect();
    try {
      await conn.query("BEGIN");
      expect(JSON.parse((await conn.query(rawPrepare, [missing.operationId, recovered.claimToken, later])).rows[0].result))
        .toMatchObject({ state: "attempt_prepared" });
    } finally { await conn.query("ROLLBACK"); conn.release(); }
    await rpc("fulfillment_release_subscription_renewal", [missing.operationId, recovered.claimToken, "upgrade_reconciled", later], db);
    await rpc("subscription_apply_lifecycle_action",
      [captured.f.clientId, randomUUID(), captured.f.subscriptionId, "cancel", "{}", later], db);
    await rpc("subscription_stock_wait_candidates", [20, later], db);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

async function prepareWebhookRenewal(target: UpgradeTarget, outcome: "succeeded" | "failed" = "succeeded",
  stage: "unbound" | "intent" | "dispatched" = "dispatched", provider = webhookProvider,
  withTransaction = upgradeTransaction(target.db)) {
  const { db } = target;
  const entry = await prepareIncumbent(await upgradeRenewal(target, { providerBacked: provider }));
  const { f, d, op, prepared } = entry;
  const intentId = prepared.settlementIntentId, providerPaymentId = `pi_${op.operationId}`;
  const event = { provider, providerEventId: `evt_${op.operationId}`, providerPaymentRef: providerPaymentId,
    intentRef: intentId, providerOccurredAt: later, outcome, money: { amountMinor: 200, currency: "XXX" } };
  const deliveries = new Map<string, typeof event>();
  const sign = (raw: Uint8Array) => createHmac("sha256", "synthetic-renewal-signature").update(raw).digest("hex");
  const unexpected = async (): Promise<never> => { throw new Error("unexpected_provider_request"); };
  const execute = vi.fn<Parameters<typeof payments.createPostgresProviderPaymentRail>[0]["adapter"]["attemptPort"]["execute"]>(unexpected);
  const adapter: Parameters<typeof payments.createPostgresProviderPaymentRail>[0]["adapter"] = {
    capabilities: { providerKind: provider, captureFlows: [], requiresStoredMandateEvidence: false,
      assessMandate: () => ({ chargeable: true }), unattendedChargeFlow: "off_session_payment",
      payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
      methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
      terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
      mandateUpsertIsSubscriptionScoped: false, supportedCurrencies: ["XXX"], unattended: "supported",
      readback: "unsupported", close: "unsupported", exactAbsence: "unsupported", refundObservation: "unsupported",
      refundCreate: "unsupported", authorizationCaptureSplit: "unsupported" },
    attemptPort: { validateInput() {}, execute },
    readbackPort: { readPayment: unexpected },
    verifyPort: { async verifyAndNormalize({ rawBody, headers }) {
      const delivery = deliveries.get(Buffer.from(rawBody).toString("utf8"));
      if (!delivery || headers["x-fixture-signature"] !== sign(rawBody)) return { kind: "refusal", reason: "malformed" };
      return { ...delivery, kind: "money", attemptRef: null, fingerprint: sign(rawBody), capturedAmountBasis: "provider_capture_v1",
        ...(delivery.outcome === "failed" ? { refusal: { code: "soft_retryable", hints: [] } } : {}),
        providerAuditPayload: { livemode: false, captureTimeBasis: "signed_event_v1", providerAccountRef: "acct_fixture" } };
    } },
  };
  const truth = { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
  const bindingOptions = { enabled: true, channelKey: provider, executor: db, withTransaction,
    codec: d.codec, truth, settlement: (tx: Parameters<typeof settlement>[1]) => settlement(d.codec, tx),
    now: () => later, search: async () => [] };
  const rail = payments.createPostgresProviderPaymentRail({ executor: db, adapter, mode: "test", truth,
    resolveMethodOwner: async () => null, resolveSavedMethodOwner: async () => null,
    composeWebhook: (event, control) => bindingForWebhook.composeWebhook(event, control) });
  const bindingForWebhook = api.createPostgresProviderRenewalBinding({ ...bindingOptions, paymentRail: rail });
  const request = { paymentIntentId: intentId, providerIdempotencyKey: `${op.identityKey}:provider`, providerRequestFingerprint: op.operationFingerprint };
  const attachIntent = () => rail.control.createIntent({ idempotencyKey: `${op.identityKey}:provider-intent`, targetKind: "subscription_cycle",
    orderId: prepared.orderId, subscriptionId: d.due.subscriptionId, subscriptionCycleId: prepared.cycleId,
    amountMinor: 200, currency: "XXX", channelKey: provider, metadata: {}, at: now });
  if (stage !== "unbound") await attachIntent();
  const preparation = { ...request, idempotencyKey: `${op.identityKey}:provider-prepare`,
    provider, providerFlow: "off_session_payment" as const, paymentMethodRef: f.methodRef, requestPayload: {} };
  let paymentAttemptId = "";
  if (stage === "dispatched") {
    ({ paymentAttemptId } = await rail.control.prepareProviderAttempt(preparation));
    await rail.control.finalizeProviderAttempt({ ...request, idempotencyKey: `${op.identityKey}:provider-finalize`, paymentAttemptId,
    providerAttemptId: providerPaymentId, providerSessionId: null, attemptStatus: "processing", nextActionKind: null,
    requestPayload: {}, responsePayload: {} });
    await d.input.settlement.acknowledgeExternalAttempt({ operationId: op.operationId, operationFingerprint: op.operationFingerprint,
    externalAttemptRef: providerPaymentId, acknowledgedAt: now });
  }
  return { ...entry, id: op.operationId, methodRef: f.methodRef, execute, rail, preparation, paymentAttemptId, attachIntent,
    retryPayments: bindingForWebhook.retryPayments, paymentRails: bindingForWebhook.paymentRails,
    recoverDunning: () => bindingForWebhook.lifecycle.failureHandoff.handoffFailure({
      idempotencyKey: `${op.identityKey}:handoff`, subscriptionId: f.subscriptionId, clientId: f.clientId,
      cycleId: prepared.cycleId, orderId: prepared.orderId, paymentIntentId: intentId, retryAttempt: 1,
      failureClass: "soft_retryable", failureReason: "declined", nextRetryAt: null, occurredAt: later,
      amountMinor: 200, currency: "XXX",
    }),
    async deliver(input: Partial<Pick<typeof event, "providerPaymentRef" | "providerOccurredAt" | "providerEventId" | "outcome" | "intentRef">> = {},
      operationId = op.operationId) {
      const delivery = { ...event, ...input };
      const payload = JSON.stringify(delivery);
      deliveries.set(payload, delivery);
      const body = Buffer.from(payload);
      expect(await rail.ingress.receive({
        rawBody: body, headers: { "x-fixture-signature": sign(body) }, receivedAt: delivery.providerOccurredAt,
      })).toMatchObject({ status: 200 });
      if (input.providerPaymentRef === undefined || input.intentRef !== undefined) {
        expect((await db.query("SELECT state FROM public.subscription_renewal_operations WHERE id=$1", [operationId])).rows)
          .toEqual([{ state: delivery.outcome === "succeeded" ? "succeeded" : "refused" }]);
      }
    },
  };
}

it.each([true, false])("drains mounted and independent callers at the shared provider boundary (custom drain=%s)", async customDrain => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const custom = await prepareWebhookRenewal(target, "succeeded", "intent");
    const mounted = await upgradeRenewal(target, { providerBacked: true });
    const customIntent = custom.prepared.settlementIntentId, customEntered = signal(), mountedEntered = signal();
    const releaseCustom = signal(), releaseMounted = signal(), sentAfterForward: number[] = [];
    let forwardStarted = false;
    vi.spyOn(custom.rail.adapter.readbackPort, "readPayment").mockImplementation(async request => ({
      kind: "unsupported", identity: request.identity, expectedMoney: request.expectedMoney, purpose: request.purpose,
    }));
    custom.execute.mockImplementation(async request => {
      const independent = request.intentRef === customIntent;
      (independent ? customEntered : mountedEntered).resolve();
      await (independent ? releaseCustom : releaseMounted).promise;
      if (forwardStarted) sentAfterForward.push(request.money.amountMinor);
      return { outcome: { kind: "attempt", status: "processing" },
        dispatch: { kind: "dispatched", providerPaymentRef: independent ? `pi_${custom.id}` : `pi_${request.intentRef}` }, diagnostics: {} };
    });
    const d = { ...mounted.d, input: { ...mounted.d.input, policy: api.createSandboxRenewalPolicy(mounted.f.methodRef),
      paymentRails: custom.paymentRails } };
    const mountedCall = runPreForwardRenewal({ ...mounted, d });
    const customCall = custom.rail.execute({ attemptRef: custom.preparation.idempotencyKey, intentRef: customIntent,
      fingerprint: custom.op.operationFingerprint, providerIdempotencyKey: custom.preparation.providerIdempotencyKey,
      money: { amountMinor: 200, currency: "XXX" }, mode: "test", purpose: "renewal-unattended",
      orderRef: custom.prepared.orderId, clientId: custom.f.clientId, customerRef: custom.d.due.payerAccountRef!,
      storedMethod: { reference: custom.methodRef, mandate: { recurringModel: null } } });
    try {
      for (const [entered, pending] of [[mountedEntered, mountedCall], [customEntered, customCall]] as const) {
        await Promise.race([entered.promise, pending.then(result => { throw new Error(
          `provider_send_barrier_not_reached: ${JSON.stringify(result)}`); })]);
      }
      releaseMounted.resolve();
      const mountedOp = (await mounted.d.input.store.readRenewal((await mountedCall).identityKey))!;
      await custom.deliver({ intentRef: mountedOp.settlementIntentId!, providerPaymentRef: `pi_${mountedOp.settlementIntentId}`,
        providerEventId: `evt_${mountedOp.operationId}` }, mountedOp.operationId);
      if (customDrain) { releaseCustom.resolve(); await customCall; }
      forwardStarted = true;
      expect((await applyForward()).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
      releaseCustom.resolve();
      await customCall;
      await custom.deliver();
      expect(await readRenewalUpgradeReport(owner)).toEqual({ operations: [], alignment: [] });
      expect(await binding(d, () => later, upgradeTransaction(db), db).services.run()).toMatchObject({ renewals: [], retries: [] });
      expect(custom.execute.mock.calls.map(([request]) => request.money.amountMinor)).toEqual([200, 200]);
      expect(sentAfterForward).toEqual(customDrain ? [] : [200]);
    } finally {
      releaseMounted.resolve();
      releaseCustom.resolve();
      await Promise.allSettled([mountedCall, customCall]);
    }
  });
}, postgresSetupTimeoutMs);

it("lets verified provider intake finish while cohort capture only reads the operations table", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const intake = await db.connect(), entered = signal(), release = signal();
    let subscriptionId: string;
    let delivery: Promise<void> | undefined, forward: ReturnType<typeof applyForward> | undefined;
    try {
      const entry = await prepareWebhookRenewal(target, "succeeded", "dispatched", webhookProvider, async work => {
        await intake.query("BEGIN");
        try {
          await intake.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [subscriptionId]);
          entered.resolve();
          await release.promise;
          const outcome = await work(intake);
          await intake.query("COMMIT");
          return outcome;
        } catch (error) {
          entered.reject(error);
          await intake.query("ROLLBACK");
          throw error;
        }
      });
      subscriptionId = entry.f.subscriptionId;
      const { rows: [{ pid }] } = await intake.query("SELECT pg_backend_pid() AS pid");
      delivery = entry.deliver();
      void delivery.catch(entered.reject);
      await entered.promise;
      forward = applyForward();
      void forward.catch(() => {});
      await expect.poll(async () => (await owner.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity a
        WHERE a.datname = current_database() AND $1 = ANY(pg_blocking_pids(a.pid))
          AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.granted
            AND l.relation = 'public.subscription_renewal_operations'::regclass AND l.mode = 'AccessShareLock')
          AND NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.granted
            AND l.relation = 'public.subscription_renewal_operations'::regclass AND l.mode <> 'AccessShareLock')
      ) AS waiting_with_read_lock`, [pid])).rows, { timeout: 20_000 }).toEqual([{ waiting_with_read_lock: true }]);
      release.resolve();
      await delivery;
      expect((await forward).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
      expect((await owner.query(`SELECT o.state FROM public.subscription_renewal_operations o
        JOIN public.subscription_renewal_upgrade_cohort cohort ON cohort.renewal_operation_id=o.id WHERE o.id=$1`,
        [entry.id])).rows).toEqual([{ state: "succeeded" }]);
      expect(await renewalUpgradeReport(owner)).toEqual([]);
    } finally {
      release.resolve();
      await delivery?.catch(() => {});
      await forward?.catch(() => {});
      intake.release();
    }
  });
}, postgresSetupTimeoutMs);

async function interruptProviderHandoff(owner: Pool, deliver: () => Promise<unknown>) {
  const definition = (await owner.query(`SELECT pg_get_functiondef(
    'public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text)'::regprocedure) AS body`)).rows[0].body;
  try {
    await owner.query(`CREATE OR REPLACE FUNCTION public.payment_reconciliation_open_dunning_from_failed_result(
      p_idempotency_key text,p_payment_intent_id uuid,p_provider_event_id text,p_failure_reason text,p_occurred_at timestamptz,
      p_failure_class text,p_failed_payment_attempt_id uuid,p_template text,p_recovery_path text)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
      AS $$ BEGIN RAISE EXCEPTION 'subscription_dunning_case_unattributed' USING ERRCODE='55000'; END; $$`);
    return await deliver();
  } finally { await owner.query(definition); }
}

async function prepareRetry(db: Pool, row: NonNullable<Awaited<ReturnType<ReturnType<typeof api.createPostgresRetryStore>["read"]>>>,
  paymentMethodRef: string, at: string) {
  const key = `${row.identityKey}:retry:${row.retryAttempt}`;
  const input = { paymentIntentId: row.settlementIntentId, orderRef: row.orderId, amountMinor: 200, currency: "XXX",
    idempotencyKey: key, providerIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}`,
    providerRequestFingerprint: row.requestFingerprint, paymentMethodRef };
  return { key, input, result: await api.createPostgresRetryStore(db).prepare(row.operationId, key, input, at) };
}

it("reports unpaid intents before provider attachment and takes one read-only cut across verified settlement", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const unsent = await prepareWebhookRenewal(target, "succeeded", "unbound");
    const beforeCut = await prepareWebhookRenewal(target), afterCut = await prepareWebhookRenewal(target);
    const fresh = await prepareIncumbent(await upgradeRenewal(target, { edited: false }));
    const future = await upgradeRenewal(target, { edited: false });
    const dormant = await upgradeRenewal(target), tagged = await dormant.claim();
    await owner.query(`UPDATE public.subscription_renewal_operations
      SET cycle_snapshot = cycle_snapshot || '{"contractVersion":"platform.subscription.renewal.v3"}'::jsonb WHERE id=$1`, [tagged.operationId]);
    const replay = () => db.query(rawPrepare, [afterCut.id, afterCut.op.claimToken, now]);
    const originalReplay = (await replay()).rows, originalWire = await frozenOperation(db, afterCut.id);
    await applyForward();
    expect((await replay()).rows).toEqual(originalReplay);
    const newOperation = await future.claim();
    await resizeForRenewal(future.f, upgradeTransaction(db));
    expect((await owner.query("SELECT renewal_operation_id FROM public.subscription_renewal_upgrade_cohort WHERE renewal_operation_id=ANY($1)",
      [[fresh.op.operationId, tagged.operationId, newOperation.operationId]])).rows).toEqual([]);
    const before = await allPublicRows(owner);
    const first = await renewalUpgradeReport(owner);
    expect(first.map(row => row.operation_id)).toEqual([unsent.id, beforeCut.id, afterCut.id].sort());
    expect(first).toContainEqual(reportRow(unsent.id, ["prepared_first_charge", "unpaid_intent"], {
      frozen_amount_minor: 200, currency: "XXX",
      payment_artifacts: [expect.objectContaining({ intent_id: unsent.prepared.settlementIntentId, intent_state: "created",
        provider_state: null, provider_attempt_id: null, retry_id: null })],
    }));
    expect(await allPublicRows(owner)).toEqual(before);
    const atCut = await renewalUpgradeReport(owner, { beforeCut: beforeCut.deliver, afterCut: afterCut.deliver });
    expect(atCut.map(row => row.operation_id)).toEqual([unsent.id, afterCut.id].sort());
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(unsent.id, ["unpaid_intent"])]);
    expect(await frozenOperation(db, afterCut.id)).toEqual(originalWire);
    expect(await renewalAmounts(db, afterCut.prepared.orderId)).toEqual([{ order: 200, intent: 200 }]);
    // Exact stored ownership stays visible through order/cycle lineage without the optional direct intent link.
    await owner.query("UPDATE public.commerce_settlement_intents SET renewal_operation_id=NULL,renewal_operation_fingerprint=NULL WHERE id=$1",
      [unsent.prepared.settlementIntentId]);
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(unsent.id, ["unpaid_intent"])]);
    await unsent.attachIntent();
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(unsent.id, ["provider_attempt", "record_attempt"])]);
    await owner.query("UPDATE public.commerce_settlement_intents SET renewal_operation_id=$2,renewal_operation_fingerprint=$3 WHERE id=$1",
      [unsent.prepared.settlementIntentId, unsent.id, unsent.op.operationFingerprint]);
    await closeUnsent(unsent, target);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

async function reopenAbsentAttempt(owner: Pool, entry: Awaited<ReturnType<typeof prepareWebhookRenewal>>, paymentAttemptId: string) {
  // Fixture the age, then use PostgreSQL's current clock for the verified absence.
  await owner.query(`UPDATE public.payment_provider_attempts
    SET created_at=now()-interval '1 hour',updated_at=now()-interval '1 hour' WHERE id=$1`, [paymentAttemptId]);
  const { settlementIntentId, cycleId } = entry.prepared;
  await owner.query(`UPDATE public.payment_provider_states
    SET created_at=now()-interval '1 hour',updated_at=now()-interval '1 hour' WHERE id=$1`, [settlementIntentId]);
  const checkedAt = (await owner.query("SELECT now()::text AS t")).rows[0].t;
  await entry.rail.reconciliation.recordEvidence({ idempotencyKey: `probe:${paymentAttemptId}`, provider: entry.rail.provider,
    providerPaymentId: null, paymentIntentId: settlementIntentId, paymentAttemptId,
    localStatus: "created", providerStatus: "prepared_without_provider_ack", correctionStatus: "observed",
    checkedAt, payload: {} });
  expect(await entry.rail.reconciliation.reopenPreparedAttemptAfterAbsence({ idempotencyKey: `reopen:${paymentAttemptId}`,
    paymentAttemptId, expectedPaymentIntentId: settlementIntentId, expectedSubscriptionCycleId: cycleId,
    operatorRef: "operator.fixture", absenceCheckedAt: checkedAt, nextRetryAt: checkedAt,
    absenceEvidence: { providerAbsenceConfirmed: true },
  })).toEqual({ replayed: false });
}

it("reports local provider preparation through verified absence and fresh preparation", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const profile = (await db.query("SELECT provider FROM public.payment_provider_profile(NULL) WHERE renewal_absence ORDER BY provider LIMIT 1")).rows[0];
    const local = await prepareWebhookRenewal(target, "succeeded", "intent", String(profile.provider));
    await applyForward();
    const request = { attemptRef: local.preparation.idempotencyKey, intentRef: local.prepared.settlementIntentId,
      fingerprint: local.op.operationFingerprint, providerIdempotencyKey: local.preparation.providerIdempotencyKey,
      money: { amountMinor: 200, currency: "XXX" }, mode: "test" as const, purpose: "renewal-unattended" as const,
      orderRef: local.prepared.orderId, clientId: local.d.due.clientId, customerRef: local.d.due.payerAccountRef!,
      storedMethod: { reference: local.methodRef, mandate: { recurringModel: null } } };
    await expect(local.rail.execute(request)).rejects.toThrow("unexpected_provider_request");
    expect(local.execute.mock.calls.map(([input]) => input.money.amountMinor)).toEqual([200]);
    const saved = (await local.rail.readAttempt(local.prepared.settlementIntentId))!.paymentAttempt;
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(local.id, ["provider_attempt"], {
      payment_artifacts: [expect.objectContaining({ provider_attempt_id: saved.id,
        provider_attempt_state: "created", provider_has_remote_reference: false })],
    })]);
    await reopenAbsentAttempt(owner, local, saved.id);
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(local.id, ["provider_attempt", "record_attempt"], {
      payment_artifacts: [expect.objectContaining({ provider_attempt_id: saved.id, provider_attempt_state: "cancelled" })],
    })]);
    const next = await local.rail.control.prepareProviderAttempt({ ...local.preparation,
      idempotencyKey: `fresh:${local.id}`, providerIdempotencyKey: `fresh-provider:${local.id}` });
    expect(next).toMatchObject({ replayed: false });
    expect(next.paymentAttemptId).not.toBe(saved.id);
    await reopenAbsentAttempt(owner, local, next.paymentAttemptId);
    await closeUnsent(local, target);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports independent recordAttempt for a refused renewal with no retry", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const entry = await prepareWebhookRenewal(target, "succeeded", "intent");
    await applyForward();
    await entry.d.input.settlement.recordTerminalOutcome({ operationId: entry.id, operationFingerprint: entry.op.operationFingerprint,
      outcome: "refused", eventKey: `locally-refused:${entry.id}`, reason: "verified_no_dispatch", occurredAt: later, externalRef: null });
    const unresolved = reportRow(entry.id, ["record_attempt"], {
      operation_state: "refused", payment_artifacts: [expect.objectContaining({ retry_id: null })],
    });
    expect(await renewalUpgradeReport(owner)).toEqual([unresolved]);
    const record = { idempotencyKey: `record:${entry.id}`, paymentIntentId: entry.prepared.settlementIntentId, provider: webhookProvider,
      providerAttemptId: null, providerSessionId: null, attemptStatus: "blocked_preflight" as const, nextActionKind: null,
      requestPayload: {}, responsePayload: { providerCall: false } };
    const result = await entry.rail.control.recordAttempt(record);
    expect(result).toMatchObject({ replayed: false });
    expect(await entry.rail.control.recordAttempt(record)).toEqual({ ...result, replayed: true });
    expect((await owner.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE event_type='commerce.payment_attempt.requested' AND idempotency_key=$1",
      [record.idempotencyKey])).rows).toEqual([{ n: 1 }]);
    expect(await renewalUpgradeReport(owner)).toEqual([unresolved]);
    // The OMS owner closes the open provider state on an unpaid order.
    await closeOrder(target, entry.prepared.orderId);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports an older provider attempt behind the active pointer until its verified closure", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const profile = (await db.query("SELECT provider FROM public.payment_provider_profile(NULL) WHERE renewal_absence ORDER BY provider LIMIT 1")).rows[0];
    const open = await prepareWebhookRenewal(target, "succeeded", "intent", String(profile.provider));
    const settled = await prepareWebhookRenewal(target, "succeeded", "intent");
    const older = await open.rail.control.prepareProviderAttempt(open.preparation);
    const olderSettled = await settled.rail.control.prepareProviderAttempt(settled.preparation);
    const record = (entry: typeof open, remote: string | null) => entry.rail.control.recordAttempt({
      idempotencyKey: `newer-attempt:${entry.id}`, paymentIntentId: entry.prepared.settlementIntentId,
      provider: entry.rail.provider, providerAttemptId: remote, providerSessionId: null,
      attemptStatus: remote ? "processing" : "blocked_preflight", nextActionKind: null,
      requestPayload: {}, responsePayload: { providerCall: remote !== null },
    });
    const newer = await record(open, null), remote = `pi_newer_${settled.id}`;
    const newerSettled = await record(settled, remote);
    await settled.d.input.settlement.acknowledgeExternalAttempt({ operationId: settled.id,
      operationFingerprint: settled.op.operationFingerprint, externalAttemptRef: remote, acknowledgedAt: now });
    await settled.deliver({ providerPaymentRef: remote });
    await applyForward();
    const expected = [
      { entry: open, prior: older.paymentAttemptId, active: newer.id, paid: false },
      { entry: settled, prior: olderSettled.paymentAttemptId, active: newerSettled.id, paid: true },
    ].sort((a, b) => a.entry.id.localeCompare(b.entry.id));
    expect(await renewalUpgradeReport(owner)).toEqual(expected.map(({ entry, prior, active, paid }) =>
      reportRow(entry.id, ["provider_attempt"], {
        ...(paid ? { operation_state: "succeeded", reasons: ["provider_attempt"] } : {}),
        payment_artifacts: [expect.objectContaining({ provider_attempt_id: active,
          unresolved_provider_attempts: [{ id: prior, status: "created", has_remote_reference: false }],
        })],
      })));

    // The installed absence owner works on the active attempt. Stage that
    // pointer in this disposable fixture and use the real verified-absence writer.
    await owner.query("UPDATE public.payment_provider_states SET active_attempt_id=$2 WHERE id=$1",
      [open.prepared.settlementIntentId, older.paymentAttemptId]);
    await reopenAbsentAttempt(owner, open, older.paymentAttemptId);
    await closeUnsent(open, target);
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(settled.id, ["provider_attempt"])]);
    // The earlier case proves the installed closure. Model the same terminal
    // attempt fact on the already-paid graph to verify report selection there.
    await owner.query("UPDATE public.payment_provider_attempts SET status='cancelled' WHERE id=$1", [olderSettled.paymentAttemptId]);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("keeps the open provider state listed after actual native lifecycle cancellation", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const entry = await prepareWebhookRenewal(target, "failed");
    await applyForward();
    await entry.deliver();
    const store = api.createPostgresSubscriptionCommandStore({ withTransaction: upgradeTransaction(db) });
    expect(await store.apply({ actorId: randomUUID(), clientId: entry.f.clientId, subscriptionId: entry.f.subscriptionId,
      idempotencyKey: `cancel-native:${entry.id}`, action: "cancel", payload: {}, now: later }))
      .toMatchObject({ status: "applied", subscriptionStatus: "cancelled" });
    const unresolved = () => renewalUpgradeReport(owner);
    const expected = expect.objectContaining({ operation_id: entry.id, reasons: ["provider_state_open_after_cancellation"],
      operation_state: "refused", payment_artifacts: [expect.objectContaining({
        order_state: "cancelled", intent_state: "cancelled", cycle_state: "cancelled",
      })],
    });
    expect(await unresolved()).toEqual([expected]);
    await expect(entry.rail.control.prepareProviderAttempt({ ...entry.preparation,
      idempotencyKey: `prepare-cancelled:${entry.id}`, providerIdempotencyKey: `provider-cancelled:${entry.id}`,
    })).rejects.toMatchObject({ code: "22023", message: "payment_control_provider_attempt_prepare_intent_not_retryable" });
    const mounted = binding({ ...entry.d, input: { ...entry.d.input, paymentRails: entry.paymentRails } },
      () => later, upgradeTransaction(db), db);
    expect(await mounted.services.run()).toMatchObject({ renewals: [], retries: [] });
    expect(entry.execute).not.toHaveBeenCalled();
    expect(await unresolved()).toEqual([expected]);
    const record = { idempotencyKey: `record-cancelled:${entry.id}`, paymentIntentId: entry.prepared.settlementIntentId,
      provider: webhookProvider, providerAttemptId: null, providerSessionId: null, attemptStatus: "blocked_preflight" as const,
      nextActionKind: null, requestPayload: {}, responsePayload: { providerCall: false } };
    const saved = await entry.rail.control.recordAttempt(record);
    expect(saved).toMatchObject({ replayed: false });
    expect(await entry.rail.control.recordAttempt(record)).toEqual({ ...saved, replayed: true });
    await closeOrder(target, entry.prepared.orderId);
    expect(await unresolved()).toEqual([expected]);
    // Stage the terminal provider fact in this disposable fixture.
    const closed = await owner.query(`UPDATE public.payment_provider_states
      SET status='cancelled', payment_status='cancelled' WHERE id=$1 RETURNING id`, [entry.prepared.settlementIntentId]);
    expect(closed.rows).toEqual([{ id: entry.prepared.settlementIntentId }]);
    expect(await unresolved()).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports simulator begin and synthetic ACK before dispatch and through unobserved ACK", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const sandbox = payments.createPostgresSandboxPaymentSimulator(db,
      { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
    const simulator = await prepareIncumbent(await upgradeRenewal(target));
    const synthetic = await prepareIncumbent(await upgradeRenewal(target, { scenario: "ambiguous" }));
    const request = synthetic.d.input.policy.executionInput(synthetic.d.due, synthetic.op, synthetic.prepared);
    await applyForward();
    const rows = await renewalUpgradeReport(owner);
    expect(rows.map(row => row.operation_id)).toEqual([simulator.op.operationId, synthetic.op.operationId].sort());
    expect(rows).toEqual(expect.arrayContaining([
      reportRow(simulator.op.operationId, ["sandbox_attempt"]),
      reportRow(synthetic.op.operationId, ["sandbox_ack"]),
    ]));
    const simulatorInput = { settlementIntentId: simulator.prepared.settlementIntentId, idempotencyKey: `sandbox:${simulator.op.operationId}`,
      requestFingerprint: simulator.op.operationFingerprint, at: now };
    const attempt = await sandbox.beginAttempt(simulatorInput);
    expect(await sandbox.beginAttempt(simulatorInput)).toMatchObject({ id: attempt.id, replayed: true });
    await sandbox.recordObservation({ attemptId: attempt.id, idempotencyKey: `expiry:${attempt.id}`, outcome: "expired", occurredAt: later });
    const next = await sandbox.beginAttempt({ ...simulatorInput, idempotencyKey: `sandbox-next:${simulator.op.operationId}`, at: later });
    expect(next.id).not.toBe(attempt.id);
    expect(await renewalUpgradeReport(owner)).toContainEqual(reportRow(simulator.op.operationId, ["sandbox_attempt"], {
      payment_artifacts: [expect.objectContaining({ simulator_attempt_id: next.id, simulator_attempt_state: "dispatched" })],
    }));
    await sandbox.recordObservation({ attemptId: next.id, idempotencyKey: `refusal:${next.id}`, outcome: "refused", occurredAt: later });
    await closeUnsent(simulator, target);
    const acknowledged = await synthetic.d.rail.execute(request);
    expect(acknowledged.externalAttemptRef).toBeTruthy();
    expect(await synthetic.d.rail.execute(request)).toEqual(acknowledged);
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(synthetic.op.operationId, ["sandbox_ack"], {
      payment_artifacts: [expect.objectContaining({ simulator_attempt_id: null })],
    })]);
    await synthetic.d.rail.observe({ operationId: synthetic.op.operationId, fingerprint: synthetic.op.operationFingerprint,
      externalAttemptRef: acknowledged.externalAttemptRef!, outcome: "succeeded", occurredAt: later });
    await synthetic.d.input.settlement.recordTerminalOutcome({ operationId: synthetic.op.operationId,
      operationFingerprint: synthetic.op.operationFingerprint, outcome: "succeeded", occurredAt: later,
      eventKey: `upgrade-settle:${synthetic.op.operationId}`, externalRef: acknowledged.externalAttemptRef });
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);




async function retryOutcome(entry: Awaited<ReturnType<typeof prepareWebhookRenewal>>, db: Pool, remote: boolean) {
  const waiting = (await api.createPostgresRetryStore(db).read(entry.id))!;
  const at = waiting.nextRetryAt!;
  const { input, result } = await prepareRetry(db, waiting, entry.methodRef, at);
  expect(result).toMatchObject({ execute: true, replayed: false, attemptSequence: 1 });
  const request = { ...entry.preparation, ...input };
  const { paymentAttemptId } = await entry.rail.control.prepareProviderAttempt(request);
  const providerPaymentId = `pi_${paymentAttemptId}`;
  const finalize = () => entry.rail.control.finalizeProviderAttempt({
    ...request, idempotencyKey: `finalize:${paymentAttemptId}`, paymentAttemptId,
    providerAttemptId: providerPaymentId, providerSessionId: null,
    attemptStatus: "processing", nextActionKind: null, responsePayload: {},
  });
  if (remote) await finalize();
  return {
    paymentAttemptId, at, finalize, async applyFailure() {
      const attempt = (await entry.rail.readAttempt(waiting.settlementIntentId, paymentAttemptId))!;
      return entry.rail.reconciliation.applyTerminalResult({
        idempotencyKey: `observed:${paymentAttemptId}`, expectedOrderId: waiting.orderId,
        expectedPaymentIntentId: waiting.settlementIntentId, expectedPaymentAttemptId: paymentAttemptId,
        expectedPaymentId: attempt.paymentAttempt.paymentId, provider: webhookProvider, providerPaymentId,
        localStatus: "processing", providerStatus: "failed", resultStatus: "failed", occurredAt: at, checkedAt: at,
        failureReason: "declined", failureClassification: { failureClass: "soft_retryable", decidedBy: "fixture" }, payload: {},
      });
    },
    deliverCapture: () => entry.deliver({ providerPaymentRef: providerPaymentId, providerEventId: `capture:${paymentAttemptId}`,
      providerOccurredAt: at, outcome: "succeeded" }),
  };
}

it("reports receipt-only and both provider-prepared retries by the exact current request", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const receipt = await prepareWebhookRenewal(target, "failed");
    const local = await prepareWebhookRenewal(target, "failed");
    const remote = await prepareWebhookRenewal(target, "failed");
    for (const entry of [receipt, local, remote]) await entry.deliver();
    const store = api.createPostgresRetryStore(db);
    const waiting = (await store.read(receipt.id))!;
    const prepared = await prepareRetry(db, waiting, receipt.methodRef, waiting.nextRetryAt!);
    expect(await store.prepare(receipt.id, prepared.key, prepared.input, waiting.nextRetryAt!))
      .toMatchObject({ execute: false, replayed: true, attemptSequence: 1 });
    const savedLocal = await retryOutcome(local, db, false), savedRemote = await retryOutcome(remote, db, true);
    // An older active pointer and prior remote reference cannot identify the current request.
    await owner.query("UPDATE public.payment_provider_states SET active_attempt_id=$2 WHERE id=$1",
      [local.prepared.settlementIntentId, local.paymentAttemptId]);
    await applyForward();
    const rows = await renewalUpgradeReport(owner);
    expect(rows.map(row => row.operation_id)).toEqual([receipt.id, local.id, remote.id].sort());
    for (const [entry, exact, hasRemote] of [[receipt, null, false], [local, savedLocal.paymentAttemptId, false],
      [remote, savedRemote.paymentAttemptId, true]] as const) {
      expect(rows).toContainEqual(reportRow(entry.id, ["retry"], { payment_artifacts: [expect.objectContaining({
        retry_state: "prepared", retry_attempt: 1, attempt_sequence: 1, prepare_receipt_id: expect.any(String),
        retry_attempt_id: exact, retry_has_remote_reference: hasRemote,
      })] }));
    }
    await closeOrder(target, receipt.prepared.orderId);
    await owner.query("UPDATE public.payment_provider_states SET active_attempt_id=$2 WHERE id=$1",
      [local.prepared.settlementIntentId, savedLocal.paymentAttemptId]);
    await savedLocal.finalize();
    expect(await savedLocal.applyFailure()).toMatchObject({ correctionStatus: "corrected" });
    await closeOrder(target, local.prepared.orderId);
    await savedRemote.deliverCapture();
    expect(await store.read(remote.id)).toMatchObject({ state: "recovered" });
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports waiting, quarantined, unscheduled, and recovery-authorized retries without dispatching them", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const exhausted = await upgradeRenewal(target, { scenario: "declined" });
    const exhaustedId = (await runPreForwardRenewal(exhausted)).operationId;
    const store = api.createPostgresRetryStore(db);
    for (let n = 0; n < 3; n++) {
      const retryAt = (await store.read(exhaustedId))!.nextRetryAt!;
      expect(await retryDriver(exhausted.d, "declined", retryAt, undefined, predecessorRetryTarget(db)).driver.run(retryAt, 1))
        .toEqual([{ operationId: exhaustedId, status: "refused" }]);
    }
    const future = await upgradeRenewal(target, { scenario: "declined" }), quarantined = await upgradeRenewal(target, { scenario: "declined" });
    const futureId = (await runPreForwardRenewal(future)).operationId, quarantinedId = (await runPreForwardRenewal(quarantined)).operationId;
    const until = days(later, 20);
    await owner.query("UPDATE public.subscription_retry_obligations SET renewal_quarantined_until=$2 WHERE renewal_operation_id=$1", [quarantinedId, until]);
    await applyForward();
    let rows = await renewalUpgradeReport(owner);
    expect(rows.map(row => row.operation_id)).toEqual([exhaustedId, futureId, quarantinedId].sort());
    expect(rows).toEqual(expect.arrayContaining([
      reportRow(exhaustedId, ["retry"], { payment_artifacts: [expect.objectContaining({ retry_state: "waiting", retry_attempt: 4, next_retry_at: null })] }),
      reportRow(futureId, ["retry"], { payment_artifacts: [expect.objectContaining({ retry_state: "waiting", next_retry_at: expect.any(String), renewal_quarantined_until: null })] }),
      reportRow(quarantinedId, ["retry"], { payment_artifacts: [expect.objectContaining({ retry_state: "waiting", renewal_quarantined_until: expect.any(String) })] }),
    ]));
    const saved = (await store.read(exhaustedId))!;
    const liveNow = (await owner.query("SELECT now() AS now")).rows[0].now.toISOString();
    const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
    await rpc("dunning_lifecycle_issue_recovery_token", [saved.caseId, tokenHash, days(liveNow, 2)], db);
    const token = (await db.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [tokenHash])).rows[0].id;
    const auth = await store.authorizeRecovery(exhaustedId, token, facts.methodRef, "fresh-sandbox-evidence", liveNow);
    await store.scheduleRecovery(exhaustedId, `schedule:${exhaustedId}`, String(auth.id), liveNow);
    rows = await renewalUpgradeReport(owner);
    expect(rows).toContainEqual(reportRow(exhaustedId, ["retry"], { payment_artifacts: [
      expect.objectContaining({ retry_state: "waiting", retry_attempt: 4, next_retry_at: expect.any(String) }),
    ] }));
    for (const [entry, id] of [[exhausted, exhaustedId], [future, futureId], [quarantined, quarantinedId]] as const) {
      await closeWaitingRetry(db, entry, id, until);
    }
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it.each(["missing", "behind", "conflict"] as const)("reports a provider failure handoff with a %s case", async shape => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const entry = await prepareWebhookRenewal(target, "failed");
    await applyForward();
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(entry.id, ["provider_attempt"], { payment_artifacts: [
      expect.objectContaining({ provider_has_remote_reference: true }),
    ] })]);
    if (shape === "missing") {
      await interruptProviderHandoff(owner, entry.deliver);
    } else {
      await entry.deliver();
      const retry = await retryOutcome(entry, db, true);
      expect(await interruptProviderHandoff(owner, () => retry.applyFailure()))
        .toMatchObject({ correctionStatus: "corrected", subscriptionWebhookDunning: { opened: false } });
      if (shape === "conflict") {
        // Advance the existing case through the native failure owner. Its original provider attribution remains.
        await rpc("subscription_retry_open_case", [entry.id, "failed", "/recover"], db);
        await expect(rpc("payment_reconciliation_open_dunning_from_failed_result", [
          `handoff-conflict:${entry.id}`, entry.prepared.settlementIntentId, null, "declined", retry.at, "soft_retryable",
          retry.paymentAttemptId, "failed", "/recover",
        ], db)).rejects.toMatchObject({ code: "55000", message: "subscription_dunning_failed_attempt_ambiguous" });
      }
    }
    const handoff = { missing: "case_missing", behind: "case_behind", conflict: "case_attribution_conflict" }[shape];
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(entry.id, ["retry", "failure_handoff"], {
      operation_state: "refused", payment_artifacts: [expect.objectContaining({
        failure_receipt_id: expect.any(String), failure_handoff: handoff,
      })],
    })]);
    if (shape !== "conflict") {
      await entry.recoverDunning();
      expect(await renewalUpgradeReport(owner)).toEqual([reportRow(entry.id, ["retry"])]);
    }
    await closeOrder(target, entry.prepared.orderId);
    await closeWaitingRetry(db, entry, entry.id, later);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it("reports a committed driver failure while separate case propagation is interrupted", async () => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target;
    const entry = await upgradeRenewal(target, { scenario: "declined" });
    const root = await runPreForwardRenewal(entry), store = api.createPostgresRetryStore(db);
    const wait = (await store.read(root.operationId))!, retryAt = wait.nextRetryAt!;
    const retry = retryDriver(entry.d, "ambiguous", retryAt, undefined, predecessorRetryTarget(db));
    expect(await retry.driver.run(retryAt, 1)).toEqual([{ operationId: root.operationId, status: "awaiting_provider" }]);
    const sandbox = payments.createPostgresSandboxPaymentSimulator(db,
      { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
    const attempt = (await sandbox.readAttempt({ settlementIntentId: wait.settlementIntentId }))!;
    const observation = await sandbox.recordObservation({ attemptId: attempt.id, idempotencyKey: `failed:${attempt.id}`,
      outcome: "refused", occurredAt: retryAt });
    const failure = { attemptSequence: 1, logicalCycleNumber: wait.logicalCycleNumber, occurredAt: retryAt,
      failureClass: "temporary", reason: "declined", externalRef: attempt.id,
      evidenceKey: `sandbox:${observation.id}`, firstRecordedAt: retryAt };
    const failureKey = `failure:${observation.id}`;
    // A previously committed driver receipt can survive an interrupted case handoff.
    expect(await store.applyFailure(root.operationId, failureKey, failure))
      .toMatchObject({ state: "waiting", retryAttempt: 2 });
    const interrupted = api.createNativeRetryDriver({ ...retry.options, withTransaction: work => transaction(async tx => work({
      query(sql, values) {
        if (sql.includes("subscription_retry_open_case")) throw new Error("case_propagation_interrupted");
        return tx.query(sql, values);
      },
    }), db) });
    await expect(interrupted.propagateFailure(root.operationId, failureKey, failure)).rejects.toThrow("case_propagation_interrupted");
    expect(await store.read(root.operationId)).toMatchObject({ state: "waiting", retryAttempt: 2 });
    await applyForward();
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(root.operationId, ["failure_handoff", "retry"], {
      payment_artifacts: [expect.objectContaining({ failure_handoff: "case_behind", case_rung: 1, retry_attempt: 2 })],
    })]);
    await rpc("subscription_retry_open_case", [root.operationId, "failed", "/recover"], db);
    expect(await renewalUpgradeReport(owner)).toEqual([reportRow(root.operationId, ["retry"])]);
    await closeWaitingRetry(db, entry, root.operationId, retryAt);
    expect(await renewalUpgradeReport(owner)).toEqual([]);
  });
}, postgresSetupTimeoutMs);

it.each([true, false])("requires draining in-flight renewal dispatch before the forward (drain first: %s)", async drainFirst => {
  await withTemplateUpgrade(async target => {
    const { owner, db, applyForward } = target, transact = upgradeTransaction(db);
    const first = await upgradeRenewal(target, { scenario: "declined" });
    const separate = await upgradeRenewal(target, { scenario: "declined", claimAt: days(now, 2) });
    const firstId = (await runPreForwardRenewal(first)).operationId;
    const separateId = (await runPreForwardRenewal(separate, days(now, 2))).operationId;
    const store = api.createPostgresRetryStore(db);
    const firstAt = (await store.read(firstId))!.nextRetryAt!, separateAt = (await store.read(separateId))!.nextRetryAt!;
    const retry = retryDriver(first.d, "ambiguous", firstAt, undefined, predecessorRetryTarget(db));
    const atDispatch = signal(), release = signal();
    const charges: number[] = [];
    let forwardStarted = false;
    const pending = binding(first.d, () => firstAt, transact, db, { ...retry.options, payments: { ...retry.options.payments,
      async execute(input) {
        atDispatch.resolve();
        await release.promise;
        if (forwardStarted) charges.push(input.amountMinor);
        return retry.execute(input);
      },
    } }).services.run();
    try {
      await Promise.race([atDispatch.promise, pending.then(() => { throw new Error("retry_finished_before_dispatch_barrier"); })]);
      if (drainFirst) {
        release.resolve();
        expect(await pending).toMatchObject({ retries: [{ operationId: firstId, status: "awaiting_provider" }] });
      }
      forwardStarted = true;
      expect((await applyForward()).applied).toEqual([expect.stringMatching(renewalTemplateForward)]);
      if (!drainFirst) {
        release.resolve();
        await pending;
        expect(charges).toEqual([200]);
        return;
      }
      expect((await renewalUpgradeReport(owner)).map(row => row.operation_id)).toEqual([firstId, separateId].sort());
      const reconcile = retryDriver(first.d, "succeeded", firstAt, undefined, predecessorRetryTarget(db));
      expect(await reconcile.driver.run(firstAt, 1)).toEqual([{ operationId: firstId, status: "succeeded" }]);
      expect(reconcile.execute).not.toHaveBeenCalled();
      await closeWaitingRetry(db, separate, separateId, separateAt);
      expect(await renewalUpgradeReport(owner)).toEqual([]);
      const resumed = retryDriver(first.d, "ambiguous", separateAt, undefined, predecessorRetryTarget(db));
      expect(await binding(first.d, () => separateAt, transact, db, resumed.options).services.run()).toMatchObject({ retries: [], renewals: [] });
      expect(resumed.execute).not.toHaveBeenCalled();
      expect(charges).toEqual([]);
    } finally {
      release.resolve();
      await pending;
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
    for (const { file } of [baseline, ...forward.slice(0, boundary)]) await owner.query(readFileSync(file, "utf8"));
    const claimAcl = await generationAcl(owner, dueClaimSignature);
    await owner.query(readFileSync(forward[boundary]!.file, "utf8"));
    await owner.query("CREATE ROLE renewal_unrelated NOLOGIN");
    expect((await owner.query("SELECT to_regrole('service_role') AS service")).rows).toEqual([{ service: null }]);
    expect(await generationAcl(owner)).toEqual([{ owner: "postgres", definer: false, volatility: "s",
      config: ["search_path=pg_catalog, pg_temp"], acl: [["postgres", "EXECUTE", false]] }]);
    expect(await generationAcl(owner, dueClaimSignature)).toEqual(claimAcl);
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

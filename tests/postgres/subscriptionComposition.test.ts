import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { createPostgresRetryStore } from "@openlup/platform/subscriptions";
import * as subscriptions from "@openlup/platform/subscriptions";
import type { AutomaticRenewalRunResult, NativeRenewalCodec, SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { RenewalDue, RenewalExecutionRequest, RenewalFrozenSnapshot, RenewalReadback, RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";
import { createM10SubscriptionReferenceBinding } from "../../server/runtime/public-reference/m10SubscriptionBinding.js";
import { createM10RetryDriver } from "../../server/runtime/public-reference/m10RetryDriver.js";
import { createPostgresRenewalSettlementPort } from "../../server/adapters/postgres/commerce/renewalSettlement.js";
import { nativeHarness, openCase } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, failure, later, prepareOriginal, renewal, request, unchangedIdentity, type Renewal } from "./subscriptionNativeFixture.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";

const h = nativeHarness("m10-composition");
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);
beforeEach(async () => {
  // Retire prior synthetic fixtures in this owned disposable database only.
  await h.pool.query("UPDATE public.subscriptions SET status='cancelled'");
});
const transaction = async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T> => {
  const db = await h.pool.connect();
  try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
};
function bind(f: Renewal, enabled = true, ambiguous?: Renewal) {
  let now = later(1), method = "frozen-method", declined = false, ready = true;
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
    freeze: () => { throw new Error("must_resume_original_snapshot"); }, encode: () => f.snapshot,
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
  const evidence = (external: string, event: string) => ({
    status: declined ? "failed" as const : "succeeded" as const, disposition: "observed" as const,
    operationId: f.operation, eventKey: event, requestFingerprint: f.fingerprint, verifiedEvidenceRef: `${event}:verified`,
    externalAttemptRef: external, occurredAt: now, observedAt: now, firstRecordedAt: now,
    amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", reason: declined ? "declined" : null,
  });
  const queries: string[] = [];
  const executor = { async query(sql: string, values?: unknown[]) { queries.push(sql); return h.pool.query(sql, values); } };
  const retryOptions = { executor, withTransaction: transaction, decode: codec.decode,
    readFrozenMandate: async () => ({ authorized: true, authorizationRef: "frozen-mandate", paymentMethodRef: "frozen-method" }),
    retryInput: (_snapshot: RenewalFrozenSnapshot, row: { settlementIntentId: string; orderId: string; retryAttempt: number }) => execution(row.settlementIntentId, row.orderId, `${f.identity}:retry:${row.retryAttempt}`),
    validateInput: () => {}, payments: { execute, readOutcome: async (prepared: { attemptSequence: number }) => evidence(`retry-${prepared.attemptSequence}`, `${f.identity}:retry-outcome:${prepared.attemptSequence}`) },
    failureTemplate: "failed", recoveredTemplate: "recovered", recoveryPath: "/repair", classifyFailure: () => "temporary",
  };
  const lease = vi.fn();
  const withRunLease = async <T>(population: string, work: () => Promise<T>): Promise<T | null> => {
    lease(population);
    const db = await h.pool.connect();
    try {
      const result = await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [population]);
      if (!result.rows[0].acquired) return null;
      try { return await work(); } finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [population]); }
    } finally { db.release(); }
  };
  const readiness = vi.fn(async () => ({ state: ready ? "ready" as const : "unknown" as const, candidate: { artifact: "fixture", configuration: "fixture", environment: "disposable", database: "fixture", schema: "complete" }, loadedPackages: [], issues: [] }));
  const binding = createM10SubscriptionReferenceBinding({
    enabled, population: `fixture:${f.subscription}`, executor, withTransaction: transaction, withRunLease, codec,
    settlement: db => createPostgresRenewalSettlementPort(db) as unknown as RenewalSettlementPort,
    inventory: createPostgresRenewalReservationPort(h.pool),
    paymentRails: { resolve: () => ({ execute, findExternalAttempt: async () => "original-ack", readOutcome: async () => evidence("original-ack", `${f.identity}:original-evidence`) }) },
    policy: { executionInput: (_due, _operation, prepared) => execution(prepared.settlementIntentId, prepared.orderId, `${f.identity}:original`), validateInput: () => {}, classifyFailure: () => "temporary", identityKey: row => row.subscriptionId === ambiguous?.subscription ? ambiguous.identity : f.identity },
    retry: retryOptions, failureTemplate: "failed", recoveryPath: "/repair", workerId: "composed", now: () => now,
    version: "0.24.0", catalogue: { version: "complete-test-catalogue", migration: "native-test-catalogue" }, readiness, cadenceSeconds: 60,
  });
  return { binding, codec, snapshot, queries, execute, lease, readiness, retryOptions,
    time: (value: string) => { now = value; }, method: (value: string) => { method = value; }, decline: () => { declined = true; }, unready: () => { ready = false; } };
}
async function predecessor(f: Renewal, mode: string) {
  const cycle = randomUUID(), order = randomUUID(), shipment = randomUUID(), operation = randomUUID();
  await h.pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,terminal_outcome,terminal_at)
    VALUES($1,$2,'2026-08-04T12:00:00Z',1,public.subscription_renewal_identity($2,'2026-08-04T12:00:00Z'),$3,'{}','succeeded',$4,'fixture',$5,$5::timestamptz+interval '5 minutes','succeeded',$5)`, [operation, f.subscription, "a".repeat(64), randomUUID(), AT]);
  await h.pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,'2026-08-04T12:00:00Z','paid',$3,$4)", [cycle, f.subscription, operation, "a".repeat(64)]);
  await transaction(async db => {
    await db.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'paid','XXX',200)", [order, f.client, cycle]);
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,2,100,200)", [order]);
  });
  await h.pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('fixture-port','3pl',true) ON CONFLICT DO NOTHING");
  await h.pool.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'fixture-port','3pl',$3)", [shipment, order, `shipment:${shipment}`]);
  await openCase(h.pool, { ...f, token: randomUUID(), cycle, order, shipment, operation }, mode);
  return shipment;
}

it.each(["off", "protect", "arrival", "rollback", "dunning", "stock", "prepared", "static"] as const)("composes %s through one executor without interrupting the subscription", async scenario => {
  const f = await renewal(h.pool, scenario === "stock" ? 0 : 10), b = bind(f);
  expect(b.binding.contributions[0].schedules).toHaveLength(1);
  expect(Object.values(b.binding.triggers)).toEqual([b.binding.services.run]);
  expect(b.binding.services.capabilities.stockRecovery).toBe("selected");
  if (["protect", "arrival", "rollback"].includes(scenario)) {
    const shipment = await predecessor(f, "protect");
    const first = await b.binding.services.run();
    expect(first).toMatchObject({ renewals: [{ status: "deferred" }] }); expect(b.execute).not.toHaveBeenCalled();
    expect((await call(h.pool, "subscription_read_renewal", [f.identity])).state).toBe("claimed");
    await call(h.pool, "subscription_delivery_alignment_set_mode", ["off"]);
    b.time(later(2));
    expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "deferred" }] });
    if (scenario !== "protect") {
      await call(h.pool, "fulfillment_record_alignment_arrival", [`arrival:${shipment}`, shipment, later(3), `evidence:${shipment}`]);
      await h.pool.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=999 WHERE subscription_id=$1", [f.subscription]);
      b.time(later(4));
      expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "succeeded" }] });
      expect(b.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ amountMinor: f.snapshot.totalAmountMinor }));
      expect((await h.pool.query("SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ state: "released" }]);
    }
  } else if (scenario === "dunning") {
    b.decline();
    expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "refused" }] });
    expect(await createPostgresRetryStore(h.pool).read(f.operation)).toMatchObject({ state: "waiting", retryAttempt: 1 });
    const before = b.queries.filter(sql => sql.includes("subscription_delivery_alignment_admit_renewal(")).length;
    b.time(later(26));
    expect(await b.binding.services.run()).toMatchObject({ retries: [{ status: "refused" }] });
    expect(b.queries.filter(sql => sql.includes("subscription_delivery_alignment_admit_renewal(")).length).toBe(before);
    expect(await createPostgresRetryStore(h.pool).read(f.operation)).toMatchObject({ retryAttempt: 2 });
    expect(b.execute).toHaveBeenCalledTimes(2);
  } else if (scenario === "stock") {
    expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "refused", reason: "inventory_unavailable" }] });
    expect(b.execute).not.toHaveBeenCalled();
    await h.pool.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=10,total_quantity=10 WHERE source_key=$1", [f.source]);
    b.time(later(2));
    expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "succeeded" }] });
    expect(b.execute).toHaveBeenCalledTimes(1);
    const order = (await h.pool.query("SELECT id FROM public.commerce_orders WHERE renewal_operation_id=$1", [f.operation])).rows[0].id;
    await expect(b.binding.realizationAdmitted(order)).rejects.toThrow("realization_admission_missing");
    await h.pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('fixture-port','3pl',true) ON CONFLICT DO NOTHING");
    await h.pool.query("INSERT INTO public.fulfillment_shipments(order_id,port_key,provider_type,create_idempotency_key) VALUES($1,'fixture-port','3pl',$2)", [order, `realized:${order}`]);
    expect(await b.binding.realizationAdmitted(order)).toMatchObject({ state: "resumed" });
    expect(await b.binding.realizationAdmitted(order)).toMatchObject({ state: "resumed" });
    expect((await h.pool.query("SELECT event_type FROM public.outbox_events WHERE aggregate_id=(SELECT id FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=$1) ORDER BY event_type", [f.operation])).rows)
      .toEqual([{ event_type: "subscription_stock_wait.resumed" }, { event_type: "subscription_stock_wait.started" }]);
  } else if (scenario === "prepared") {
    await prepareOriginal(h.pool, f);
    await call(h.pool, "subscription_delivery_alignment_set_mode", ["protect"]);
    expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "succeeded" }] });
    expect(b.execute).not.toHaveBeenCalled();
    expect(b.queries.some(sql => sql.includes("existing_cycle"))).toBe(false);
  } else if (scenario === "static") {
    await h.pool.query("UPDATE public.subscription_renewal_terms SET delivery_admission='blocked',delivery_block_reason='static-block' WHERE subscription_id=$1", [f.subscription]);
    expect(await b.binding.services.run()).toMatchObject({ renewals: [{ status: "refused", reason: "static-block" }] });
    expect(b.queries.some(sql => sql.includes("existing_cycle"))).toBe(false); expect(b.execute).not.toHaveBeenCalled();
  } else {
    const results = await Promise.all([b.binding.services.run(), b.binding.services.run()]);
    expect(results.filter(result => result === null)).toHaveLength(1);
    expect(results.find(result => result !== null)).toMatchObject({ renewals: [{ status: "succeeded" }] });
    expect(b.execute).toHaveBeenCalledTimes(1);
    expect(b.queries.some(sql => sql.includes("subscription_delivery_alignment_admit_renewal("))).toBe(false);
  }
  await unchangedIdentity(h.pool, f);
});
it("default off and unknown readiness refuse before database work or the shared job lease", async () => {
  const f = await renewal(h.pool), off = bind(f, false), unready = bind(f);
  expect(await off.binding.services.run()).toEqual({ kind: "refused", code: "disabled" });
  expect(off.queries).toEqual([]); expect(off.readiness).not.toHaveBeenCalled(); expect(off.lease).not.toHaveBeenCalled();
  expect(off.binding.contributions[0].schedules).toEqual([]);
  unready.unready(); expect(await unready.binding.services.run()).toEqual({ kind: "refused", code: "schema_unknown" });
  expect(unready.queries).toEqual([]); expect(unready.lease).not.toHaveBeenCalled();
});
it("subsequent failure replay after committed propagation has zero delta; interrupted propagation still completes", async () => {
  const f = await renewal(h.pool), original = await prepareOriginal(h.pool, f), store = createPostgresRetryStore(h.pool), b = bind(f);
  const driver = createM10RetryDriver(b.retryOptions);
  await driver.propagateFailure(f.operation, `initial:${f.operation}`, failure());
  await store.prepare(f.operation, `prepare:${f.operation}`, request({ ...f, original }), later(24));
  const input = failure(1, later(25)), key = `retry-failure:${f.operation}`;
  await store.applyFailure(f.operation, key, input); // committed failure with interrupted case propagation
  expect(await store.failureProgress(f.operation, key)).toEqual({ replayed: true, caseAdvanced: false });
  expect(await driver.propagateFailure(f.operation, key, input)).toMatchObject({ replayed: true, caseAdvanced: false });
  expect(await store.failureProgress(f.operation, key)).toEqual({ replayed: true, caseAdvanced: true });
  const before = await allPublicRows(h.pool);
  for (let n = 0; n < 3; n++) expect(await driver.propagateFailure(f.operation, key, input)).toMatchObject({ replayed: true, caseAdvanced: true });
  await expect(driver.propagateFailure(f.operation, key, { ...input, reason: "conflict" })).rejects.toThrow("replay_conflict");
  expect(await allPublicRows(h.pool)).toEqual(before);
  await unchangedIdentity(h.pool, f);
});
it("ordinary retries refuse a method different from the frozen mandate, then recover on the same cycle", async () => {
  const f = await renewal(h.pool), b = bind(f); b.decline();
  await b.binding.services.run(); b.time(later(26)); b.method("mutable-future-method");
  const before = await allPublicRows(h.pool);
  const driver = createM10RetryDriver(b.retryOptions);
  expect(await driver.run(later(26), 50)).toEqual([{ operationId: f.operation, status: "frozen_mandate_mismatch" }]);
  expect(await allPublicRows(h.pool)).toEqual(before); expect(b.execute).toHaveBeenCalledTimes(1);
  b.method("frozen-method");
  const recovered = createM10RetryDriver({ ...b.retryOptions, payments: { ...b.retryOptions.payments,
    readOutcome: async prepared => ({ ...await b.retryOptions.payments.readOutcome(prepared), status: "succeeded", reason: null }) } });
  expect(await recovered.run(later(26), 50)).toEqual([{ operationId: f.operation, status: "succeeded" }]);
  expect(await createPostgresRetryStore(h.pool).read(f.operation)).toMatchObject({ state: "recovered", cycleId: expect.any(String) });
  await unchangedIdentity(h.pool, f);
});

it("a committed retry preparation reconciles the exact attempt without executing again", async () => {
  const f = await renewal(h.pool), original = await prepareOriginal(h.pool, f), b = bind(f);
  const store = createPostgresRetryStore(h.pool);
  await createM10RetryDriver(b.retryOptions).propagateFailure(f.operation, `failure:${f.operation}`, failure());
  const prepared = await store.prepare(f.operation, `prepare:${f.operation}`, request({ ...f, original }), later(24));
  const readOutcome = vi.fn(b.retryOptions.payments.readOutcome);
  const driver = createM10RetryDriver({ ...b.retryOptions, payments: { ...b.retryOptions.payments, readOutcome } });
  expect(await driver.run(later(26), 1)).toEqual([{ operationId: f.operation, status: "succeeded" }]);
  expect(b.execute).not.toHaveBeenCalled();
  expect(readOutcome).toHaveBeenCalledExactlyOnceWith({ ...prepared, execute: false, replayed: true }, b.snapshot);
  expect(await store.read(f.operation)).toMatchObject({ state: "recovered", cycleId: original.cycleId });
  await unchangedIdentity(h.pool, f);
});

it.each(["paid_cycle", "settled_intent"] as const)("the retry driver filters %s before LIMIT without starving unpaid work", async kind => {
  const stale: Renewal[] = [];
  for (let n = 0; n < 2; n++) {
    const f = await renewal(h.pool), original = await prepareOriginal(h.pool, f), b = bind(f);
    await createM10RetryDriver(b.retryOptions).propagateFailure(f.operation, `failure:${f.operation}`, failure());
    if (kind === "paid_cycle") await h.pool.query("UPDATE public.subscription_cycles SET status='paid' WHERE id=$1", [original.cycleId]);
    else await h.pool.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=$2 WHERE id=$1", [original.settlementIntentId, later(23)]);
    await h.pool.query("UPDATE public.subscription_retry_obligations SET next_retry_at=$2 WHERE renewal_operation_id=$1", [f.operation, later(23)]);
    stale.push(f);
  }
  const f = await renewal(h.pool), b = bind(f);
  await prepareOriginal(h.pool, f);
  const driver = createM10RetryDriver(b.retryOptions);
  await driver.propagateFailure(f.operation, `failure:${f.operation}`, failure());
  expect(await driver.run(later(26), 1)).toEqual([{ operationId: f.operation, status: "succeeded" }]);
  expect(b.execute).toHaveBeenCalledTimes(1);
  for (const prior of stale) expect(await createPostgresRetryStore(h.pool).read(prior.operation)).toMatchObject({ state: "waiting" });
  for (const fixture of [...stale, f]) await unchangedIdentity(h.pool, fixture);
});

it("every composed schema probe resolves its own installed object without assuming the M10 suffix is last", async () => {
  const f = await renewal(h.pool), b = bind(f);
  for (const object of b.binding.schema.objects) {
    const reference = object.kind === "function" ? `${object.name}(${object.signature})` : object.name;
    const result = object.kind === "function"
      ? await h.pool.query("SELECT to_regprocedure($1) IS NOT NULL AS present", [reference])
      : await h.pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [reference]);
    expect(result.rows[0].present, reference).toBe(true);
  }
  const files = ["20261022160000_subscription_retry_lifecycle.sql", "20261024170000_subscription_command_lifecycle.sql", "20261024180000_subscription_stock_wait.sql"];
  for (const file of files) {
    const applied = await h.pool.query("SELECT position FROM public.platform_schema_migrations WHERE catalog_path=$1", [`db/platform/migrations/${file}`]);
    expect(applied.rows, file).toHaveLength(1);
  }
});

it("ambiguous logical-cycle history refuses before the original claim, prepare or charge", async () => {
  const f = await renewal(h.pool), b = bind(f);
  b.snapshot.cycle = { status: "ambiguous", logicalCycleNumber: null, nativeRenewalCounter: 2, activationCycleId: null, reason: "unknown_activation" };
  const before = await allPublicRows(h.pool);
  expect(await b.binding.services.run()).toMatchObject({ renewals: [{ subscriptionId: f.subscription, status: "error", reason: "renewal_processing_failed" }] });
  expect(b.execute).not.toHaveBeenCalled(); expect(await allPublicRows(h.pool)).toEqual(before);
});


async function provePopulationIsolation(population: "normal" | "stock") {
  const bad = await renewal(h.pool, population === "stock" ? 0 : 10, 1, `00000000-${randomUUID().slice(9)}` as ReturnType<typeof randomUUID>);
  if (population === "stock") {
    expect(await bind(bad).binding.services.run()).toMatchObject({ renewals: [{ status: "refused" }] });
  }
  const before = (await h.pool.query("SELECT * FROM public.subscription_renewal_operations WHERE id=$1", [bad.operation])).rows;
  for (let run = 0; run < 2; run++) {
    // Each run has a later healthy obligation; the unchanged bad row remains first.
    const healthy = await renewal(h.pool, 10, 1, `ffffffff-${randomUUID().slice(9)}` as ReturnType<typeof randomUUID>), b = bind(healthy, true, bad);
    b.time(later(2 + run)); // Stock candidates become eligible after their existing claim lease expires.
    const result = await b.binding.services.run();
    expect(result).toMatchObject({ renewals: [
      { subscriptionId: bad.subscription, identityKey: bad.identity, status: "error", reason: "renewal_processing_failed" },
      { subscriptionId: healthy.subscription, status: "succeeded" },
    ] });
    expect(b.execute).toHaveBeenCalledTimes(1);
    expect((await h.pool.query("SELECT * FROM public.subscription_renewal_operations WHERE id=$1", [bad.operation])).rows).toEqual(before);
    await unchangedIdentity(h.pool, healthy);
  }
}
it.each(["normal", "stock"] as const)("isolates an earlier ambiguous %s row across consecutive population runs", provePopulationIsolation);
it.each(["normal", "stock"] as const)("the %s population witness rejects the no-isolation mutant", async population => {
  const mutant = vi.spyOn(subscriptions, "runRenewalBatchRows").mockImplementation(async (rows, run) => {
    const results: AutomaticRenewalRunResult[] = [];
    for (const row of rows) results.push(await run(row));
    return results;
  });
  try { await expect(provePopulationIsolation(population)).rejects.toThrow("cycle_correlation_required"); }
  finally { mutant.mockRestore(); }
});

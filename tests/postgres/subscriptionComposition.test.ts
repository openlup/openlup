import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPostgresRetryStore } from "@openlup/platform/subscriptions";
import * as subscriptions from "@openlup/platform/subscriptions";
import type { AutomaticRenewalRunResult } from "@openlup/platform/subscriptions";
import { createM10RetryDriver } from "../../server/runtime/public-reference/m10RetryDriver.js";
import { createPostgresCustomerSubscriptionControlPort } from "../../server/adapters/postgres/customerSubscriptionControl.js";
import { PLATFORM_DEFAULT_CURRENCY } from "../../src/lib/currency/settlementProfile.js";
import { nativeHarness, openCase } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { bindSubscriptionJob, transaction } from "../helpers/subscriptionJob.fixture.js";
import { AT, call, failure, later, prepareOriginal, renewal as nativeRenewal, recordRenewalMethod, request, unchangedIdentity, type Renewal } from "./subscriptionNativeFixture.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";

async function renewal(...args:Parameters<typeof nativeRenewal>) {
 const f=await nativeRenewal(...args); await recordRenewalMethod(args[0],f,'frozen-method'); return f;
}

const h = nativeHarness("m10-composition");
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);
beforeEach(async () => {
  // Retire prior synthetic fixtures in this owned disposable database only.
  await h.pool.query("UPDATE public.subscriptions SET status='cancelled'");
});
it.each([
  { source: "derived-only", mode: "one_time", price: 125, total: 220 },
  { source: "legacy stored", mode: "subscription", price: 150, total: 300 },
])("validates a blocked re-preview after deletion of a $source SKU", async ({ mode, price, total }) => {
  const f = await nativeRenewal(h.pool);
  const priceList = randomUUID(), variantId = randomUUID(), currency = PLATFORM_DEFAULT_CURRENCY;
  await h.pool.query("UPDATE public.clients SET principal_id=id WHERE id=$1", [f.client]);
  await h.pool.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Bundle fixture','ZY',$2)", [priceList, currency]);
  await h.pool.query(`UPDATE public.subscriptions SET price_list_id=$2,currency_code=$3,next_cycle_at=now()+interval '28 days'
    WHERE id=$1`, [f.subscription, priceList, currency]);
  await h.pool.query("UPDATE public.subscription_renewal_terms SET currency_code=$2 WHERE subscription_id=$1", [f.subscription, currency]);
  const retainedSku = f.snapshot.lines[0].sku;
  await h.pool.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
    SELECT $1,id,2,0,false,100,$2 FROM public.catalog_skus WHERE sku=$3`, [f.subscription, currency, retainedSku]);
  await h.pool.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    SELECT $1,product_id,$2,'Fixture',true FROM public.catalog_skus WHERE sku=$3`, [variantId, `SKU-${variantId}`, retainedSku]);
  await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) VALUES($1,$2,$3,$4)",
    [priceList, variantId, mode, price]);
  if (mode === "one_time") {
    await h.pool.query(`WITH revision AS (SELECT gen_random_uuid() AS id,now() AS starts)
      INSERT INTO public.subscription_price_policy_revisions
        (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,digest)
      SELECT r.id,l.id,l.region_code,l.currency,'D2C',1,500,10,'FLOOR_TO_QUANTUM',r.starts,
        public.catalog_price_setup_policy_digest(r.id,1,l.id,l.region_code,l.currency,'D2C',r.starts,NULL,500,10,'FLOOR_TO_QUANTUM')
      FROM revision r JOIN public.price_lists l ON l.id=$1`, [priceList]);
  }

  const port = createPostgresCustomerSubscriptionControlPort({
    rpc: (name, args) => transaction(h.pool, async db => {
      expect(name).toBe("customer_subscription_preview_bundle_as_actor");
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.client, role: "authenticated" })]);
      const { rows: [row] } = await db.query(`SELECT
        public.customer_subscription_preview_bundle_as_actor($1,$2,$3,$4,$5,$6,$7) AS data`,
      [args?.p_subscription_id, args?.p_idempotency_key, args?.p_core_lines, args?.p_addon_lines,
        args?.p_composition_constraint, args?.p_cadence_days, args?.p_expected_template_version]);
      return { data: row.data, error: null };
    }),
  });
  const idempotencyKey = randomUUID();
  const preview = async () => (await port.previewAction(f.client, { subscriptionAction: {
    action: "update_bundle", subscriptionId: f.subscription, idempotencyKey,
    coreLines: [{ variantId, qty: 2, isAddon: false }], addonLines: [],
    compositionConstraint: {}, cadenceDays: 28, expectedTemplateVersion: 1,
  } }))?.preview;
  const saved = await preview();
  expect(saved).toMatchObject({ canApply: true, quoteHash: expect.any(String), quoteExpiresAt: expect.any(String),
    currentTotal: { amountMinor: 200, currency }, newTotal: { amountMinor: total, currency },
    catalogAvailability: { status: "available", blockedReason: null } });
  expect((await h.pool.query("DELETE FROM public.catalog_skus WHERE id=$1 RETURNING id", [variantId])).rows)
    .toEqual([{ id: variantId }]);
  expect(await preview()).toEqual({ ...saved, canApply: false,
    catalogAvailability: { status: "blocked", blockedReason: null } });
});

const bind = (f: Renewal, enabled?: boolean, ambiguous?: Renewal, beforeQuery?: (sql: string) => Promise<void>) =>
  bindSubscriptionJob(h.pool, f, enabled, ambiguous, beforeQuery);
async function predecessor(f: Renewal, mode: string) {
  const cycle = randomUUID(), order = randomUUID(), shipment = randomUUID(), operation = randomUUID();
  await h.pool.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,terminal_outcome,terminal_at)
    VALUES($1,$2,'2026-08-04T12:00:00Z',1,public.subscription_renewal_identity($2,'2026-08-04T12:00:00Z'),$3,'{}','succeeded',$4,'fixture',$5,$5::timestamptz+interval '5 minutes','succeeded',$5)`, [operation, f.subscription, "a".repeat(64), randomUUID(), AT]);
  await h.pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,'2026-08-04T12:00:00Z','paid',$3,$4)", [cycle, f.subscription, operation, "a".repeat(64)]);
  await transaction(h.pool, async db => {
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
  await recordRenewalMethod(h.pool, f);
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
  await recordRenewalMethod(h.pool, f);
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

// Hold the gate only at row admission, after the run's unchanged expiry prelude.
it("completes a stock-wait busy-only run without an error row or new ledger outcome", async () => {
  const f = await renewal(h.pool, 0);
  expect(await bind(f).binding.services.run()).toMatchObject({ renewals: [{ status: "refused", reason: "inventory_unavailable" }] });
  const blocker = await h.pool.connect();
  let admissions = 0;
  let before: Awaited<ReturnType<typeof allPublicRows>> | undefined;
  const b = bind(f, true, undefined, async sql => {
    if (sql.includes("public.subscription_stock_wait_admit(")) {
      admissions++;
      // Candidate discovery has already recorded its unchanged fairness timestamp.
      before = await allPublicRows(h.pool);
      await blocker.query("SELECT pg_advisory_xact_lock(846832106,1)");
    }
  });
  b.time(later(2));
  try {
    await blocker.query("BEGIN");
    expect(await b.binding.services.run()).toEqual({ retries: [], renewals: [] });
    expect(admissions).toBe(1);
    expect(b.execute).not.toHaveBeenCalled();
    expect(before).toBeDefined();
    expect(await allPublicRows(h.pool)).toEqual(before);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
}, 10_000);


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

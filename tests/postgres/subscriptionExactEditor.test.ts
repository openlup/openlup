import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { createPostgresPackageEditor, createExactSubscriptionRepricer, createPostgresPackageEditReadPort, createSubscriptionSizingRules,
  createPostgresLifecycleMessages, createPostgresRenewalStore, createNativeRenewalCodec, createPostgresRenewalSettlementPort } from "@openlup/platform/subscriptions";
import type { ExactSubscriptionEditRequest, PackageEditorOptions } from "@openlup/platform/subscriptions";
import { createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore } from "@openlup/platform/account-support";
import { createCapturedTransactionalDelivery, createPostgresTransactionalDeliveryStore, createTransactionalDelivery } from "@openlup/platform/communications";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
const at = "2026-11-05T12:00:00.000Z", next = "2026-12-05T12:00:00.000Z";
let container: PostgresContainer | undefined, owner: Pool, installer: Pool, runtime: Pool, browser: Pool;
let runtimeUrl: string;
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
const rpc = async (db: Pool | PoolClient, name: string, values: unknown[]) =>
  (await db.query(`SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) AS result`, values)).rows[0].result;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Exact editor requires real PostgreSQL");
  container = await runPostgresContainer({ name: `exact-editor-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Exact editor PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString });
  const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres",
    runtimeLogin: "exact_runtime", restoreLogin: "exact_restore" } as const;
  for (const login of [selection.runtimeLogin, selection.restoreLogin]) await owner.query(`CREATE ROLE ${login}
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  installer = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => installer });
  await runner.apply(); expect((await runner.status()).pending).toEqual([]);
  await owner.query("CREATE ROLE exact_browser LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'");
  await owner.query("GRANT authenticated TO exact_browser");
  const login = (name: string, role: string) => { const url = new URL(container!.connectionString); url.username = name;
    url.password = "synthetic-conformance"; url.searchParams.set("options", `-c role=${role}`); return url.toString(); };
  runtimeUrl = login("exact_runtime", "service_role");
  runtime = new Pool({ connectionString: runtimeUrl });
  browser = new Pool({ connectionString: login("exact_browser", "authenticated") });
  expect((await runtime.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows)
    .toEqual([{ current_user: "service_role", elevated: false }]);
  await minimum("4");
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [owner, installer, runtime, browser].filter(Boolean)); }, postgresTeardownTimeoutMs);
async function minimum(value: string | null) {
  await owner.query("DELETE FROM public.commerce_settings WHERE key='subscription_minimum_base_units'");
  if (value !== null) await owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units',$1)", [value]);
}
async function fixture() {
  const client = randomUUID(), subscription = randomUUID(), actor = randomUUID(), sku = randomUUID(), addon = randomUUID(), target = randomUUID(), extra = randomUUID(), priceList = randomUUID();
  await owner.query("INSERT INTO public.clients(id,email,lifecycle_stage,principal_id) VALUES($1,$2,'customer',$3)", [client, `${client}@example.invalid`, actor]);
  for (const [id, isAddon] of [[sku, false], [addon, true], [target, false], [extra, true]] as const) {
    await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Refill')", [id, `refill-${id}`]);
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,is_addon,sellable_in_subscription) VALUES($1,$1,$2,'Refill',$3,true)", [id, id, isAddon]);
  }
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Configured','AA','XXX')", [priceList]);
  await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,currency_code,price_list_id) VALUES($1,$2,28,$3,'XXX',$4)", [subscription, client, next, priceList]);
  await owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','synthetic-stock','sandbox',$2,'sandbox-authorization')`, [subscription, at]);
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [subscription]);
  for (const [id, qty, ordinal, isAddon] of [[sku, 4, 1, false], [addon, 3, 2, true]] as const) {
    await owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,$3,$4,$5,100,'XXX')", [subscription, id, qty, ordinal - 1, isAddon]);
    await owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,$2,$3,$4,100)", [subscription, ordinal, id, qty]);
  }
  await owner.query("UPDATE public.subscriptions SET composition_constraint=$2 WHERE id=$1", [subscription, { kind: "plan_days", value: 28, need: 4, marker: "keep" }]);
  return { client, subscription, actor, sku, addon, target, extra };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Fields = { action: string; [key: string]: unknown };
function options(f: Fixture): PackageEditorOptions {
  const portionModes = { full: { mode: "full", factor: 1 }, reduced: { mode: "portion", factor: 0.5 } };
  return { portionModes, now: () => at, limits: { maximumPlanDays: 90, maximumBaseLines: 6, maximumAddonLines: 12, maximumQuantity: 99 },
    constraintMapper: { toCore: stored => ({ kind: "configured", version: 1, data: stored ?? {} }), fromCore: value => value.data, nominalPlanDays: () => 28 },
    compositionRulesPort: createSubscriptionSizingRules({ portionModes, readDailyNeed: constraint => Number(constraint.data.need),
      isPlanLengthConstraint: constraint => constraint.data.kind === "plan_days",
      readUnitFacts: async ids => ids.filter(id => id === f.sku || id === f.target).map(variantId => ({ variantId, demandPerUnit: 28, maximumQuantity: 99 })),
      quantityPolicy: async input => ({ totalUnits: Math.max(2, Math.ceil(input.dailyNeed * input.planDays / 28)), maxExceeded: false }) }),
    quoteCatalogReadPort: { async listQuoteCatalogItems() {
      return (await runtime.query("SELECT id,sku,sellable_in_subscription,status FROM public.catalog_skus WHERE id=ANY($1::uuid[])", [[f.sku, f.addon, f.target, f.extra]])).rows
        .map(row => ({ variantId: row.id, skuCode: row.sku, sellability: { subscription: row.status === "active" && row.sellable_in_subscription } }));
    } },
    quotePort: { async createServerAuthoritativeQuote(input) {
      const unit = input.cadenceDays === 14 ? 131 : 137;
      const lines = input.lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitPriceGross: money(unit), lineSubtotalGross: money(unit * line.quantity),
        pricingComponents: [{ componentType: "base_unit", amountMinor: 173 * line.quantity }] }));
      const total = money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0));
      return { quote: { lines, totalGross: total, subtotalGross: total, discountTotalGross: money(0) } };
    } },
    async withTransaction(work) {
      const db = await runtime.connect();
      try { await db.query("BEGIN"); const answer = await work(db); await db.query("COMMIT"); return answer; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    },
  };
}
async function evidence(f: Fixture, fields: Fields, quoteOptions = options(f)) {
  const input = { ...fields, subscriptionId: f.subscription } as ExactSubscriptionEditRequest;
  const quote = await createExactSubscriptionRepricer({ ...quoteOptions, readPort: createPostgresPackageEditReadPort(runtime) }).quote(input);
  if (!quote) throw new Error("fixture source missing");
  const request: Fields & { acceptedQuoteHash: string } = { ...fields, acceptedQuoteHash: quote.quoteHash };
  return { ...quote, acceptedQuoteHash: quote.quoteHash, request };
}
type Evidence = Awaited<ReturnType<typeof evidence>>;
async function record(f: Fixture, payload: Evidence, expiry = "2026-11-05T12:15:00Z") {
  const { request, acceptedQuoteHash: _acceptedQuoteHash, quoteHash: _quoteHash, expectedTemplateVersion: _version, ...snapshot } = payload;
  return rpc(runtime, "subscription_quote_preview_record", [f.actor, f.client, f.subscription, request.action,
    payload.acceptedQuoteHash, payload.expectedTemplateVersion, expiry, request, snapshot, {}, at]);
}
const apply = (f: Fixture, payload: Evidence, key: string = randomUUID(), db: Pool | PoolClient = runtime, now = at) =>
  rpc(db, "subscription_line_edit_apply", [f.actor, f.client, key, f.subscription, payload.request.action, payload, now]);
async function effects() {
  const result: Record<string, unknown> = {};
  for (const { tablename } of (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    result[tablename] = (await owner.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public."${tablename}" t`)).rows[0].rows;
  }
  return result;
}
async function refuses(work: () => Promise<unknown>, reason: string) {
  const before = await effects(); await expect(work()).rejects.toMatchObject({ message: reason }); expect(await effects()).toEqual(before);
}
const rows = async (f: Fixture) => (await owner.query("SELECT * FROM public.subscription_lines WHERE subscription_id=$1 ORDER BY sort_order,id", [f.subscription])).rows;
async function unchangedService(f: Fixture) {
  return (await owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
}
it("keeps swap identity observable through the owned account read and refuses a duplicate target atomically", async () => {
  const f = await fixture(), before = await rows(f), service = await unchangedService(f);
  const payload = await evidence(f, { action: "swap_base_line", fromVariantId: f.sku, toVariantId: f.target });
  await record(f, payload); expect(await apply(f, payload)).toMatchObject({ status: "applied", templateVersion: 2 });
  const scope = { clientId: f.client, principalId: f.actor };
  const sources = createPostgresAccountReadSources(runtime, { ...scope,
    orders: createPostgresCustomerOrderHistoryReadStore(runtime, { ...scope, readInvoiceSummaries: async () => new Map() }),
    orderProjection: { project: async () => { throw new Error("not used"); } } as never,
    now: () => at, additional: { readExtension: async () => ({}), readNextCharges: async () => new Map() } });
  const lines = (await sources.readSubscriptionLines([f.subscription])).get(f.subscription)!;
  expect(lines.find(line => !line.isAddon)).toMatchObject({ lineId: before[0].id, variantId: f.target, qty: 4, sortOrder: 0 });
  expect(lines.find(line => line.isAddon)?.lineId).toBe(before[1].id);
  expect(await unchangedService(f)).toEqual(service);
  const duplicate = await evidence(f, { action: "swap_base_line", fromVariantId: f.target, toVariantId: f.addon });
  await record(f, duplicate); await refuses(() => apply(f, duplicate), "subscription_edit_conflict_duplicate_line");
}, 30_000);
it("enforces ownership, window, method, dunning, version and cycle locks without writes", async () => {
  for (const guard of ["owner", "window", "status", "method", "dunning", "version", "cycle", "hash"]) {
    const f = await fixture(), payload = await evidence(f, { action: "update_addon_quantity", variantId: f.addon, qty: 5 }); await record(f, payload);
    if (guard === "window") await owner.query("UPDATE public.subscriptions SET next_cycle_at='2026-11-06T00:00:00Z' WHERE id=$1", [f.subscription]);
    if (guard === "status") await owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
    if (guard === "method") await owner.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1", [f.subscription]);
    if (guard === "dunning") await owner.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)", [f.subscription, f.client, randomUUID()]);
    if (guard === "version") payload.expectedTemplateVersion += 1;
    if (guard === "cycle") await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'paid')", [f.subscription, next]);
    if (guard === "hash") payload.acceptedQuoteHash = "malformed";
    const expected = guard === "owner" ? "subscription_command_forbidden" : guard === "window" || guard === "status" ? "subscription_edit_window_closed"
      : guard === "method" || guard === "dunning" ? "subscription_command_payment_blocked" : guard === "version" ? "subscription_edit_stale_template"
        : guard === "hash" ? "subscription_edit_quote_required" : "subscription_lifecycle_payment_blocked";
    await refuses(() => apply(guard === "owner" ? { ...f, client: randomUUID() } : f, payload), expected);
  }
  await expect(browser.query("SELECT public.subscription_line_edit_apply(NULL,NULL,NULL,NULL,NULL,NULL,NULL)")).rejects.toMatchObject({ code: "42501" });
}, 30_000);

async function pastCycle(f: Fixture) {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    const cycle = (await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-10-01T12:00:00Z','paid') RETURNING id", [f.subscription])).rows[0].id;
    const order = (await db.query("INSERT INTO public.commerce_orders(client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',700) RETURNING id", [f.client, cycle])).rows[0].id;
    for (const [ordinal, sku, qty] of [[1, f.sku, 4], [2, f.addon, 3]]) await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,$3,$4,100,$4::integer*100)", [order, sku, ordinal, qty]);
    await db.query("COMMIT"); return { cycle, order };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
it("leaves an outstanding delivery-alignment obligation and the due anchor untouched by an edit", async () => {
  const f = await fixture(), past = await pastCycle(f), service = await unchangedService(f);
  const alignment = (await owner.query(`INSERT INTO public.subscription_delivery_alignment_cases(predecessor_order_id,subscription_id,predecessor_cycle_id,
    captured_mode,state,evidence_kind,observed_next_cycle_at) VALUES($1,$2,$3,'protect','protected','missing_fulfillment',$4) RETURNING id`,
  [past.order, f.subscription, past.cycle, next])).rows[0].id;
  const read = async () => (await owner.query("SELECT to_jsonb(t) AS row,xmin::text FROM public.subscription_delivery_alignment_cases t WHERE id=$1", [alignment])).rows;
  const before = await read(), payload = await evidence(f, { action: "swap_base_line", fromVariantId: f.sku, toVariantId: f.target });
  await record(f, payload); await apply(f, payload);
  expect(await read()).toEqual(before); expect(await unchangedService(f)).toEqual(service);
}, 30_000);
it("bills accepted exact prices and list evidence in the native second-renewal order", async () => {
  // Deliberately editable native fixture. Acquisition/template production belongs to its own witness.
  const f = await fixture(), past = await pastCycle(f);
  const facts = { templateId: "fixture-template", shippingAmountMinor: 0, acquisitionRef: null,
    renewalTerms: { version: "native.renewal-terms.v1", minimumPayableMinor: 1, normalCadenceDays: [14, 28], starterPack: {
      schemaVersion: "1", basisTemplateVersion: 1, starterIntervalDays: 28,
      delivery2: { discountBps: 2500, discountMinor: 175, basisSubtotalMinor: 700 },
      graduation: { cadenceDays: 28, lines: [{ sku: f.sku, qty: 4, sortOrder: 0, isAddon: false,
        quoteLine: { unitPriceGross: money(100), lineSubtotalGross: money(400) } }] } } } };
  await owner.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,
    activation_idempotency_key,declare_idempotency_key,declared_at,activated_at) VALUES($1,$2,$3,28,'active',repeat('a',64),$4,$5,$6,$6)`,
  [past.order, f.client, f.subscription, randomUUID(), randomUUID(), at]);
  await owner.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [past.order, f.subscription, facts, at]);
  const destination = (await rpc(runtime, "commerce_register_order_destination", [randomUUID(), past.order,
    { recipientName: "Sample Customer", line1: "1 Example Street", city: "Example City", postalCode: "00000", country: "AA" }, at])).destinationId;
  await owner.query("INSERT INTO public.commerce_destination_bindings(subscription_id,destination_id) VALUES($1,$2)", [f.subscription, destination]);
  const payload = await evidence(f, { action: "update_addon_quantity", variantId: f.addon, qty: 5 }); await record(f, payload); await apply(f, payload);
  const codec = createNativeRenewalCodec(), store = createPostgresRenewalStore(runtime, codec, options(f).withTransaction);
  const due = (await store.listDue(500, next)).find(value => value.subscriptionId === f.subscription)!;
  const snapshot = await store.buildCycleSnapshots(due);
  expect(snapshot.pricingSnapshot).toMatchObject({ productSubtotalAmountMinor: 1233, discountAmountMinor: 65, totalAmountMinor: 1168,
    linePricing: payload.lines.map(line => ({ sku: line.quoteLine.sku, quantity: line.qty, unitAmountMinor: 137, quoteLine: line.quoteLine })) });
  const claim = await store.claimDue({ snapshot, workerId: "exact-price-witness", now: next });
  const stock = createPostgresFulfillmentStockSyncPort(runtime, { sourceKey: "synthetic-stock", readLocalInventoryStock: async () => [] });
  for (const sku of [f.sku, f.addon]) await stock.recordProviderStockCurrent({ requestKey: randomUUID(), snapshot: {
    providerRef: "fixture-stock", collectedAt: next, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef: sku,
    totalQuantity: 100, forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: "exact-stock" },
    inventoryClass: "sellable", lastSyncedAt: next, staleAfter: "2027-01-01T00:00:00Z" });
  expect(await rpc(runtime, "fulfillment_reserve_subscription_renewal", [claim.operationId, claim.claimToken, 900, next])).toMatchObject({ status: "held" });
  const bill = await createPostgresRenewalSettlementPort(runtime, codec, options(f).withTransaction).prepareRenewal({ operationId: claim.operationId, claimToken: claim.claimToken, now: next });
  expect((await owner.query("SELECT total_amount_minor FROM public.commerce_orders WHERE id=$1", [bill.orderId])).rows[0].total_amount_minor).toBe("1168");
  expect((await owner.query("SELECT sum(line_amount_minor)::text AS billed,sum(promotion_discount_allocated_minor)::text AS discount,sum(catalog_line_amount_minor)::text AS agreed,sum(quantity)::int AS qty FROM public.commerce_order_items WHERE order_id=$1", [bill.orderId])).rows)
    .toEqual([{ billed: "1168", discount: "65", agreed: "1233", qty: 9 }]);
}, 30_000);
it("adds, updates and removes an add-on, preserving IDs and allowing retired removal", async () => {
  const f = await fixture(), before = await rows(f);
  for (const fields of [{ action: "add_addon", variantId: f.extra, qty: 2 }, { action: "update_addon_quantity", variantId: f.extra, qty: 5 }]) {
    const payload = await evidence(f, fields); await record(f, payload); expect(await apply(f, payload)).toMatchObject({ status: "applied" });
    if (fields.action === "add_addon") before.push((await rows(f)).find(line => line.variant_id === f.extra)!);
    else expect((await rows(f)).find(line => line.variant_id === f.extra)).toMatchObject({ id: before[2].id, quantity: 5 });
  }
  await owner.query("UPDATE public.catalog_skus SET status='archived',sellable_in_subscription=false WHERE id=$1", [f.extra]);
  const payload = await evidence(f, { action: "remove_addon", variantId: f.extra }); await record(f, payload);
  expect(await apply(f, payload)).toMatchObject({ status: "applied", templateVersion: 4 });
  expect((await rows(f)).map(line => line.id)).toEqual(before.slice(0, 2).map(line => line.id));
}, 30_000);
it.each(["swap_base_line", "remove_addon", "update_addon_quantity"] as const)("refuses a missing %s source without any writes", async action => {
  const f = await fixture();
  const valid = action === "swap_base_line" ? { action, fromVariantId: f.sku, toVariantId: f.target } : { action, variantId: f.addon, ...(action === "update_addon_quantity" ? { qty: 2 } : {}) };
  const payload = await evidence(f, valid);
  payload.request = { ...payload.request, ...(action === "swap_base_line" ? { fromVariantId: f.extra } : { variantId: f.extra }) };
  await record(f, payload); await refuses(() => apply(f, payload), action === "swap_base_line" ? "subscription_edit_not_found_line" : "subscription_edit_not_found_addon");
}, 30_000);
it.each(["swap_base_line", "add_addon", "update_addon_quantity", "update_plan_length", "update_base_mix", "update_portion"] as const)(
  "returns a %s no-op before ledger acceptance or locked-cycle refusal", async action => {
    const f = await fixture();
    const fields: Fields = action === "swap_base_line" ? { action, fromVariantId: f.sku, toVariantId: f.sku }
      : action === "add_addon" || action === "update_addon_quantity" ? { action, variantId: f.addon, qty: 3 }
      : action === "update_plan_length" ? { action, planDays: 28 } : action === "update_base_mix" ? { action, base: [{ variantId: f.sku, qty: 4 }] }
        : { action, portionMode: "full" };
    const payload = await evidence(f, fields);
    await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'paid')", [f.subscription, next]);
    const before = await effects(); expect(await apply(f, payload)).toMatchObject({ status: "noop", templateVersion: 1, eventId: null });
    const after = await effects(); delete before.subscription_command_receipts; delete after.subscription_command_receipts; expect(after).toEqual(before);
  }, 30_000);
it("resizes the plan, replaces only base IDs and relocks retained add-ons", async () => {
  const f = await fixture(), before = await rows(f), quoteOptions = options(f);
  const quotePort = quoteOptions.quotePort;
  let pricedConstraint: Record<string, unknown> | null | undefined;
  quoteOptions.quotePort = { async createServerAuthoritativeQuote(input) {
    pricedConstraint = input.compositionConstraint;
    return quotePort.createServerAuthoritativeQuote(input);
  } };
  const payload = await evidence(f, { action: "update_plan_length", planDays: 14 }, quoteOptions);
  await record(f, payload); await apply(f, payload);
  const after = await rows(f); expect(after[0].id).not.toBe(before[0].id); expect(after[0]).toMatchObject({ quantity: 2, unit_price_minor: "131" });
  expect(after[1]).toMatchObject({ id: before[1].id, quantity: 3, unit_price_minor: "131" });
  expect((await owner.query("SELECT cadence_days,composition_constraint FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0])
    .toEqual({ cadence_days: 14, composition_constraint: pricedConstraint });
  expect(pricedConstraint).toEqual({ kind: "plan_days", value: 14, marker: "keep", need: 4 });
}, 30_000);
it.each(["unit_count", "plan_days"])("persists the accepted %s constraint through exact plan preview and apply", async kind => {
  const f = await fixture(), service = await unchangedService(f);
  const constraint = { kind, value: kind === "unit_count" ? 4 : 28, need: 4, marker: "keep", details: { source: "host", units: [1, 2] } };
  await owner.query("UPDATE public.subscriptions SET composition_constraint=$2 WHERE id=$1", [f.subscription, constraint]);
  const editor = createPostgresPackageEditor(options(f)), actor = { actorId: f.actor, clientId: f.client };
  const request = { subscriptionId: f.subscription, action: "update_plan_length", planDays: 14 } as const;
  const preview = await editor.preview(actor, request);
  expect(preview.preview.canApply).toBe(true);
  const ledger = (await owner.query("SELECT id,quote_snapshot FROM public.subscription_quote_previews WHERE subscription_id=$1 AND quote_hash=$2",
    [f.subscription, preview.quoteHash])).rows[0];
  const acceptedConstraint = { ...constraint, value: kind === "unit_count" ? 4 : 14 };
  expect(ledger.quote_snapshot.compositionConstraint).toEqual(acceptedConstraint);
  expect(ledger.quote_snapshot.cadenceDays).toBe(14);
  expect(await editor.apply(actor, randomUUID(), { ...request, acceptedQuoteHash: preview.quoteHash,
    expectedTemplateVersion: preview.preview.templateVersion })).toMatchObject({ status: "applied", templateVersion: 2 });
  expect((await owner.query("SELECT cadence_days,composition_constraint FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0])
    .toEqual({ cadence_days: ledger.quote_snapshot.cadenceDays, composition_constraint: acceptedConstraint });
  expect((await rows(f)).map(line => ({ variantId: line.variant_id, qty: line.quantity, isAddon: line.is_addon, unitAmountMinor: Number(line.unit_price_minor) })))
    .toEqual(ledger.quote_snapshot.lines.map((line: Evidence["lines"][number]) => ({ variantId: line.variantId, qty: line.qty,
      isAddon: line.isAddon, unitAmountMinor: line.quoteLine.unitPriceGross.amountMinor })));
  expect((await rows(f)).map(line => line.quantity)).toEqual([2, 3]);
  expect((await owner.query("SELECT accepted_at IS NOT NULL AS accepted FROM public.subscription_quote_previews WHERE id=$1", [ledger.id])).rows)
    .toEqual([{ accepted: true }]);
  expect(await unchangedService(f)).toEqual(service);
}, 30_000);
it("replaces a fixed-total base mix and independently refuses a changed SQL total", async () => {
  const f = await fixture(), payload = await evidence(f, { action: "update_base_mix", base: [{ variantId: f.target, qty: 4 }] });
  const changed = structuredClone(payload); changed.lines[0].qty = 5; changed.lines[0].quoteLine.quantity = 5;
  changed.request.base = [{ variantId: f.target, qty: 5 }]; await record(f, changed);
  await refuses(() => apply(f, changed), "subscription_edit_base_total_mismatch");
  const before = await rows(f); await record(f, payload); await apply(f, payload);
  const after = await rows(f); expect(after[0]).toMatchObject({ variant_id: f.target, quantity: 4 }); expect(after[0].id).not.toBe(before[0].id);
  expect(after[1].id).toBe(before[1].id);
}, 30_000);
it("reduces portion, refuses non-reduction and restores full at the same cadence", async () => {
  const f = await fixture(), before = await rows(f), service = await unchangedService(f);
  const editor = createPostgresPackageEditor(options(f)), actor = { actorId: f.actor, clientId: f.client };
  for (const mode of ["portion", "full"]) {
    const request = { subscriptionId: f.subscription, action: "update_portion", portionMode: mode } as const;
    const preview = await editor.preview(actor, request);
    expect(await editor.apply(actor, randomUUID(), { ...request, acceptedQuoteHash: preview.quoteHash })).toMatchObject({ status: "applied" });
    const current = await rows(f); expect(current[0].quantity).toBe(mode === "portion" ? 2 : 4);
    expect(current[0].id).not.toBe(before[0].id); expect(current[1].id).toBe(before[1].id);
    expect(await unchangedService(f)).toEqual(service);
    if (mode === "portion") await refuses(() => editor.preview(actor, request), "subscription_reprice_portion_no_reduction");
  }
}, 30_000);
it("refuses unservable plan and portion demand without writing a preview", async () => {
  const f = await fixture(); await owner.query("UPDATE public.subscriptions SET composition_constraint='{}' WHERE id=$1", [f.subscription]);
  const editor = createPostgresPackageEditor(options(f)), actor = { actorId: f.actor, clientId: f.client };
  await refuses(() => editor.preview(actor, { subscriptionId: f.subscription, action: "update_plan_length", planDays: 14 }), "subscription_reprice_missing_daily_need");
  await refuses(() => editor.preview(actor, { subscriptionId: f.subscription, action: "update_portion", portionMode: "portion" }), "subscription_reprice_missing_daily_need");
}, 30_000);
it("refuses invalid add-on quantity and an unconfigured portion mode or factor at SQL acceptance", async () => {
  const f = await fixture(), invalid = await evidence(f, { action: "update_addon_quantity", variantId: f.addon, qty: 5 });
  invalid.request.qty = 0; await record(f, invalid);
  await refuses(() => apply(f, invalid), "subscription_edit_invalid_addon_qty");
  const portion = await evidence(f, { action: "update_portion", portionMode: "portion" });
  for (const field of ["mode", "factor"]) {
    const bad = structuredClone(portion);
    if (field === "mode") { bad.request.portionMode = "unknown"; bad.compositionConstraint!.mode = "unknown"; }
    else bad.compositionConstraint!.portionFactor = 0.25;
    await record(f, bad); await refuses(() => apply(f, bad), "subscription_edit_invalid_portion_mode");
  }
}, 30_000);
it("refuses exact preview drift, expiry, stale versions and used acceptance without writes", async () => {
  const f = await fixture(), payload = await evidence(f, { action: "update_addon_quantity", variantId: f.addon, qty: 5 });
  const preview = await record(f, payload);
  for (const mutate of [(p: Evidence) => { p.request.qty = 6; }, (p: Evidence) => { p.lines[0].quoteLine.unitPriceGross.amountMinor += 1; },
    (p: Evidence) => { p.lines[1].lineId = f.actor; }, (p: Evidence) => { p.cadenceDays = 21; }]) {
    const changed = structuredClone(payload); mutate(changed); await refuses(() => apply(f, changed), "subscription_edit_quote_drift");
  }
  await refuses(() => apply(f, payload, randomUUID(), runtime, "2026-11-05T12:15:00Z"), "subscription_edit_quote_expired");
  await refuses(() => apply(f, { ...payload, expectedTemplateVersion: 2 }), "subscription_edit_stale_template");
  const event = (await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key) VALUES($1,'subscription.customer_self_service.update_addon_quantity',$2) RETURNING id", [f.subscription, randomUUID()])).rows[0].id;
  await rpc(runtime, "subscription_quote_preview_mark_accepted", [preview.id, "used-exact-key", event, at]);
  await refuses(() => apply(f, payload), "subscription_edit_quote_already_used");
}, 30_000);
it("replays a completed exact key before later guards or a missing pricing configuration", async () => {
  const f = await fixture(), payload = await evidence(f, { action: "remove_addon", variantId: f.addon }), key = randomUUID();
  await record(f, payload); const answer = await apply(f, payload, key);
  await owner.query("UPDATE public.subscriptions SET status='cancelled',template_version=9 WHERE id=$1", [f.subscription]);
  const editor = createPostgresPackageEditor({ ...options(f), quotePort: { async createServerAuthoritativeQuote() { throw new Error("must not price replay"); } } });
  const before = await effects(); expect(await editor.apply({ actorId: f.actor, clientId: f.client }, key,
    { subscriptionId: f.subscription, ...payload.request } as ExactSubscriptionEditRequest)).toEqual({ ...answer, status: "replayed", originalStatus: "applied" });
  expect(await effects()).toEqual(before);
}, 30_000);
it("serializes two exact applies on one version and leaves the loser unaccepted", async () => {
  const f = await fixture(), payload = await evidence(f, { action: "update_addon_quantity", variantId: f.addon, qty: 5 }); await record(f, payload);
  const first = await runtime.connect(), second = await runtime.connect();
  try {
    await first.query("BEGIN"); await apply(f, payload, "first-exact-key", first);
    const losing = apply(f, payload, "second-exact-key", second).then(value => ({ value }), error => ({ error }));
    await expect.poll(async () => (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT public.subscription_line_edit_apply%'")).rows[0].n, { timeout: 5000 }).toBe(1);
    await first.query("COMMIT"); expect(await losing).toMatchObject({ error: { message: "subscription_edit_stale_template" } });
    expect((await owner.query("SELECT count(*)::int AS n FROM public.subscription_command_receipts WHERE subscription_id=$1", [f.subscription])).rows[0].n).toBe(1);
  } finally { await first.query("ROLLBACK"); first.release(); second.release(); }
}, 30_000);
it("emits one package_changed notice for each exact real change and none for no-ops", async () => {
  const events: string[] = [];
  for (const action of ["swap_base_line", "add_addon", "remove_addon", "update_addon_quantity", "update_plan_length", "update_base_mix", "update_portion"]) {
    const f = await fixture();
    const fields: Fields = action === "swap_base_line" ? { action, fromVariantId: f.sku, toVariantId: f.target }
      : action === "add_addon" ? { action, variantId: f.extra, qty: 2 } : action === "remove_addon" ? { action, variantId: f.addon }
        : action === "update_addon_quantity" ? { action, variantId: f.addon, qty: 2 } : action === "update_plan_length" ? { action, planDays: 14 }
          : action === "update_base_mix" ? { action, base: [{ variantId: f.target, qty: 4 }] } : { action, portionMode: "portion" };
    const payload = await evidence(f, fields); await record(f, payload); const result = await apply(f, payload); events.push(result.eventId);
    const event = (await owner.query("SELECT payload FROM public.subscription_events WHERE id=$1", [result.eventId])).rows[0].payload;
    expect(event.linePricing).toEqual(payload.lines.map(line => ({ sku: line.quoteLine.sku, quantity: line.qty,
      unitAmountMinor: line.quoteLine.unitPriceGross.amountMinor, isAddon: line.isAddon, quoteLine: line.quoteLine })));
  }
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl }), sent: string[] = [], kinds: string[] = [];
  try {
    const delivery = createTransactionalDelivery({ store, delivery: createCapturedTransactionalDelivery({ outcome(command) { sent.push(command.idempotencyKey); return { state: "accepted" }; } }) });
    const dispatcher = createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: store.readReceipt },
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      async bind(notice) { if (events.includes(notice.id)) kinds.push(notice.kind); return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug }; } });
    await dispatcher.run(100); await dispatcher.run(100);
    for (const event of events) expect(sent.filter(key => key === `subscription-notice:event:${event}`)).toHaveLength(1);
    expect(kinds).toEqual(events.map(() => "subscription.package_changed"));
  } finally { await store.close(); }
}, 30_000);

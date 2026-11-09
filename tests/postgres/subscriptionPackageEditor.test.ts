import { randomUUID } from "node:crypto";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCapturedTransactionalDelivery, createPostgresTransactionalDeliveryStore, createTransactionalDelivery } from "@openlup/platform/communications";
import { createPostgresLifecycleMessages, createPostgresPackageEditor } from "@openlup/platform/subscriptions";
import { createDbBackedCommerceQuotePort } from "@openlup/platform/pricing";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const at = "2026-11-05T12:00:00.000Z", next = "2026-12-05T12:00:00.000Z";
let container: PostgresContainer | undefined, owner: Pool, installer: Pool, runtime: Pool, browser: Pool;
let runtimeUrl: string;
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
const rpc = async (db: Pool | PoolClient, name: string, values: unknown[]) =>
  (await db.query(`SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) AS result`, values)).rows[0].result;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Package editor requires real PostgreSQL");
  container = await runPostgresContainer({ name: `package-editor-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Package editor PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString });
  const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres",
    runtimeLogin: "package_runtime", restoreLogin: "package_restore" } as const;
  for (const login of [selection.runtimeLogin, selection.restoreLogin]) await owner.query(`CREATE ROLE ${login}
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  installer = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => installer });
  await runner.apply(); expect((await runner.status()).pending).toEqual([]);
  await owner.query("CREATE ROLE package_browser LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'");
  await owner.query("GRANT authenticated TO package_browser");
  const login = (name: string, role: string) => { const url = new URL(container!.connectionString); url.username = name;
    url.password = "synthetic-conformance"; url.searchParams.set("options", `-c role=${role}`); return url.toString(); };
  runtimeUrl = login("package_runtime", "service_role");
  runtime = new Pool({ connectionString: runtimeUrl });
  browser = new Pool({ connectionString: login("package_browser", "authenticated") });
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
  const client = randomUUID(), subscription = randomUUID(), actor = randomUUID(), sku = randomUUID(), addon = randomUUID(), priceList = randomUUID();
  await owner.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'customer')", [client, `${client}@example.invalid`]);
  for (const [id, isAddon] of [[sku, false], [addon, true]] as const) {
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
  return { client, subscription, actor, sku, addon };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function evidence(f: Fixture, quantity = 6, addons = [{ variantId: f.addon, qty: 3 }], planDays = 28) {
  const base = [{ variantId: f.sku, qty: quantity }], hash = "a".repeat(64);
  const line = (variantId: string, qty: number) => ({ variantId, qty, quoteLine: {
    sku: variantId, quantity: qty, unitPriceGross: money(137), lineSubtotalGross: money(qty * 137),
    pricingComponents: [{ componentType: "base_unit", amountMinor: qty * 173 }] } });
  return { request: { planDays, base, addons, expectedTemplateVersion: 1, acceptedQuoteHash: hash },
    planDays, nominalPlanDays: planDays, base, addons, compositionConstraint: { kind: "plan_days", value: planDays } as Record<string, unknown> | null,
    baseLines: base.map(row => line(row.variantId, row.qty)), addonLines: addons.map(row => line(row.variantId, row.qty)),
    currentRecurringPrice: money(700), newRecurringPrice: money((quantity + addons.reduce((sum, row) => sum + row.qty, 0)) * 137),
    delta: money((quantity + addons.reduce((sum, row) => sum + row.qty, 0)) * 137 - 700),
    expectedTemplateVersion: 1, acceptedQuoteHash: hash };
}
type Evidence = ReturnType<typeof evidence>;
async function record(f: Fixture, payload: Evidence, expiry = "2026-11-05T12:15:00Z") {
  return rpc(runtime, "subscription_quote_preview_record", [f.actor, f.client, f.subscription, "update_package_template",
    payload.acceptedQuoteHash, payload.expectedTemplateVersion, expiry,
    { planDays: payload.planDays, nominalPlanDays: payload.nominalPlanDays, base: payload.base, addons: payload.addons, compositionConstraint: payload.compositionConstraint },
    { baseLines: payload.baseLines, addonLines: payload.addonLines, compositionConstraint: payload.compositionConstraint },
    { currentRecurringPrice: payload.currentRecurringPrice, newRecurringPrice: payload.newRecurringPrice, delta: payload.delta }, at]);
}
const apply = (f: Fixture, payload: Evidence, key: string = randomUUID(), db: Pool | PoolClient = runtime, now = at) =>
  rpc(db, "subscription_package_edit_apply", [f.actor, f.client, key, f.subscription, payload, now]);
async function effects() {
  const result: Record<string, unknown> = {};
  for (const { tablename } of (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    result[tablename] = (await owner.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public."${tablename}" t`)).rows[0].rows;
  }
  return result;
}
async function refuses(work: () => Promise<unknown>, reason: string) {
  const before = await effects(); await expect(work()).rejects.toMatchObject({ message: reason });
  expect(await effects()).toEqual(before);
}

it("keeps ledger tables owner-only and exposes exactly the service definer boundary", async () => {
  await expect(runtime.query("SELECT * FROM public.subscription_quote_previews")).rejects.toMatchObject({ code: "42501" });
  await expect(browser.query("SELECT public.subscription_package_edit_apply(NULL,NULL,NULL,NULL,NULL,NULL)")).rejects.toMatchObject({ code: "42501" });
  const attrs = (await owner.query(`SELECT proname,prosecdef,proconfig FROM pg_proc WHERE proname IN
    ('subscription_quote_preview_record','subscription_quote_preview_take','subscription_quote_preview_mark_accepted','subscription_package_edit_apply') ORDER BY proname`)).rows;
  expect(attrs).toHaveLength(4);
  for (const row of attrs) expect(row).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] });
  expect((await owner.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.subscription_quote_previews'::regclass")).rows[0].relrowsecurity).toBe(true);
}, 30_000);

it("records and takes an update_bundle preview while refusing unknown actions without writes", async () => {
  const f = await fixture(), hash = "c".repeat(64), expiry = "2026-11-05T12:15:00Z";
  const recordAction = (action: string) => rpc(runtime, "subscription_quote_preview_record", [
    f.actor, f.client, f.subscription, action, hash, 1, expiry, {}, {}, {}, at]);
  const takeAction = (action: string) => rpc(runtime, "subscription_quote_preview_take", [
    f.actor, f.client, f.subscription, action, hash, 1, "bundle-preview-take", at]);
  const preview = await recordAction("update_bundle");
  expect(preview).toMatchObject({ action: "update_bundle", quote_hash: hash, template_version: 1, status: "previewed" });
  const beforeTake = await effects();
  expect(await takeAction("update_bundle")).toEqual(preview);
  expect(await effects()).toEqual(beforeTake);
  await refuses(() => recordAction("unknown_action"), "subscription_command_unsupported_action");
  await refuses(() => takeAction("unknown_action"), "subscription_command_unsupported_action");
}, 30_000);

it("refuses direct sub-minimum applies and absent or malformed settings without any durable delta", async () => {
  const f = await fixture(); await record(f, evidence(f));
  await refuses(() => apply(f, evidence(f, 3)), "subscription_edit_below_minimum_order_units");
  for (const invalid of [null, "", "0", "-1", "4.0", " 4", "4 ", "abc", "2147483648"]) {
    await minimum(invalid);
    await refuses(() => apply(f, evidence(f)), "subscription_reprice_minimum_base_units_unavailable");
  }
  await minimum("4");
}, 30_000);

it("deduplicates open previews and refuses drift, expiry and reused acceptance without writes", async () => {
  const f = await fixture(), payload = evidence(f), preview = await record(f, payload);
  expect((await record(f, payload)).id).toBe(preview.id);
  for (const delta of [{ delta: money(1) }, { planDays: 21 }, { baseLines: evidence(f, 7).baseLines },
    { base: [{ variantId: f.sku, qty: 7 }] }, { addonLines: [] }, { compositionConstraint: { kind: "plan_days", value: 14 } },
    { compositionConstraint: null },
    { request: { ...payload.request, base: [{ variantId: f.sku, qty: 7 }] } },
    { request: { ...payload.request, acceptedQuoteHash: "b".repeat(64) } }]) {
    await refuses(() => apply(f, { ...payload, ...delta }), "subscription_edit_quote_drift");
  }
  await refuses(() => apply(f, payload, randomUUID(), runtime, "2026-11-05T12:15:00Z"), "subscription_edit_quote_expired");
  const event = (await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key) VALUES($1,'subscription.customer_self_service.update_package_template','used-preview-fixture:'||$1::uuid::text) RETURNING id", [f.subscription])).rows[0].id;
  await rpc(runtime, "subscription_quote_preview_mark_accepted", [preview.id, "different-key", event, at]);
  await refuses(() => apply(f, payload), "subscription_edit_quote_already_used");
}, 30_000);

it("applies agreed amounts once, preserves the anchor, and replays original state before settings or guards", async () => {
  const f = await fixture(), payload = evidence(f), key = randomUUID(); await record(f, payload);
  const result = await apply(f, payload, key);
  expect(result).toMatchObject({ status: "applied", templateVersion: 2 });
  expect(Date.parse(result.nextCycleAt)).toBe(Date.parse(next));
  expect((await owner.query("SELECT quantity,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1 ORDER BY sort_order", [f.subscription])).rows)
    .toEqual([{ quantity: 6, unit_price_minor: "137" }, { quantity: 3, unit_price_minor: "137" }]);
  const event = (await owner.query("SELECT payload FROM public.subscription_events WHERE id=$1", [result.eventId])).rows[0].payload;
  expect(event.linePricing).toEqual(payload.baseLines.map(row => ({ sku: row.quoteLine.sku, quantity: row.qty,
    unitAmountMinor: 137, isAddon: false, quoteLine: row.quoteLine })).concat(payload.addonLines.map(row => ({ sku: row.quoteLine.sku, quantity: row.qty,
    unitAmountMinor: 137, isAddon: true, quoteLine: row.quoteLine }))));
  await owner.query("UPDATE public.subscriptions SET status='cancelled',template_version=7 WHERE id=$1", [f.subscription]);
  await minimum(null);
  const before = await effects();
  expect(await apply(f, { request: payload.request } as Evidence, key, runtime, "2027-01-01T00:00:00Z"))
    .toEqual({ ...result, status: "replayed", originalStatus: "applied" });
  expect(await effects()).toEqual(before);
  expect(await apply(f, { ...payload, request: { ...payload.request, planDays: 21 } }, key))
    .toMatchObject({ status: "refused", reason: "subscription_command_idempotency_conflict" });
  expect(await effects()).toEqual(before); await minimum("4");
}, 30_000);

it("returns a no-op before ledger acceptance and locked-cycle checks, with no event or agreement mutation", async () => {
  const f = await fixture(), payload = evidence(f, 4);
  await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'paid')", [f.subscription, next]);
  const before = await effects();
  expect(await apply(f, payload, "noop-without-preview")).toMatchObject({ status: "noop", eventId: null, templateVersion: 1 });
  const after = await effects(); delete before.subscription_command_receipts; delete after.subscription_command_receipts;
  expect(after).toEqual(before);
  await refuses(() => apply(f, evidence(f)), "subscription_lifecycle_payment_blocked");
  await refuses(() => apply(f, { ...payload, acceptedQuoteHash: "bad" }), "subscription_edit_quote_required");
  await owner.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1", [f.subscription]);
  await refuses(() => apply(f, payload), "subscription_command_payment_blocked");
}, 30_000);

it("serializes two connections on one template version and leaves the losing preview unaccepted", async () => {
  const f = await fixture(), payload = evidence(f); await record(f, payload);
  const first = await runtime.connect(), second = await runtime.connect();
  try {
    await first.query("BEGIN"); const accepted = await apply(f, payload, "concurrent-first", first);
    expect(accepted.status).toBe("applied");
    let settled = false;
    const losing = apply(f, payload, "concurrent-second", second).finally(() => { settled = true; });
    const observed = losing.then(value => ({ value }), error => ({ error }));
    // Real lock wait, bounded by the server; no sleep as evidence of exclusion.
    await expect.poll(async () => (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT public.subscription_package_edit_apply%'`)).rows[0].n, { timeout: 5000 }).toBe(1);
    expect(settled).toBe(false); await first.query("COMMIT");
    const refusal = await observed; expect("error" in refusal ? refusal.error : null).toMatchObject({ message: "subscription_edit_stale_template" });
    expect((await owner.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].template_version).toBe(2);
  } finally { await first.query("ROLLBACK"); first.release(); second.release(); }
}, 30_000);


it("refuses a closed window, inactive service, missing method and open payment case without writes", async () => {
  for (const mode of ["window", "inactive", "method", "dunning"]) {
    const f = await fixture(), payload = evidence(f); await record(f, payload);
    if (mode === "window") await owner.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [f.subscription, "2026-11-06T12:00:00Z"]);
    if (mode === "inactive") await owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
    if (mode === "method") await owner.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1", [f.subscription]);
    if (mode === "dunning") await owner.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)", [f.subscription, f.client, randomUUID()]);
    await refuses(() => apply(f, payload), mode === "window" || mode === "inactive" ? "subscription_edit_window_closed" : "subscription_command_payment_blocked");
  }
}, 30_000);

it("removes an agreed add-on and restores its saved quantity through two separately accepted future templates", async () => {
  const f = await fixture(), removed = evidence(f, 6, []); await record(f, removed); await apply(f, removed);
  expect((await owner.query("SELECT quantity FROM public.subscription_lines WHERE subscription_id=$1 AND is_addon", [f.subscription])).rows).toEqual([]);
  const restored = evidence(f, 6); restored.expectedTemplateVersion = 2; restored.request.expectedTemplateVersion = 2;
  await record(f, restored); await apply(f, restored);
  expect((await owner.query("SELECT quantity FROM public.subscription_lines WHERE subscription_id=$1 AND is_addon", [f.subscription])).rows).toEqual([{ quantity: 3 }]);
}, 30_000);

it("re-quotes against real changed prices, refuses the stale hash without writes and accepts a fresh preview", async () => {
  const f = await fixture(), list = randomUUID();
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Configured','AA','XXX')", [list]);
  for (const variant of [f.sku, f.addon]) await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,100)", [list, variant]);
  const catalog = { async listQuoteCatalogItems() { return [f.sku, f.addon].map(variantId => ({ variantId, skuId: variantId, skuCode: variantId,
    productSlug: `refill-${variantId}`, netWeightG: 1, isAddon: variantId === f.addon,
    sellability: { oneTime: true, subscription: true }, documentRevision: { id: null, digest: null } })); } };
  const tax = { included: true, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "synthetic" } as const;
  const engine = createDbBackedCommerceQuotePort({ quoteCatalogReadPort: catalog, isStrictD1Quote: false,
    pricingResolverPort: { async resolvePrice(input) {
      const unit = Number((await runtime.query("SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND price_list_id=$2", [input.variantId, list])).rows[0].unit_price_minor);
      return { variantId: input.variantId, mode: input.mode, unitPriceMinor: input.mode === "one_time" ? unit + 30 : unit,
        matchedMinQty: 1, amountKind: "gross", priceListId: list, priceEntryId: input.variantId, resolvedAt: at };
    } }, taxProfile: tax, supportedTaxProfiles: [tax], regionCode: "AA", currency: "XXX", now: () => at,
    hasPromotionCodePort: false, resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [], codeRejections: [], codeRejectionDetails: [] }),
    lineContext: () => ({}), quoteContext: input => () => ({ mode: input.mode, cadenceDays: input.cadenceDays, promoCodes: input.promoCodes }) });
  const editor = createPostgresPackageEditor({ quotePort: engine, quoteCatalogReadPort: catalog, now: () => at,
    limits: { maximumPlanDays: 90, maximumBaseLines: 6, maximumAddonLines: 12, maximumQuantity: 99 },
    constraintMapper: { toCore: stored => ({ kind: "configured", version: 1, data: stored ?? {} }), fromCore: value => value.data, nominalPlanDays: () => null },
    compositionRulesPort: { validateComposition: async () => ({ ok: true }), resizeComposition: async () => null },
    async withTransaction(work) {
      const db = await runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    } });
  const request = { subscriptionId: f.subscription, planDays: 28, base: [{ variantId: f.sku, qty: 6 }], addons: [{ variantId: f.addon, qty: 3 }] };
  const old = await editor.preview({ actorId: f.actor, clientId: f.client }, request);
  await owner.query("UPDATE public.price_entries SET unit_price_minor=137 WHERE price_list_id=$1", [list]);
  await refuses(() => editor.apply({ actorId: f.actor, clientId: f.client }, "stale-live-price", { ...request, acceptedQuoteHash: old.quoteHash }), "subscription_reprice_quote_not_accepted");
  const fresh = await editor.preview({ actorId: f.actor, clientId: f.client }, request);
  expect(fresh.quoteHash).not.toBe(old.quoteHash);
  const acceptedRequest = { ...request, acceptedQuoteHash: fresh.quoteHash };
  const result = await editor.apply({ actorId: f.actor, clientId: f.client }, "fresh-live-price", acceptedRequest);
  expect(result).toMatchObject({ status: "applied", templateVersion: 2 });
  await owner.query("UPDATE public.price_entries SET unit_price_minor=199 WHERE price_list_id=$1", [list]);
  await minimum(null);
  const beforeReplay = await effects();
  expect(await editor.apply({ actorId: f.actor, clientId: f.client }, "fresh-live-price", acceptedRequest))
    .toEqual({ ...result, status: "replayed", originalStatus: "applied" });
  expect(await effects()).toEqual(beforeReplay);
  await minimum("4");
}, 30_000);


it.each([
  { kind: "unit_count", value: 8, retained: { source: "host", units: [2, 6] } },
  { kind: "plan_days", value: 28, retained: { source: "host", units: [2, 6] } },
  null,
])("persists the accepted host constraint %j through a real 28 to 14 preview and apply", async constraint => {
  const f = await fixture();
  await owner.query("UPDATE public.subscriptions SET composition_constraint=$2 WHERE id=$1", [f.subscription, constraint]);
  const before = (await owner.query("SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows[0].row;
  const lines = async () => (await owner.query("SELECT variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code FROM public.subscription_lines WHERE subscription_id=$1 ORDER BY sort_order", [f.subscription])).rows;
  const beforeLines = await lines();
  const accepted = constraint?.kind === "plan_days" ? { ...constraint, value: 14 } : constraint;
  const quoted: (Record<string, unknown> | null)[] = [];
  const editor = createPostgresPackageEditor({ now: () => at,
    limits: { maximumPlanDays: 90, maximumBaseLines: 6, maximumAddonLines: 12, maximumQuantity: 99 },
    quoteCatalogReadPort: { async listQuoteCatalogItems() { return [f.sku, f.addon].map(variantId => ({ variantId, skuCode: variantId, sellability: { subscription: true } })); } },
    quotePort: { async createServerAuthoritativeQuote(input) {
      quoted.push(input.compositionConstraint);
      const rows = input.lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitPriceGross: money(100), lineSubtotalGross: money(line.quantity * 100) }));
      return { quote: { lines: rows, totalGross: money(700), subtotalGross: money(700), discountTotalGross: money(0) } };
    } },
    constraintMapper: { toCore: stored => ({ kind: "configured", version: 1, data: stored ?? {} }), fromCore: value => value.data,
      nominalPlanDays: stored => stored?.kind === "plan_days" ? Number(stored.value) : null },
    compositionRulesPort: { validateComposition: async () => ({ ok: true }), resizeComposition: async input => constraint === null ? null : ({
      coreLines: input.coreLines, constraint: { ...input.constraint,
        data: input.constraint.data.kind === "plan_days" ? { ...input.constraint.data, value: input.lever.value } : input.constraint.data } }) },
    async withTransaction(work) {
      const db = await runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    } });
  const actor = { actorId: f.actor, clientId: f.client }, request = { subscriptionId: f.subscription, planDays: 14,
    base: [{ variantId: f.sku, qty: 4 }], addons: [{ variantId: f.addon, qty: 3 }] };
  const preview = await editor.preview(actor, request);
  expect(await editor.apply(actor, "accepted-host-constraint", { ...request, acceptedQuoteHash: preview.quoteHash }))
    .toMatchObject({ status: "applied", templateVersion: 2, subscriptionStatus: "active" });
  expect(quoted).toEqual([constraint, accepted, constraint, accepted]);
  const after = (await owner.query("SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows[0].row;
  expect(after).toEqual({ ...before, cadence_days: 14, composition_constraint: accepted, template_version: 2, updated_at: after.updated_at });
  expect(await lines()).toEqual(beforeLines);
  const ledger = (await owner.query("SELECT status,quote_snapshot FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows[0];
  expect(ledger).toMatchObject({ status: "accepted", quote_snapshot: { compositionConstraint: accepted } });
}, 30_000);

it("dispatches exactly one existing package_changed notice for a change and none for a no-op", async () => {
  const f = await fixture(), payload = evidence(f); await record(f, payload);
  const applied = await apply(f, payload), key = `subscription-notice:event:${applied.eventId}`;
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl }), captures: string[] = [], kinds: string[] = [];
  try {
    const delivery = createTransactionalDelivery({ store, delivery: createCapturedTransactionalDelivery({ outcome(command) {
      captures.push(command.idempotencyKey); return { state: "accepted" };
    } }) });
    const dispatcher = createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: store.readReceipt },
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      async bind(notice) { if (notice.id === applied.eventId && notice.source === "event") kinds.push(notice.kind);
        return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug }; } });
    await dispatcher.run(100); await dispatcher.run(100);
    expect(captures.filter(value => value === key)).toHaveLength(1); expect(kinds).toEqual(["subscription.package_changed"]);
    const noop = evidence(f); noop.expectedTemplateVersion = 2; noop.request.expectedTemplateVersion = 2;
    expect(await apply(f, noop)).toMatchObject({ status: "noop", eventId: null });
    await dispatcher.run(100);
    expect(captures.filter(value => value === key)).toHaveLength(1);
    expect((await owner.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows).toHaveLength(1);
    expect((await owner.query("SELECT * FROM public.subscription_notice_refusals WHERE source_id=$1", [applied.eventId])).rows).toEqual([]);
  } finally { await store.close(); }
}, 30_000);


it("restores the preview nominal plan into the existing constraint while preserving extended cadence and explicit quantities", async () => {
  const f = await fixture(), payload = evidence(f, 6, [], 30); payload.nominalPlanDays = 14;
  payload.compositionConstraint = { kind: "plan_days", value: 14, retained: "host" };
  await owner.query("UPDATE public.subscriptions SET cadence_days=30,composition_constraint=$2 WHERE id=$1", [f.subscription, { kind: "plan_days", value: 14, retained: "host" }]);
  await record(f, payload); payload.nominalPlanDays = 99;
  await apply(f, payload);
  expect((await owner.query("SELECT cadence_days,composition_constraint,template_version,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0])
    .toEqual({ cadence_days: 30, composition_constraint: { kind: "plan_days", value: 14, retained: "host" }, template_version: 2, next_cycle_at: new Date(next) });
  expect((await owner.query("SELECT quantity FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ quantity: 6 }]);
}, 30_000);


it("ignores only valid v1/v2 observation times and keeps malformed or material quote facts strict", async () => {
  for (const version of ["catalog_facts_v1", "catalog_facts_v2"]) {
    const f = await fixture(), facts: Record<string, unknown> = { version, skuId: f.sku, documentRevisionId: randomUUID(), documentDigest: "d".repeat(64),
      basePriceEntryId: "base-entry", mode: "subscription", atTime: at, currency: "XXX", resolvedUnitAmountMinor: 137,
      resolvedLineAmountMinor: 822, baseUnitAmountMinor: 173,
      ...(version === "catalog_facts_v1" ? { resolvedPriceEntryId: "resolved-entry" } : { policyRevisionId: randomUUID(), policyDigest: "e".repeat(64) }) };
    const original = evidence(f), payload = { ...original, baseLines: original.baseLines.map(line => ({ ...line, quoteLine: { ...line.quoteLine, catalogFacts: facts } })) };
    await record(f, payload);
    for (const [field, value] of [["atTime", "not-a-time"], ["atTime", null], ["currency", "YYY"], ["documentDigest", "f".repeat(64)],
      ["resolvedUnitAmountMinor", 138], ["skuId", randomUUID()], ["unrecognizedFact", true]] as const) {
      const changed = structuredClone(payload); changed.baseLines[0].quoteLine.catalogFacts[field] = value;
      await refuses(() => apply(f, changed), "subscription_edit_quote_drift");
    }
    const moved = structuredClone(payload); moved.baseLines[0].quoteLine.catalogFacts.atTime = "2026-11-05T12:00:01Z";
    expect(await apply(f, moved)).toMatchObject({ status: "applied", templateVersion: 2 });
  }
}, 30_000);

it("prunes at most 500 old unaccepted previews and retains accepted pricing history", async () => {
  const f = await fixture(), payload = evidence(f); await record(f, payload); await apply(f, payload);
  await owner.query(`INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,
    expires_at,request_payload,quote_snapshot,totals)
    SELECT $1,$2,$3,'update_package_template',lpad(n::text,64,'0'),2,'2026-11-01','{}','{}','{}' FROM generate_series(1,501) n`, [f.subscription, f.client, f.actor]);
  const accepted = (await owner.query("SELECT to_jsonb(q) AS row FROM public.subscription_quote_previews q WHERE status='accepted' ORDER BY id")).rows;
  const countOld = async () => Number((await owner.query("SELECT count(*) FROM public.subscription_quote_previews WHERE status='previewed' AND expires_at<'2026-11-13T00:00:00Z'")).rows[0].count);
  const before = await countOld();
  await rpc(runtime, "subscription_quote_preview_record", [f.actor, f.client, f.subscription, "update_package_template", "f".repeat(64), 2,
    "2026-11-20T00:15:00Z", {}, {}, {}, "2026-11-20T00:00:00Z"]);
  expect(await countOld()).toBe(before - 500);
  expect((await owner.query("SELECT to_jsonb(q) AS row FROM public.subscription_quote_previews q WHERE status='accepted' ORDER BY id")).rows).toEqual(accepted);
}, 30_000);

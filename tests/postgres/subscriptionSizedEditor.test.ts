import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { createPostgresSizedEditor, readSizedEditContext, quoteSizedEdit, createPostgresRenewalStore, createNativeRenewalCodec,
  SIZED_PARCEL_LEVER_KIND, createPostgresLifecycleMessages, createPostgresRenewalSettlementPort } from "@openlup/platform/subscriptions";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import type { SizedEditRequest, SizedEditorOptions, SizedQuoteLine, SizedRecurringQuote, SizedEditPolicy } from "@openlup/platform/subscriptions";
import { createCapturedTransactionalDelivery, createPostgresTransactionalDeliveryStore, createTransactionalDelivery } from "@openlup/platform/communications";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady,
  type PostgresContainer } from "../helpers/postgresContainer.js";
const at = "2026-11-06T12:00:00.000Z", next = "2026-12-20T12:00:00.000Z";
const sqlPath = "db/platform/migrations/20261104120000_subscription_sized_editor.sql";
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
function quoteLine(sku: string, quantity: number, unit = 100): SizedQuoteLine & Record<string, unknown> {
  return { sku, productSlug: "refill", quantity, unitPriceGross: money(unit), lineSubtotalGross: money(unit * quantity),
    tax: { included: true, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "synthetic", netAmount: money(unit * quantity), vatAmount: money(0), grossAmount: money(unit * quantity) },
    pricingComponents: [{ scope: "line", componentType: "base_unit", amountMinor: 173 * quantity, reasonCode: "configured", reasonPayload: { preserve: true } }], frozenEvidence: { revision: "retained", sequence: [3, 1, 2] } };
}
function fullQuote(lines: SizedQuoteLine[]): SizedRecurringQuote {
  const total = money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0));
  return { currency: "XXX", taxIncluded: true, lines, discounts: [], subtotalGross: total, discountTotalGross: money(0), totalGross: total, netTotal: total, taxTotal: money(0) };
}
const policy: SizedEditPolicy = { minimumCoreUnits: 4, maximumCoreLines: 3, maximumAddonLines: 5, maximumQuantity: 12,
  allowedCadences: [10, 20, 30], maximumExclusions: 8, maximumCatalogExclusions: 16, fixedThroughCycle: 2, graduationCycle: 3,
  portionModes: { full: { mode: "complete", factor: 1 }, reduced: { mode: "partial", factor: 0.5 } } };
let container: PostgresContainer | undefined, owner: Pool, installer: Pool, runtime: Pool, browser: Pool, runtimeUrl: string;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Sized editor requires real PostgreSQL");
  container = await runPostgresContainer({ name: `sized-editor-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Sized editor PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString });
  const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "sized_runtime", restoreLogin: "sized_restore" } as const;
  for (const name of [selection.runtimeLogin, selection.restoreLogin]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  installer = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: true, hasRestore: true });
  // Direct selected-rail install isolates behavioral evidence from pending admission-class data.
  for (const entry of [manifest.baseline, ...manifest.forward].filter(entry => entry.file !== sqlPath)) await installer.query(readFileSync(entry.file, "utf8"));
  await installer.query(readFileSync(sqlPath, "utf8"));
  await owner.query("CREATE ROLE sized_browser LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'");
  await owner.query("GRANT authenticated TO sized_browser");
  const login = (name: string, role: string) => { const url = new URL(container!.connectionString); url.username = name; url.password = "synthetic-conformance"; url.searchParams.set("options", `-c role=${role}`); return url.toString(); };
  runtimeUrl = login("sized_runtime", "service_role"); runtime = new Pool({ connectionString: runtimeUrl }); browser = new Pool({ connectionString: login("sized_browser", "authenticated") });
  await owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','4'),('subscription_sized_intro_phase',$1)", [JSON.stringify({ fixedThroughCycle: 2, graduationCycle: 3 })]);
  await owner.query("CREATE TABLE public.sized_fixture_subject(subscription_id uuid PRIMARY KEY,client_id uuid NOT NULL,facts jsonb NOT NULL,need integer NOT NULL)");
  await owner.query("GRANT SELECT,UPDATE ON public.sized_fixture_subject TO service_role");
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [owner, installer, runtime, browser].filter(Boolean)); }, postgresTeardownTimeoutMs);
async function fixture() {
  const client = randomUUID(), subscription = randomUUID(), actor = randomUUID(), a = randomUUID(), b = randomUUID(), addon = randomUUID(), priceList = randomUUID();
  await owner.query("INSERT INTO public.clients(id,email,lifecycle_stage,principal_id) VALUES($1,$2,'customer',$3)", [client, `${client}@example.invalid`, actor]);
  for (const [id, extra] of [[a, false], [b, false], [addon, true]] as const) {
    await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Refill')", [id, `refill-${id}`]);
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,is_addon,sellable_in_subscription) VALUES($1,$1,$2,'Refill',$3,true)", [id, id, extra]);
  }
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Configured','AA','XXX')", [priceList]);
  await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,currency_code,price_list_id,composition_constraint) VALUES($1,$2,20,$3,'XXX',$4,$5)", [subscription, client, next, priceList, { kind: "unit_count", value: 4, dailyNeed: 4 }]);
  await owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','synthetic-stock','sandbox',$2,'sandbox-authorization')`, [subscription, at]);
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [subscription]);
  const pricing: Record<string, unknown>[] = [];
  for (const [id, qty, ordinal, extra] of [[a, 4, 1, false], [addon, 1, 2, true]] as const) {
    await owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,$3,$4,$5,100,'XXX')", [subscription, id, qty, ordinal - 1, extra]);
    await owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,$2,$3,$4,100)", [subscription, ordinal, id, qty]);
    pricing.push({ sku: id, quantity: qty, unitAmountMinor: 100, isAddon: extra, quoteLine: quoteLine(id, qty) });
  }
  await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES($1,'subscription.starter_graduated',$2,$3,'2026-11-01T12:00:00Z')", [subscription, randomUUID(), { linePricing: pricing }]);
  await owner.query("INSERT INTO public.sized_fixture_subject VALUES($1,$2,$3,4)", [subscription, client, { revision: 1, currentExclusions: [], inheritedExclusions: ["restricted"] }]);
  return { client, subscription, actor, a, b, addon, time: at, stock: 12 as number | null, calls: [] as string[], quoted: [] as string[][] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function options(f: Fixture): SizedEditorOptions {
  return { policy, now: () => f.time,
    async withTransaction(work) { const db = await runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } },
    async readFacts(db, context, point) {
      f.calls.push(point); const row = (await db.query("SELECT * FROM public.sized_fixture_subject WHERE subscription_id=$1::uuid AND client_id=$2::uuid", [context.subscriptionId, context.clientId])).rows[0];
      if (!row) throw new Error("subscription_reprice_sized_subject_facts_unreadable");
      const facts = row.facts as Record<string, unknown>;
      return { clientId: context.clientId, subscriptionId: context.subscriptionId, subjectRef: f.subscription,
        exclusions: (Object.hasOwn(facts, "currentExclusions") ? facts.currentExclusions : facts.inheritedExclusions) as string[], snapshot: facts };
    },
    async resolveOptInNeed(db, context) {
      const row = (await db.query("SELECT * FROM public.sized_fixture_subject WHERE subscription_id=$1::uuid AND client_id=$2::uuid", [context.subscriptionId, context.clientId])).rows[0];
      if (!row) throw new Error("subscription_reprice_sized_need_unreadable"); return { dailyNeed: Number(row.need), snapshot: { facts: row.facts, need: row.need } };
    },
    async assertCurrentFacts(db, context, expected, need) {
      f.calls.push("transaction"); const row = (await db.query("SELECT * FROM public.sized_fixture_subject WHERE subscription_id=$1::uuid AND client_id=$2::uuid FOR UPDATE", [context.subscriptionId, context.clientId])).rows[0];
      if (!row || JSON.stringify(row.facts) !== JSON.stringify(expected.snapshot) || (need !== null && JSON.stringify({ facts: row.facts, need: row.need }) !== JSON.stringify(need))) throw new Error("subscription_edit_invalid_subject_snapshot");
    },
    async readCatalog(db) {
      const rows = (await db.query("SELECT id,sku,product_id,is_addon,status,sellable_in_subscription FROM public.catalog_skus WHERE id=ANY($1::uuid[])", [[f.a, f.b, f.addon]])).rows;
      return rows.map(row => ({ variantId: String(row.id), sku: String(row.sku), groupId: String(row.product_id), isAddon: row.is_addon === true,
        sellable: row.status === "active" && row.sellable_in_subscription === true, physicalSize: row.id === f.b ? 375 : 250,
        demandPerUnit: 20, documentRevisionId: String(row.id), documentDigest: "a".repeat(64), verified: true,
        exclusions: row.id === f.b ? ["restricted"] : [], sellableNow: f.stock }));
    },
    proposePortion: async ({ current, factor }) => current.map(line => ({ variantId: line.variantId, qty: Math.max(1, Math.floor(line.qty * factor)) })),
    quotePort: { async createServerAuthoritativeQuote(request) { f.quoted.push(request.lines.map(line => line.sku)); return { quote: fullQuote(request.lines.map(line => quoteLine(line.sku, line.quantity, 137))) }; } },
  };
}
function request(f: Fixture, qty = 4, optIn = true): SizedEditRequest {
  return { subscriptionId: f.subscription, action: "resize_bundle", cadenceDays: 20, compositionConstraint: { kind: "unit_count", value: qty, dailyNeed: 4 },
    resizeLever: { kind: SIZED_PARCEL_LEVER_KIND, value: { coreLines: [{ variantId: f.a, qty }], ...(optIn ? { optInToSized: true } : {}) } } };
}
const actor = (f: Fixture) => ({ clientId: f.client, actorId: f.actor });
async function accepted(f: Fixture, input = request(f), opts = options(f)) {
  const editor = createPostgresSizedEditor(opts), preview = await editor.preview(actor(f), input);
  expect(preview.preview.canApply).toBe(true); expect(preview.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
  return { editor, input: { ...input, expectedTemplateVersion: preview.preview.templateVersion, acceptedQuoteHash: preview.quoteHash } as SizedEditRequest, preview };
}
async function protectedState(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of ["subscriptions", "subscription_lines", "subscription_renewal_term_lines", "subscription_events", "subscription_command_receipts", "subscription_quote_previews", "subscription_cycles", "subscription_delivery_alignment_cases"]) {
    result[table] = (await owner.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text) ORDER BY to_jsonb(t)::text),'[]') AS value FROM public.${table} t WHERE ${table === "subscriptions" ? "id" : "subscription_id"}=$1`, [f.subscription])).rows[0].value;
  }
  return result;
}
const bind = async (f: Fixture) => { const value = await accepted(f); const result = await value.editor.apply(actor(f), randomUUID(), value.input);
  f.time = "2026-11-06T12:00:01.000Z"; return result; };
it("has real restricted runtime rights, service-only entrypoints and non-callable trigger functions", async () => {
  expect((await runtime.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,has_table_privilege(current_user,'public.subscriptions','UPDATE') AS updates")).rows)
    .toEqual([{ current_user: "service_role", elevated: false, updates: true }]);
  for (const name of ["subscriptions_configured_offer_guard()", "subscriptions_bind_sized_opt_in_from_edit()"])
    expect((await owner.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [`public.${name}`])).rows[0].allowed).toBe(false);
  await expect(browser.query("SELECT public.subscription_sized_edit_context($1,$2,true)", [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "42501" });
});
it("requires review/consent for an unchanged opt-in and binds through FK-backed acceptance before the AFTER trigger", async () => {
  const f = await fixture(), before = await protectedState(f), editor = createPostgresSizedEditor(options(f));
  const candidates = await editor.candidates(actor(f), f.subscription, true); expect(candidates.catalog.find(line => line.variantId === f.b)?.selectable).toBe(true);
  const opts = options(f), value = await accepted(f, request(f), opts); expect((await owner.query("SELECT configured_offer_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].configured_offer_version).toBe("classic");
  expect((await protectedState(f)).subscriptions).toEqual(before.subscriptions); // Abandoning a preview leaves servicing classic.
  const guard = opts.assertCurrentFacts, beforeDrift = await protectedState(f);
  opts.assertCurrentFacts = async (...args) => { await owner.query("UPDATE public.sized_fixture_subject SET need=8 WHERE subscription_id=$1", [f.subscription]); return guard(...args); };
  await expect(value.editor.apply(actor(f), "changed-need-opt-in", value.input)).rejects.toThrow("subscription_edit_invalid_subject_snapshot");
  expect(await protectedState(f)).toEqual(beforeDrift);
  await owner.query("UPDATE public.sized_fixture_subject SET need=4 WHERE subscription_id=$1", [f.subscription]); opts.assertCurrentFacts = guard;
  const result = await value.editor.apply(actor(f), "accepted-unchanged-opt-in", value.input); expect(result).toMatchObject({ status: "applied", templateVersion: 2 });
  expect((await owner.query("SELECT configured_offer_version,status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0])
    .toMatchObject({ configured_offer_version: "sized.v1", status: "active", next_cycle_at: new Date(next) });
  expect(f.quoted).toEqual([]); expect(f.calls).toContain("transaction");
  const q = (await owner.query("SELECT status,accepted_event_id FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows[0];
  expect(q).toEqual({ status: "accepted", accepted_event_id: result.eventId });
});
it("refuses direct sized INSERT, direct binding UPDATE and reverse UPDATE with real runtime table rights", async () => {
  const f = await fixture();
  await expect(runtime.query("INSERT INTO public.subscriptions(client_id,cadence_days,configured_offer_version) VALUES($1,20,'sized.v1')", [f.client])).rejects.toMatchObject({ message: "subscription_configured_offer_immutable" });
  await expect(runtime.query("UPDATE public.subscriptions SET configured_offer_version='sized.v1' WHERE id=$1", [f.subscription])).rejects.toMatchObject({ message: "subscription_configured_offer_immutable" });
  await bind(f);
  await expect(runtime.query("UPDATE public.subscriptions SET configured_offer_version='classic' WHERE id=$1", [f.subscription])).rejects.toMatchObject({ message: "subscription_configured_offer_immutable" });
});
// The binding trigger runs as its caller; only the owner-run sized apply can read previews, so a runtime-forged opt-in event fails closed.
it("rejects an unrelated or unaccepted consent event and rolls back its insert", async () => {
  const f = await fixture(); await accepted(f); const before = await protectedState(f);
  const q = (await owner.query("SELECT id FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows[0];
  await expect(runtime.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload) VALUES($1,'subscription.customer_self_service.resize_bundle',$2,$3)",
    [f.subscription, randomUUID(), { quotePreviewId: q.id, payload: { resizeLever: { kind: SIZED_PARCEL_LEVER_KIND, value: { optInToSized: true } } } }])).rejects.toMatchObject({ code: "42501", message: "permission denied for table subscription_quote_previews" });
  expect(await protectedState(f)).toEqual(before);
});
it("quotes only changed lines, retains complete agreed bytes and add-on identity, and keeps delivery alignment untouched", async () => {
  const f = await fixture(); await bind(f); const before = await protectedState(f);
  const value = await accepted(f, request(f, 5, false)); await value.editor.apply(actor(f), randomUUID(), value.input);
  expect(f.quoted).toEqual([[f.a], [f.a]]);
  const lines = (await readSizedEditContext(runtime, f.client, f.subscription)).lines;
  expect(lines.find(line => line.isAddon)?.quoteLine).toEqual(quoteLine(f.addon, 1));
  expect(lines.find(line => !line.isAddon)?.quoteLine).toEqual(quoteLine(f.a, 5, 137));
  const after = await protectedState(f); expect(after.subscription_cycles).toEqual(before.subscription_cycles); expect(after.subscription_delivery_alignment_cases).toEqual(before.subscription_delivery_alignment_cases);
  expect((after.subscriptions as { row: Record<string, unknown> }[])[0].row.next_cycle_at).toBe((before.subscriptions as { row: Record<string, unknown> }[])[0].row.next_cycle_at);
});
it("preserves zero/unknown-stock agreements and refuses increases beyond the absolute cap", async () => {
  const f = await fixture(), opted = await accepted(f, request(f, 6)); await opted.editor.apply(actor(f), randomUUID(), opted.input);
  f.time = "2026-11-06T12:00:01.000Z"; f.stock = 0;
  const cadence = await accepted(f, { subscriptionId: f.subscription, action: "update_plan_length", planDays: 30 }); await cadence.editor.apply(actor(f), randomUUID(), cadence.input);
  await expect(createPostgresSizedEditor(options(f)).preview(actor(f), request(f, 7, false))).rejects.toThrow("subscription_reprice_sized_stock_unavailable");
  f.time = "2026-11-06T12:00:02.000Z";
  const reducing = request(f, 5, false); if (reducing.action === "resize_bundle") reducing.cadenceDays = 30;
  const reduced = await accepted(f, reducing); expect((await reduced.editor.apply(actor(f), randomUUID(), reduced.input)).status).toBe("applied");
  f.time = "2026-11-06T12:00:03.000Z";
  f.stock = null; const same = request(f, 5, false); if (same.action === "resize_bundle") same.cadenceDays = 30;
  const unchanged = await accepted(f, same); expect((await unchanged.editor.apply(actor(f), randomUUID(), unchanged.input)).status).toBe("noop");
});
it("accepts bundle and fixed-total mix actions while preserving unchanged full agreements", async () => {
  const f = await fixture(); await bind(f);
  const bundle: SizedEditRequest = { subscriptionId: f.subscription, action: "update_bundle", coreLines: [{ variantId: f.a, qty: 4 }], addonLines: [{ variantId: f.addon, qty: 2 }], compositionConstraint: { kind: "unit_count", value: 4, dailyNeed: 4 } };
  const first = await accepted(f, bundle); await first.editor.apply(actor(f), randomUUID(), first.input); f.time = "2026-11-06T12:00:02.000Z";
  expect((await readSizedEditContext(runtime, f.client, f.subscription)).lines.find(line => !line.isAddon)?.quoteLine).toEqual(quoteLine(f.a, 4));
  const mix = await accepted(f, { subscriptionId: f.subscription, action: "update_base_mix", base: [{ variantId: f.b, qty: 4 }] });
  await mix.editor.apply(actor(f), randomUUID(), mix.input);
  const lines = (await readSizedEditContext(runtime, f.client, f.subscription)).lines;
  expect(lines.find(line => !line.isAddon)?.quoteLine).toEqual(quoteLine(f.b, 4, 137));
  expect(lines.find(line => line.isAddon)?.quoteLine).toEqual(quoteLine(f.addon, 2, 137));
  expect(f.quoted).toEqual([[f.addon], [f.addon], [f.b], [f.b]]);
});
it("reduces and restores a sized portion through host need without changing cadence or stored need", async () => {
  const f = await fixture(); await owner.query("UPDATE public.sized_fixture_subject SET need=8 WHERE subscription_id=$1", [f.subscription]);
  const optIn = request(f, 8); if (optIn.action === "resize_bundle") optIn.compositionConstraint.dailyNeed = 8;
  const first = await accepted(f, optIn); await first.editor.apply(actor(f), randomUUID(), first.input); f.time = "2026-11-06T12:00:01.000Z";
  const opts = options(f);
  opts.proposePortion = async ({ current, dailyNeed, cadenceDays, factor }) => [{ variantId: current[0].variantId, qty: Math.ceil(dailyNeed * cadenceDays * factor / 20) }];
  for (const [mode, count] of [["partial", 4], ["complete", 8]] as const) {
    const value = await accepted(f, { subscriptionId: f.subscription, action: "update_portion", portionMode: mode }, opts);
    expect((await value.editor.apply(actor(f), randomUUID(), value.input)).status).toBe("applied");
    const context = await readSizedEditContext(runtime, f.client, f.subscription);
    expect(context).toMatchObject({ cadenceDays: 20, compositionConstraint: { dailyNeed: 8, value: count, mode } });
    expect(Date.parse(context.nextCycleAt!)).toBe(Date.parse(next));
    f.time = "2026-11-06T12:00:02.000Z";
  }
});
it("routes sized add-on edits through the existing exact writer without repricing unchanged core", async () => {
  const f = await fixture(); await bind(f); const opts = options(f);
  opts.assertCurrentFacts = async () => { throw new Error("exact add-on actions do not use the sized transaction guard"); };
  const update = await accepted(f, { subscriptionId: f.subscription, action: "update_addon_quantity", variantId: f.addon, qty: 2 }, opts);
  await update.editor.apply(actor(f), randomUUID(), update.input); f.time = "2026-11-06T12:00:02.000Z";
  const remove = await accepted(f, { subscriptionId: f.subscription, action: "remove_addon", variantId: f.addon }, opts); await remove.editor.apply(actor(f), randomUUID(), remove.input);
  expect((await readSizedEditContext(runtime, f.client, f.subscription)).lines.map(line => line.quoteLine)).toEqual([quoteLine(f.a, 4)]);
  expect(f.quoted).toEqual([[f.addon], [f.addon]]);
});
it("checks exclusions at candidate, preview, apply and the locked transaction snapshot", async () => {
  const f = await fixture(); await bind(f); const opts = options(f), editor = createPostgresSizedEditor(opts);
  await owner.query("UPDATE public.sized_fixture_subject SET facts=jsonb_set(facts,'{currentExclusions}','[\"restricted\"]') WHERE subscription_id=$1", [f.subscription]);
  expect((await editor.candidates(actor(f), f.subscription)).catalog.find(line => line.variantId === f.b)?.selectable).toBe(false);
  const replace = request(f, 4, false); if (replace.action === "resize_bundle" && replace.resizeLever.kind === SIZED_PARCEL_LEVER_KIND) replace.resizeLever.value.coreLines[0].variantId = f.b;
  await expect(editor.preview(actor(f), replace)).rejects.toThrow("subscription_reprice_sized_exclusion_conflict");
  await owner.query("UPDATE public.sized_fixture_subject SET facts=jsonb_set(facts,'{currentExclusions}','[]') WHERE subscription_id=$1", [f.subscription]);
  const value = await accepted(f, request(f, 5, false), opts), guard = opts.assertCurrentFacts;
  opts.assertCurrentFacts = async (...args) => { await owner.query("UPDATE public.sized_fixture_subject SET facts=jsonb_set(facts,'{revision}','2') WHERE subscription_id=$1", [f.subscription]); return guard(...args); };
  const before = await protectedState(f); await expect(value.editor.apply(actor(f), randomUUID(), value.input)).rejects.toThrow("subscription_edit_invalid_subject_snapshot");
  expect(await protectedState(f)).toEqual(before); expect(f.calls).toEqual(expect.arrayContaining(["candidate", "preview", "apply", "transaction"]));
});
it("refuses facts changed between preview and apply even when the agreed money remains identical", async () => {
  const f = await fixture(); await bind(f); const value = await accepted(f, { subscriptionId: f.subscription, action: "update_plan_length", planDays: 30 });
  await owner.query("UPDATE public.sized_fixture_subject SET facts=jsonb_set(facts,'{revision}','2') WHERE subscription_id=$1", [f.subscription]);
  const before = await protectedState(f); await expect(value.editor.apply(actor(f), randomUUID(), value.input)).rejects.toThrow("subscription_edit_quote_drift"); expect(await protectedState(f)).toEqual(before);
});
async function directEvidence(f: Fixture, input: SizedEditRequest) {
  const ctx = await readSizedEditContext(runtime, f.client, f.subscription, true), opts = options(f);
  const quote = await quoteSizedEdit({ db: runtime, context: ctx, request: input, policy, host: opts, point: "preview" });
  const { subscriptionId: _id, ...raw } = input;
  const requestPayload = { ...raw, expectedTemplateVersion: ctx.templateVersion, acceptedQuoteHash: quote.quoteHash };
  const snapshot = { lines: quote.lines, cadenceDays: quote.cadenceDays, compositionConstraint: quote.compositionConstraint, subjectFacts: quote.subjectFacts, optInFacts: quote.optInFacts };
  await runtime.query("SELECT public.subscription_quote_preview_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [f.actor, f.client, f.subscription, input.action, quote.quoteHash, ctx.templateVersion, "2026-11-06T12:15:00Z", raw, snapshot, {}, at]);
  return { ...snapshot, request: requestPayload };
}
it.each(["inactive", "not-sellable"])("checks %s SKU admission inside SQL for opt-in, new and increased core, while unchanged retention survives", async kind => {
  const f = await fixture(), payload = await directEvidence(f, request(f));
  const retire = () => owner.query(kind === "inactive" ? "UPDATE public.catalog_skus SET status='archived' WHERE id=$1" : "UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id=$1", [f.a]);
  await retire(); const before = await protectedState(f);
  await expect(runtime.query("SELECT public.subscription_sized_edit_apply($1,$2,$3,$4,$5,$6)", [f.actor, f.client, randomUUID(), f.subscription, payload, at])).rejects.toMatchObject({ message: "subscription_edit_invalid_sku_admission" }); expect(await protectedState(f)).toEqual(before);
  await owner.query("UPDATE public.catalog_skus SET status='active',sellable_in_subscription=true WHERE id=$1", [f.a]); await bind(f);
  const increase = await directEvidence(f, request(f, 5, false)); await retire();
  await expect(runtime.query("SELECT public.subscription_sized_edit_apply($1,$2,$3,$4,$5,$6)", [f.actor, f.client, randomUUID(), f.subscription, increase, at])).rejects.toMatchObject({ message: "subscription_edit_invalid_sku_admission" });
  const replacing = request(f, 4, false);
  if (replacing.action === "resize_bundle" && replacing.resizeLever.kind === SIZED_PARCEL_LEVER_KIND) replacing.resizeLever.value.coreLines[0].variantId = f.b;
  const newLine = await directEvidence(f, replacing);
  await owner.query("UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id=$1", [f.b]);
  await expect(runtime.query("SELECT public.subscription_sized_edit_apply($1,$2,$3,$4,$5,$6)", [f.actor, f.client, randomUUID(), f.subscription, newLine, at])).rejects.toMatchObject({ message: "subscription_edit_invalid_sku_admission" });
  const retained = await accepted(f, { subscriptionId: f.subscription, action: "update_plan_length", planDays: 30 }); expect((await retained.editor.apply(actor(f), randomUUID(), retained.input)).status).toBe("applied");
});
async function pastCycle(f: Fixture) {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    const cycle = (await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-10-01T12:00:00Z','paid') RETURNING id", [f.subscription])).rows[0].id;
    const order = (await db.query("INSERT INTO public.commerce_orders(client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',500) RETURNING id", [f.client, cycle])).rows[0].id;
    for (const [ordinal, sku, qty] of [[1, f.a, 4], [2, f.addon, 1]]) await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,$3,$4,100,$4::integer*100)", [order, sku, ordinal, qty]);
    await db.query("COMMIT"); return { cycle, order };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
it("does not settle an outstanding protected delivery or move its anchor when editing", async () => {
  const f = await fixture(); await bind(f); const past = await pastCycle(f);
  const alignment = (await owner.query(`INSERT INTO public.subscription_delivery_alignment_cases(predecessor_order_id,subscription_id,predecessor_cycle_id,
    captured_mode,state,evidence_kind,observed_next_cycle_at) VALUES($1,$2,$3,'protect','protected','missing_fulfillment',$4) RETURNING id`, [past.order, f.subscription, past.cycle, next])).rows[0].id;
  const readAlignment = async () => (await owner.query("SELECT to_jsonb(t) value,xmin::text FROM public.subscription_delivery_alignment_cases t WHERE id=$1", [alignment])).rows;
  const originalAlignment = await readAlignment();
  const value = await accepted(f, request(f, 5, false)); await value.editor.apply(actor(f), randomUUID(), value.input);
  expect(await readAlignment()).toEqual(originalAlignment);
  expect((await owner.query("SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0]).toEqual({ next_cycle_at: new Date(next), status: "active" });
});
it("renews the exact merged agreements through native order preparation, without live repricing or substitutions", async () => {
  const f = await fixture(); await bind(f); const past = await pastCycle(f);
  const facts = { templateId: "synthetic-template", shippingAmountMinor: 0, acquisitionRef: null, renewalTerms: { version: "native.renewal-terms.v1" } };
  await owner.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,
    activation_idempotency_key,declare_idempotency_key,declared_at,activated_at) VALUES($1,$2,$3,20,'active',repeat('a',64),$4,$5,$6,$6)`,
  [past.order, f.client, f.subscription, randomUUID(), randomUUID(), at]);
  await owner.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [past.order, f.subscription, facts, at]);
  const destination = (await runtime.query("SELECT public.commerce_register_order_destination($1,$2,$3,$4) result", [randomUUID(), past.order,
    { recipientName: "Sample Customer", line1: "1 Example Street", city: "Example City", postalCode: "00000", country: "AA" }, at])).rows[0].result.destinationId;
  await owner.query("INSERT INTO public.commerce_destination_bindings(subscription_id,destination_id) VALUES($1,$2)", [f.subscription, destination]);
  const value = await accepted(f, request(f, 5, false)); await value.editor.apply(actor(f), randomUUID(), value.input);
  const codec = createNativeRenewalCodec(), store = createPostgresRenewalStore(runtime, codec, options(f).withTransaction);
  const due = (await store.listDue(500, next)).find(row => row.subscriptionId === f.subscription)!;
  const snapshot = await store.buildCycleSnapshots(due);
  expect(snapshot.pricingSnapshot).toMatchObject({ productSubtotalAmountMinor: 785, totalAmountMinor: 785,
    linePricing: [{ sku: f.a, quantity: 5, unitAmountMinor: 137 }, { sku: f.addon, quantity: 1, unitAmountMinor: 100 }] });
  const claim = await store.claimDue({ snapshot, workerId: "sized-price-witness", now: next });
  const stock = createPostgresFulfillmentStockSyncPort(runtime, { sourceKey: "synthetic-stock", readLocalInventoryStock: async () => [] });
  for (const sku of [f.a, f.addon]) await stock.recordProviderStockCurrent({ requestKey: randomUUID(), snapshot: { providerRef: "synthetic-stock", collectedAt: next,
    sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef: sku, totalQuantity: 100, forSaleQuantity: 100,
    reservedOrUnavailableQuantity: 0, syncRunId: "sized-stock" }, inventoryClass: "sellable", lastSyncedAt: next, staleAfter: "2027-01-01T00:00:00Z" });
  expect((await runtime.query("SELECT public.fulfillment_reserve_subscription_renewal($1,$2,900,$3) result", [claim.operationId, claim.claimToken, next])).rows[0].result.status).toBe("held");
  const bill = await createPostgresRenewalSettlementPort(runtime, codec, options(f).withTransaction).prepareRenewal({ operationId: claim.operationId, claimToken: claim.claimToken, now: next });
  expect((await owner.query("SELECT total_amount_minor FROM public.commerce_orders WHERE id=$1", [bill.orderId])).rows[0].total_amount_minor).toBe("785");
  expect((await owner.query("SELECT sum(line_amount_minor)::text amount,sum(quantity)::int units FROM public.commerce_order_items WHERE order_id=$1", [bill.orderId])).rows[0]).toEqual({ amount: "785", units: 6 });
});
it("emits one package_changed notice for each real sized change and none for a no-op", async () => {
  const f = await fixture(), first = await bind(f), second = await accepted(f, request(f, 5, false));
  const secondResult = await second.editor.apply(actor(f), randomUUID(), second.input); f.time = "2026-11-06T12:00:02.000Z";
  const noop = await accepted(f, request(f, 5, false)); expect((await noop.editor.apply(actor(f), randomUUID(), noop.input)).status).toBe("noop");
  const events = [first.eventId, secondResult.eventId], sent: string[] = [], kinds: string[] = [];
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  try {
    const delivery = createTransactionalDelivery({ store, delivery: createCapturedTransactionalDelivery({ outcome(command) { sent.push(command.idempotencyKey); return { state: "accepted" }; } }) });
    const dispatcher = createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: store.readReceipt },
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      async bind(notice) { if (events.includes(notice.id)) kinds.push(notice.kind); return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug }; } });
    await dispatcher.run(100); await dispatcher.run(100);
    for (const event of events) expect(sent.filter(key => key === `subscription-notice:event:${event}`)).toHaveLength(1);
    expect(kinds).toEqual(["subscription.package_changed", "subscription.package_changed"]);
  } finally { await store.close(); }
}, 30_000);
it("falls back from retained terms to the activation quote and refuses missing/disagreeing agreement bytes", async () => {
  const f = await fixture(), past = await pastCycle(f);
  await owner.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,
    activation_idempotency_key,declare_idempotency_key,declared_at,activated_at) VALUES($1,$2,$3,20,'active',repeat('a',64),$4,$5,$6,$6)`, [past.order, f.client, f.subscription, randomUUID(), randomUUID(), at]);
  const prices = [{ sku: f.a, quantity: 4, unitAmountMinor: 100, isAddon: false, quoteLine: quoteLine(f.a, 4) }, { sku: f.addon, quantity: 1, unitAmountMinor: 100, isAddon: true, quoteLine: quoteLine(f.addon, 1) }];
  await owner.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [past.order, f.subscription,
    { templateId: "retained", shippingAmountMinor: 0, renewalTerms: { version: "native.renewal-terms.v1", linePricing: prices } }, at]);
  await owner.query("DELETE FROM public.subscription_events WHERE subscription_id=$1", [f.subscription]);
  expect((await readSizedEditContext(runtime, f.client, f.subscription, true)).lines[0].quoteLine).toEqual(prices[0].quoteLine);
  await owner.query("UPDATE public.subscription_renewal_attachments SET purchase_facts=purchase_facts-'renewalTerms' WHERE subscription_id=$1", [f.subscription]);
  await owner.query("UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1", [past.order, { quoteSnapshot: { quote: fullQuote(prices.map(price => price.quoteLine)) } }]);
  expect((await readSizedEditContext(runtime, f.client, f.subscription, true)).lines[1].quoteLine).toEqual(prices[1].quoteLine);
  await owner.query("UPDATE public.subscription_lines SET unit_price_minor=101 WHERE subscription_id=$1 AND NOT is_addon", [f.subscription]);
  await expect(readSizedEditContext(runtime, f.client, f.subscription, true)).rejects.toThrow("subscription_edit_invalid_agreed_price");
});
it("refuses malformed event evidence and disagreement with the exact native renewal amounts", async () => {
  const f = await fixture();
  await owner.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=101 WHERE subscription_id=$1 AND sku=$2", [f.subscription, f.a]);
  await expect(readSizedEditContext(runtime, f.client, f.subscription, true)).rejects.toThrow("subscription_edit_invalid_agreed_price");
  await owner.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=100 WHERE subscription_id=$1", [f.subscription]);
  await owner.query("UPDATE public.subscription_events SET payload='{}' WHERE subscription_id=$1", [f.subscription]);
  await expect(readSizedEditContext(runtime, f.client, f.subscription, true)).rejects.toThrow("subscription_edit_invalid_agreed_price");
});
it.each([1, 2])("refuses classic introductory opt-in with %s paid cycles in both dispatch and SQL", async paid => {
  const f = await fixture(), past = await pastCycle(f);
  if (paid === 2) await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-10-21T12:00:00Z','paid')", [f.subscription]);
  const facts = { templateId: "introductory", shippingAmountMinor: 0, renewalTerms: { version: "native.renewal-terms.v1", minimumPayableMinor: 1,
    normalCadenceDays: [10, 20, 30], starterPack: { schemaVersion: "1", starterIntervalDays: 20, basisTemplateVersion: 1,
      delivery2: { discountBps: 2500, discountMinor: 100, basisSubtotalMinor: 500 }, graduation: { cadenceDays: 30,
        sizeConstraint: { kind: "unit_count", value: 4, dailyNeed: 4 }, lines: [{ sku: f.a, qty: 4, sortOrder: 0, isAddon: false, quoteLine: quoteLine(f.a, 4) }] } } } };
  await owner.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [past.order, f.subscription, facts, at]);
  await expect(createPostgresSizedEditor(options(f)).preview(actor(f), request(f))).rejects.toThrow("subscription_edit_invalid_intro_fixed");
  const payload = await directEvidence(f, request(f)), before = await protectedState(f);
  await expect(runtime.query("SELECT public.subscription_sized_edit_apply($1,$2,$3,$4,$5,$6)", [f.actor, f.client, randomUUID(), f.subscription, payload, at])).rejects.toMatchObject({ message: "subscription_edit_invalid_intro_fixed" });
  expect(await protectedState(f)).toEqual(before);
});
it("replays a committed key before changed facts/need/catalogue/quote reads and refuses changed action", async () => {
  const f = await fixture(), value = await accepted(f), key = randomUUID(); const result = await value.editor.apply(actor(f), key, value.input);
  await owner.query("UPDATE public.sized_fixture_subject SET facts='{}',need=0 WHERE subscription_id=$1", [f.subscription]); f.stock = 0;
  const before = await protectedState(f), calls = f.calls.length, quotes = f.quoted.length;
  expect(await value.editor.apply(actor(f), key, value.input)).toMatchObject({ status: "replayed", eventId: result.eventId });
  expect(f.calls).toHaveLength(calls); expect(f.quoted).toHaveLength(quotes); expect(await protectedState(f)).toEqual(before);
  await expect(value.editor.apply(actor(f), key, { subscriptionId: f.subscription, action: "update_plan_length", planDays: 30, acceptedQuoteHash: value.input.acceptedQuoteHash })).rejects.toThrow("subscription_command_idempotency_conflict");
});
it("serializes concurrent accepted opt-ins so one version wins", async () => {
  const f = await fixture(), value = await accepted(f);
  const settled = await Promise.allSettled([value.editor.apply(actor(f), randomUUID(), value.input), value.editor.apply(actor(f), randomUUID(), value.input)]);
  expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await owner.query("SELECT count(*)::int n FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.resize_bundle'", [f.subscription])).rows[0].n).toBe(1);
});
it("enforces ownership, window, status, method, dunning, version, expired preview and drift without writes", async () => {
  for (const guard of ["owner", "window", "status", "method", "dunning", "version", "expired", "drift"]) {
    const f = await fixture(), payload = await directEvidence(f, request(f));
    if (guard === "window") await owner.query("UPDATE public.subscriptions SET next_cycle_at='2026-11-07T12:00:00Z' WHERE id=$1", [f.subscription]);
    if (guard === "status") await owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
    if (guard === "method") await owner.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1", [f.subscription]);
    if (guard === "dunning") await owner.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)", [f.subscription, f.client, randomUUID()]);
    if (guard === "version") payload.request.expectedTemplateVersion = 9;
    if (guard === "drift") payload.lines[0].quoteLine = quoteLine(f.a, 4, 101);
    const before = await protectedState(f);
    await expect(runtime.query("SELECT public.subscription_sized_edit_apply($1,$2,$3,$4,$5,$6)", [f.actor, guard === "owner" ? randomUUID() : f.client, randomUUID(), f.subscription, payload, guard === "expired" ? "2026-11-06T12:16:00Z" : at])).rejects.toBeDefined();
    expect(await protectedState(f)).toEqual(before);
  }
});
it.each(["activation", "graduation", "classic-package"])("keeps the existing %s writer compatible with the binding guard", async writer => {
  const f = await fixture();
  if (writer === "activation") {
    const order = (await owner.query(`WITH inserted AS (
      INSERT INTO public.commerce_orders(client_id,status,currency_code,total_amount_minor) VALUES($1,'pending_payment','XXX',500) RETURNING id),
      items AS (INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        SELECT id,$2,1,5,100,500 FROM inserted RETURNING order_id) SELECT order_id AS id FROM items`, [f.client, f.a])).rows[0].id;
    const intent = (await runtime.query("SELECT public.commerce_open_settlement_intent($1,$2,'sandbox',500,'XXX','{}',$3) result", [randomUUID(), order, at])).rows[0].result;
    await owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=$2 WHERE id=$1", [intent.settlement.id, at]);
    await owner.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1", [order]);
    await runtime.query("SELECT public.subscription_declare_provisional_activation($1,$2,20,$3)", [randomUUID(), order, at]);
    const result = (await runtime.query(`SELECT public.subscription_activate_from_captured_payment($1,$2,
      encode(sha256(convert_to(COALESCE(external_ref,id::text),'UTF8')),'hex')) result
      FROM public.commerce_settlement_intents WHERE id=$3`, [randomUUID(), order, intent.settlement.id])).rows[0].result;
    expect((await owner.query("SELECT configured_offer_version,status FROM public.subscriptions WHERE id=$1", [result.subscriptionId])).rows[0])
      .toEqual({ configured_offer_version: "classic", status: "active" });
    return;
  }
  if (writer === "graduation") {
    const past = await pastCycle(f);
    await owner.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,
      activation_idempotency_key,declare_idempotency_key,declared_at,activated_at) VALUES($1,$2,$3,20,'active',repeat('a',64),$4,$5,$6,$6)`,
    [past.order, f.client, f.subscription, randomUUID(), randomUUID(), at]);
    await owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,'2026-10-21T12:00:00Z','paid')", [f.subscription]);
    await owner.query("UPDATE public.subscription_renewal_terms SET next_cycle_number=2 WHERE subscription_id=$1", [f.subscription]);
    const facts = { templateId: "introductory", shippingAmountMinor: 0, renewalTerms: { version: "native.renewal-terms.v1", minimumPayableMinor: 1,
      normalCadenceDays: [10, 20, 30], starterPack: { schemaVersion: "1", starterIntervalDays: 20, basisTemplateVersion: 1,
        delivery2: { discountBps: 2500, discountMinor: 100, basisSubtotalMinor: 500 }, graduation: { cadenceDays: 30,
          lines: [{ sku: f.b, qty: 4, sortOrder: 0, isAddon: false, quoteLine: quoteLine(f.b, 4) }] } } } };
    await owner.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [past.order, f.subscription, facts, at]);
    const store = createPostgresRenewalStore(runtime, createNativeRenewalCodec(), options(f).withTransaction);
    const due = (await store.listDue(500, next)).find(row => row.subscriptionId === f.subscription)!;
    expect((await store.buildCycleSnapshots(due)).templateSnapshot).toMatchObject({ version: 2, cadenceDays: 30, lines: [{ sku: f.b }, { sku: f.addon }] });
  } else {
    const base = [{ variantId: f.a, qty: 5 }], addons = [{ variantId: f.addon, qty: 1 }], hash = "e".repeat(64);
    const baseLines = [{ ...base[0], quoteLine: quoteLine(f.a, 5) }], addonLines = [{ ...addons[0], quoteLine: quoteLine(f.addon, 1) }];
    const requestPayload = { planDays: 20, base, addons, expectedTemplateVersion: 1, acceptedQuoteHash: hash };
    const totals = { currentRecurringPrice: money(500), newRecurringPrice: money(600), delta: money(100) };
    const compositionConstraint = { kind: "unit_count", value: 4, dailyNeed: 4 };
    await runtime.query("SELECT public.subscription_quote_preview_record($1,$2,$3,'update_package_template',$4,1,$5,$6,$7,$8,$9)",
      [f.actor, f.client, f.subscription, hash, "2026-11-06T12:15:00Z", { planDays: 20, base, addons }, { baseLines, addonLines, compositionConstraint }, totals, at]);
    const result = (await runtime.query("SELECT public.subscription_package_edit_apply($1,$2,$3,$4,$5,$6) result", [f.actor, f.client, randomUUID(), f.subscription,
      { request: requestPayload, planDays: 20, base, addons, baseLines, addonLines, ...totals, expectedTemplateVersion: 1, acceptedQuoteHash: hash }, at])).rows[0].result;
    expect(result.status).toBe("applied");
    expect((await owner.query("SELECT composition_constraint FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].composition_constraint)
      .toEqual(compositionConstraint);
  }
  expect((await owner.query("SELECT configured_offer_version,status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0])
    .toEqual({ configured_offer_version: "classic", status: "active", next_cycle_at: new Date(next) });
});

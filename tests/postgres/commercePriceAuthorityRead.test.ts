/** Characterizes strict price history reads and bounded native promotion evidence on PostgreSQL. */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPostgresCommercePriceAuthorityReadPort } from "@openlup/platform/commerce/server/postgres";
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "@openlup/platform/migrations";
import { createConcurrentCommercePriceAuthorityPort, createDbBackedCommerceQuotePort, digestSubscriptionPricePolicy } from "@openlup/platform/pricing";
import type { SubscriptionPricePolicyCanonicalInput } from "@openlup/platform/pricing";
import { createPostgresCommercePromoDataPort } from "@openlup/platform/promotions";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, admin: Pool, runtime: Pool;
const password = "synthetic-conformance";
const installation: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "postgres", bootstrapLogin: "postgres", runtimeLogin: "price_read_runtime", restoreLogin: "price_read_restore" };
const at = "2026-09-01T00:00:00.000Z", start = "2026-01-01T00:00:00.000Z", future = "2027-01-01T00:00:00.000Z";
const sku = randomUUID(), product = randomUUID();
const context = { regionCode: "ZZ", currency: "XTS", channel: "D2C" };
let list: string;
const query = () => ({ ...context, variantId: sku, mode: "subscription" as const, atTime: at });
const reads = (executor: PgQueryExecutor = runtime) => createPostgresCommercePriceAuthorityReadPort(executor);
const authority = (executor: PgQueryExecutor = runtime) => createConcurrentCommercePriceAuthorityPort(reads(executor));

beforeAll(async () => {
  container = await runPostgresContainer({ name: `commerce-price-read-${process.pid}`, password });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("price_read_postgres_tcp_unavailable");
  admin = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  for (const name of [installation.runtimeLogin, installation.restoreLogin!]) {
    await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  }
  const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => admin });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString); url.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: url.toString() });
  await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,'price-read-item','Example item')", [product]);
  await admin.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ($1,$2,'PRICE-READ-ITEM','Example item')", [sku, product]);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [admin, runtime]), postgresTeardownTimeoutMs);
beforeEach(async () => {
  await admin.query("UPDATE public.price_lists SET status='archived'");
  list = await priceList();
});

async function priceList(region = context.regionCode, currency = context.currency, from = start, to: string | null = null) {
  const id = randomUUID();
  await admin.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from,valid_to) VALUES ($1,'Example list',$2,$3,$4,$5)", [id, region, currency, from, to]);
  return id;
}
async function entry(overrides: { mode?: string; min?: number; amount?: number; kind?: string; from?: string; to?: string | null; active?: boolean; list?: string; variant?: string } = {}) {
  const id = randomUUID();
  await admin.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from,valid_to,active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, overrides.list ?? list, overrides.variant ?? sku, overrides.mode ?? "one_time",
    overrides.min ?? 1, overrides.amount ?? 1499, overrides.kind ?? "gross", overrides.from ?? start, overrides.to ?? null, overrides.active ?? true]);
  return id;
}
async function policy(overrides: Partial<SubscriptionPricePolicyCanonicalInput> = {}, invalidDigest = false) {
  const value: SubscriptionPricePolicyCanonicalInput = { id: randomUUID(), revisionNo: 1, priceListId: list,
    ...context, discountBps: 500, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM", effectiveFrom: start, effectiveTo: null, ...overrides };
  const digest = invalidDigest ? "b".repeat(64) : await digestSubscriptionPricePolicy(value);
  await admin.query(`INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,
    discount_bps,rounding_quantum_minor,rounding_rule,effective_from,effective_to,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [value.id, value.revisionNo, value.priceListId, value.regionCode, value.currency, value.channel, value.discountBps,
    value.roundingQuantumMinor, value.roundingRule, value.effectiveFrom, value.effectiveTo, digest]);
  return { ...value, digest };
}

it("uses the restricted runtime and leaves configuration writes denied", async () => {
  expect((await runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: installation.runtimeLogin, session_user: installation.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
  await expect(runtime.query("UPDATE public.price_entries SET unit_price_minor=1 WHERE false")).rejects.toMatchObject({ code: "42501" });
  await expect(runtime.query("UPDATE public.commerce_promotion_definitions SET active=false WHERE false")).rejects.toMatchObject({ code: "42501" });
  expect(await reads().listPriceLists(context)).toHaveLength(1);
});

it("uses exact region/currency and active status without selecting a newest list", async () => {
  await priceList("YY"); await priceList("ZZ", "XXX");
  const archived = await priceList(); await admin.query("UPDATE public.price_lists SET status='draft' WHERE id=$1", [archived]);
  expect((await reads().listPriceLists(context)).map(row => row.value)).toEqual([list]);
  expect(await reads().listPriceLists({ ...context, regionCode: "zz" })).toEqual([]);
  expect(await reads().listPriceLists({ ...context, currency: "xts" })).toEqual([]);
  await priceList("ZZ", "XTS", "2026-08-01T00:00:00Z");
  await expect(authority().resolvePrice(query())).rejects.toMatchObject({ code: "active_price_list_ambiguous" });
});

it("retains exact entry history, excludes fallback/tier/inactive/other-list rows and normalizes driver Dates", async () => {
  const first = await entry(); await entry({ from: future }); await entry({ to: at });
  await entry({ mode: "any" }); await entry({ min: 2 }); await entry({ active: false });
  await entry({ list: await priceList("YY") });
  await entry({ mode: "subscription", amount: 1400 });
  const port = reads(); const found = await port.listExactBaseEntries({ variantId: sku, priceListId: list });
  expect(found).toHaveLength(3);
  expect(found.map(row => row.value.priceEntryId)).toEqual([...found.map(row => row.value.priceEntryId)].sort());
  expect(found.find(row => row.value.priceEntryId === first)).toMatchObject({ validFrom: start, validTo: null,
    value: { mode: "one_time", matchedMinQty: 1, resolvedAt: start, unitPriceMinor: 1499 } });
  expect(await port.listExactLegacySubscriptionEntries({ variantId: sku, priceListId: list })).toMatchObject([{ value: { mode: "subscription", unitPriceMinor: 1400 } }]);
});

it("reads the complete ordered policy history and validates canonical instants at the exact boundary", async () => {
  await entry();
  const ended = await policy({ revisionNo: 1, effectiveTo: at });
  const current = await policy({ revisionNo: 2, effectiveFrom: at, effectiveTo: future });
  await policy({ revisionNo: 3, effectiveFrom: future });
  await policy({ channel: "OTHER" });
  const history = await reads().listSubscriptionPolicyHistory({ ...context, priceListId: list });
  expect(history.map(row => (row.value as { revisionNo: number }).revisionNo)).toEqual([1, 2, 3]);
  expect(history[0]).toEqual({ value: ended, validFrom: start, validTo: at });
  expect(await authority().resolvePrice(query())).toMatchObject({ kind: "subscription_policy", unitPriceMinor: 1420, policy: { id: current.id } });
});

const refusalCases = ["active_price_list_not_found", "active_price_list_ambiguous", "base_price_not_found", "base_price_ambiguous",
  "base_price_amount_kind_invalid", "legacy_subscription_price_not_found", "legacy_subscription_price_ambiguous",
  "subscription_price_policy_not_effective", "subscription_price_policy_ambiguous", "subscription_price_policy_invalid", "subscription_price_policy_digest_mismatch"] as const;
it.each(refusalCases)("preserves the real-port engine refusal %s", async code => {
  let channel = context.channel;
  if (code === "active_price_list_not_found") await admin.query("UPDATE public.price_lists SET status='archived'");
  else if (code === "active_price_list_ambiguous") await priceList();
  else if (code !== "base_price_not_found") await entry({ kind: code === "base_price_amount_kind_invalid" ? "net" : "gross" });
  if (code === "base_price_ambiguous") await entry();
  if (code === "legacy_subscription_price_ambiguous") { await entry({ mode: "subscription" }); await entry({ mode: "subscription" }); }
  if (code === "subscription_price_policy_not_effective") { await policy({ effectiveFrom: future }); await entry({ mode: "subscription" }); }
  if (code === "subscription_price_policy_ambiguous") await policy();
  // Database permits a long channel; the current engine's public schema refuses it.
  if (code === "subscription_price_policy_invalid") { channel = "x".repeat(65); await policy({ channel }, true); }
  if (code === "subscription_price_policy_digest_mismatch") await policy({}, true);
  // Stored overlaps are refused by PostgreSQL. Exercise a duplicated transport row
  // after the real SELECT without disabling that database protection.
  const executor: PgQueryExecutor = { async query(sql, values) {
    const result = await runtime.query(sql, values);
    return code === "subscription_price_policy_ambiguous" && sql.includes("FROM public.subscription_price_policy_revisions")
      ? { rows: [...result.rows, ...result.rows] } : result;
  } };
  await expect(authority(executor).resolvePrice({ ...query(), channel })).rejects.toMatchObject({ code });
});

it("permits legacy only with no history and uses half-open list/entry intervals", async () => {
  await admin.query("UPDATE public.price_lists SET valid_to=$2 WHERE id=$1", [list, at]);
  list = await priceList("ZZ", "XTS", at);
  await entry({ from: at }); await entry({ mode: "subscription", from: at, amount: 1390 });
  expect(await authority().resolvePrice(query())).toMatchObject({ kind: "subscription_legacy", unitPriceMinor: 1390 });
  await expect(authority().resolvePrice({ ...query(), atTime: "2025-12-31T23:59:59.999Z" })).rejects.toMatchObject({ code: "active_price_list_not_found" });
  await policy({ effectiveFrom: future });
  await expect(authority().resolvePrice(query())).rejects.toMatchObject({ code: "subscription_price_policy_not_effective" });
});

it("deduplicates a request, chunks 501 UUIDs at 500 and retains histories beyond the argument-count limit", async () => {
  const ids = Array.from({ length: 501 }, () => randomUUID());
  const historyRows = 150_000;
  await admin.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title)
    SELECT id,$2,'READ-'||id::text,'Example' FROM unnest($1::uuid[]) id`, [ids, product]);
  await admin.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT $1,id,'one_time',1499,$3 FROM unnest($2::uuid[]) id`, [list, ids, start]);
  await admin.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT $1,$2,'one_time',1499,$3 FROM generate_series(1,$4::integer)`, [list, ids[0], future, historyRows - 1]);
  const recorder = vi.fn((sql: string, values?: unknown[]) => runtime.query(sql, values));
  const port = reads({ query: recorder });
  const all = await Promise.all([...ids, ids[0]!].map(variantId => port.listExactBaseEntries({ variantId, priceListId: list })));
  expect(all[0]).toHaveLength(historyRows); expect(all[501]).toEqual(all[0]);
  expect(recorder.mock.calls.map(call => (call[1]![0] as string[]).length)).toEqual([500, 1]);
  expect(all.slice(1, 501).every(rows => rows.length === 1)).toBe(true);
  const first = all[0]![0]!; first.value.unitPriceMinor = 1;
  expect((await port.listExactBaseEntries({ variantId: ids[0]!, priceListId: list }))[0]!.value.unitPriceMinor).toBe(1499);
  await admin.query("UPDATE public.price_entries SET unit_price_minor=1599 WHERE price_list_id=$1", [list]);
  expect((await reads().listExactBaseEntries({ variantId: ids[0]!, priceListId: list }))[0]!.value.unitPriceMinor).toBe(1599);
});

it.each(["lists", "entries", "policies"] as const)("retains rejected %s reads rather than yielding empty success", async phase => {
  const failure = new Error("read unavailable");
  const executor = { query: vi.fn(async () => { throw failure; }) };
  const port = reads(executor);
  const read = () => phase === "lists" ? port.listPriceLists(context) : phase === "policies"
    ? port.listSubscriptionPolicyHistory({ ...context, priceListId: list }) : port.listExactBaseEntries({ variantId: sku, priceListId: list });
  const result = await Promise.allSettled([read(), read()]);
  expect(result.map(value => value.status === "rejected" && value.reason)).toEqual([failure, failure]);
  await expect(read()).rejects.toBe(failure); expect(executor.query).toHaveBeenCalledTimes(1);
});

it("separates raw memo identities and rechecks effective time/mode without caching resolved money", async () => {
  await entry(); await entry({ mode: "subscription", amount: 1400 }); await policy({ channel: "OTHER" });
  const recorder = vi.fn((sql: string, values?: unknown[]) => runtime.query(sql, values));
  const port = reads({ query: recorder });
  await Promise.all([port.listPriceLists(context), port.listPriceLists(context), port.listPriceLists({ ...context, currency: "XXX" }), port.listPriceLists({ ...context, regionCode: "YY" })]);
  await Promise.all([port.listSubscriptionPolicyHistory({ ...context, priceListId: list }), port.listSubscriptionPolicyHistory({ ...context, priceListId: list }),
    port.listSubscriptionPolicyHistory({ ...context, channel: "OTHER", priceListId: list }), port.listSubscriptionPolicyHistory({ ...context, regionCode: "YY", priceListId: list }),
    port.listSubscriptionPolicyHistory({ ...context, currency: "XXX", priceListId: list }), port.listSubscriptionPolicyHistory({ ...context, priceListId: randomUUID() })]);
  expect(recorder.mock.calls.filter(call => call[0].includes("FROM public.price_lists"))).toHaveLength(3);
  expect(recorder.mock.calls.filter(call => call[0].includes("FROM public.subscription_price_policy_revisions"))).toHaveLength(5);
  const mutableLists = await port.listPriceLists(context); mutableLists[0]!.value = "changed";
  expect((await port.listPriceLists(context))[0]!.value).toBe(list);
  const policyInput = { ...context, channel: "OTHER", priceListId: list };
  const mutablePolicy = await port.listSubscriptionPolicyHistory(policyInput);
  (mutablePolicy[0]!.value as { discountBps: number }).discountBps = 1;
  expect((await port.listSubscriptionPolicyHistory(policyInput))[0]!.value).toMatchObject({ discountBps: 500 });
  const bound = createConcurrentCommercePriceAuthorityPort(port);
  expect(await bound.resolvePrice(query())).toMatchObject({ kind: "subscription_legacy", unitPriceMinor: 1400 });
  await expect(bound.resolvePrice({ ...query(), atTime: "1999-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "active_price_list_not_found" });
  expect(await bound.resolvePrice({ ...query(), mode: "one_time" })).toMatchObject({ kind: "one_time", unitPriceMinor: 1499 });
});

it("starts history with the real base read while preserving base-refusal precedence", async () => {
  let release!: () => void;
  const historyStarted = new Promise<void>(resolve => { release = resolve; });
  const historyFailure = new Error("history unavailable");
  const executor: PgQueryExecutor = { async query(sql, values) {
    if (sql.includes("FROM public.subscription_price_policy_revisions")) { release(); throw historyFailure; }
    if (sql.includes("FROM public.price_entries")) await historyStarted;
    return runtime.query(sql, values);
  } };
  await expect(authority(executor).resolvePrice(query())).rejects.toMatchObject({ code: "base_price_not_found" });
  await entry();
  await expect(authority(executor).resolvePrice(query())).rejects.toBe(historyFailure);
});

it("quotes one-time and subscription lines through the existing engine using the seeded floor policy", async () => {
  await entry(); await policy();
  const taxProfile = { included: true as const, country: "ZZ", category: "example", vatRateBps: 0, legalBasis: "example" };
  const port = createDbBackedCommerceQuotePort({
    commercePriceAuthorityPort: authority(), isStrictD1Quote: true, now: () => at,
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ skuId: sku, skuCode: "PRICE-READ-ITEM", variantId: sku,
      productSlug: "price-read-item", netWeightG: 250, isAddon: false, sellability: { oneTime: true, subscription: true }, documentRevision: { id: randomUUID(), digest: "a".repeat(64) } }] },
    taxProfile, supportedTaxProfiles: [taxProfile], regionCode: context.regionCode, currency: context.currency,
    hasPromotionCodePort: false, lineContext: () => ({}),
    quoteContext: request => () => ({ mode: request.mode, promoCodes: request.promoCodes }),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async input => ({ discounts: input.discounts, codeRejections: input.codeRejections, codeRejectionDetails: [] }),
  });
  for (const mode of ["one_time", "subscription"] as const) {
    const result = await port.createServerAuthoritativeQuote({ mode, promoCodes: [], lines: [{ sku: "PRICE-READ-ITEM", quantity: 2 }] });
    expect(result.quote.lines[0]!.unitPriceGross.amountMinor).toBe(mode === "one_time" ? 1499 : 1420);
    expect(result.quote.totalGross.amountMinor).toBe((mode === "one_time" ? 1499 : 1420) * 2);
    expect(result.quote.discounts).toEqual([]);
    if (mode === "subscription") expect(result.quote.lines[0]!.pricingComponents).toContainEqual(expect.objectContaining({ componentType: "mode_discount", amountMinor: -158 }));
  }
  const mixed = await port.createServerAuthoritativeQuote({ mode: "subscription", promoCodes: [], lines: [
    { sku: "PRICE-READ-ITEM", quantity: 1, modeAtLine: "one_time" }, { sku: "PRICE-READ-ITEM", quantity: 1, modeAtLine: "subscription" },
  ] });
  expect(mixed.quote.lines.map(line => line.unitPriceGross.amountMinor)).toEqual([1499, 1420]);
  expect(mixed.quote.totalGross.amountMinor).toBe(2919); expect(mixed.quote.discounts).toEqual([]);
});

it("characterizes all five existing promotion methods without manufacturing device or family evidence", async () => {
  const customer = randomUUID(), other = randomUUID(), subscription = randomUUID(), cycle = randomUUID();
  await admin.query("INSERT INTO public.clients(id,email) VALUES ($1,'read-one@example.invalid'),($2,'read-two@example.invalid')", [customer, other]);
  await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,$3)", [subscription, customer, future]);
  await admin.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES ($1,$2,$3)", [cycle, subscription, future]);
  const definition = (id: string, status = "active") => ({ id, status, name: "Example promotion", code: null,
    trigger_type: "automatic", discount_type: "percentage", discount_value: 7, applies_to_kind: "order_total", applies_to_payload: {},
    stacking_rule: "exclusive", eligibility: {}, region_availability: ["ZZ"], valid_from: future, valid_to: null,
    redemption_limit_global: null, redemption_limit_per_customer: null });
  for (const [id, active, status] of [["read-parent", true, "active"], ["read-mirror", true, "active"], ["read-paused", true, "paused"], ["read-inactive", false, "active"]] as const) {
    const value = { ...definition(id, status), ...(id === "read-mirror" ? { v2_mirror_of: "read-parent" } : {}) };
    await admin.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES ($1,$2,$3)", [id, value, active]);
  }
  for (const [client, state, cycleId, promotion] of [[customer, "paid", null, "read-parent"], [customer, "fulfilled", cycle, "read-mirror"], [other, "paid", null, "read-mirror"], [customer, "pending_payment", null, "read-parent"], [customer, "cancelled", null, "read-parent"]] as const) {
    const order = randomUUID(), db = await admin.connect();
    try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.commerce_orders(id,client_id,status,subscription_cycle_id,currency_code,total_amount_minor) VALUES ($1,$2,$3,$4,'XTS',1000)", [order, client, state, cycleId]);
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES ($1,1,1,1000,1000)", [order]);
    const adjustment = (await db.query(`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
      SELECT $1,'promotion_discount','order_total',100,promotion_id,definition_fingerprint FROM public.commerce_promotion_definitions WHERE promotion_id=$2 RETURNING id`, [order, promotion])).rows[0].id;
    const redeemed = state === "paid" || state === "fulfilled", released = state === "cancelled";
    await db.query(`INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,status,amount_off_minor,reserved_at,expires_at,redeemed_at,released_at,release_reason)
      SELECT promotion_id,definition_fingerprint,$1,$2,$3,$4,100,$5,$6,$7,$8,$9 FROM public.commerce_promotion_definitions WHERE promotion_id=$10`,
    [adjustment, order, client, redeemed ? "redeemed" : released ? "released" : "reserved", start, future, redeemed ? at : null, released ? at : null, released ? "example" : null, promotion]);
    await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  const snapshot = async () => (await admin.query("SELECT (SELECT jsonb_agg(to_jsonb(d) ORDER BY promotion_id) FROM public.commerce_promotion_definitions d) AS definitions,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.commerce_promotion_claims c) AS claims")).rows;
  const before = await snapshot();
  const port = createPostgresCommercePromoDataPort(runtime);
  expect((await port.listActivePromotions()).map(row => row.id)).toEqual(["read-mirror", "read-parent"]);
  expect(await port.countPaidOrders(customer)).toBe(2);
  expect(await port.countPaidOrdersByMode(customer)).toEqual({ oneTime: 1, subscription: 1 });
  expect(await port.redemptionCounts(customer)).toEqual(new Map([["read-mirror", { global: 2, perCustomer: 1 }], ["read-parent", { global: 1, perCustomer: 1 }]]));
  expect([...(await port.redemptionCounts(null)).values()].every(count => count.perCustomer === 0)).toBe(true);
  expect(await port.deviceFirstOrderRedeemed("example-visitor")).toBe(false);
  expect(await port.deviceFirstOrderRedeemed(null)).toBe(false);
  expect(await port.deviceFirstOrderRedeemed("  ")).toBe(false);
  expect(await snapshot()).toEqual(before);
});

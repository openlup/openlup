import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createManagedStockAvailability } from "@openlup/platform/inventory";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const forward = "scripts/fixtures/reviewed-m11/supabase/migrations/20261025109000_inventory_new_purchase_stock_read.sql";
let container: PostgresContainer | undefined;
let pool: Pool, db: PoolClient;
let provider: string, location: string, asOf: string;
const calls: { name: string; args: Record<string, unknown> }[] = [];
const reader = createManagedStockAvailability({ async rpc(name, args) {
  calls.push({ name, args });
  expect(name).toBe("inventory_new_purchase_stock_read");
  return { data: (await db.query("SELECT public.inventory_new_purchase_stock_read($1::jsonb,$2::timestamptz) AS response", [JSON.stringify(args.p_skus), args.p_as_of])).rows[0].response, error: null };
} }, { now: () => asOf });

beforeAll(async () => {
  const pin = readCiImage("managed-batch-postgres");
  container = await runPostgresContainer({ name: `f3-managed-${process.pid}`, password: "synthetic-conformance", image: imageReference(pin, pin.sources.at(-1)) });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
  db = await pool.connect();
  await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
  for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
  }
  await db.query("SET ROLE postgres");
  for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
    await db.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
  }
  await db.query(readFileSync(forward, "utf8"));
  const definition = async (signature: string) => (await db.query("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body as string;
  provider = /stock\.provider_kind='([^']+)'/u.exec(await definition("public.inventory_available_to_promise(uuid,timestamptz,boolean)"))![1];
  location = /WHERE code = '([^']+)'/u.exec(await definition("public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)"))![1];
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
beforeEach(async () => {
  await db.query("BEGIN");
  asOf = (await db.query("SELECT now()::text AS at")).rows[0].at;
  calls.length = 0;
  await db.query(`INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
    VALUES($1,'fulfillment','Synthetic stock','active',ARRAY['ZZ']) ON CONFLICT(kind) DO UPDATE SET enabled_for_region=EXCLUDED.enabled_for_region`, [provider]);
  await db.query(`INSERT INTO public.inventory_locations(code,display_name,kind,status,region,fulfillable,provider_kind)
    VALUES($1,'Synthetic stock','third_party_logistics','active','ZZ',true,$2) ON CONFLICT(code) DO NOTHING`, [location, provider]);
});
afterEach(async () => { await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres"); });

async function fixture(stock = 20) {
  const id = randomUUID(), product = randomUUID(), client = randomUUID(), sku = `F3-${id}`;
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Synthetic stock','active')", [product, product]);
  await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
    VALUES($1,$2,$3,'Synthetic stock','other','active',1,1)`, [id, product, sku]);
  await db.query("SELECT public.fulfillment_provider_upsert_stock_current($1,$2,$3,$4,$4,0,now(),now()+interval '1 hour','f3-run','{}')", [`f3-stock-${id}`, provider, sku, stock]);
  return { id, sku, client };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function subscription(f: Fixture, quantity: number, days = 7) {
  const id = randomUUID(), cycle = randomUUID();
  await db.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,next_cycle_at)
    VALUES($1,$2,28,'XTS','active',now()+$3::integer*interval '1 day')`, [id, f.client, days]);
  await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,qty,sort_order,is_addon,template_version) VALUES($1,$2,$3,0,false,1)", [id, f.id, quantity]);
  await db.query(`INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key)
    VALUES($1::uuid,$2,2,now()+$3::integer*interval '1 day','planned',$1::text)`, [cycle, id, days]);
  return { id, cycle };
}
async function order(f: Fixture, sub?: Awaited<ReturnType<typeof subscription>>) {
  const id = randomUUID();
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,mode,subscription_id,subscription_cycle_id,currency,total_cents,subtotal_cents,region_code)
    VALUES($1,$2,'draft',$3,$4,$5,'XTS',100,100,'ZZ')`, [id, f.client, sub ? "subscription_cycle" : "one_time", sub?.id ?? null, sub?.cycle ?? null]);
  return id;
}
async function reserve(f: Fixture, orderId: string, cycle: string | null, quantity: number, kind = "checkout_payment_window", expires: string | null = null) {
  return (await db.query(`SELECT public.inventory_reserve_order($1,$2,NULL,$3,$4,$5,$6,'created',$7,'{}',$8) AS response`,
    [randomUUID(), orderId, cycle, f.id, quantity, kind, expires, provider])).rows[0].response;
}
async function atp(f: Fixture, renewal = false) {
  return (await db.query("SELECT * FROM public.inventory_available_to_promise($1,$2,$3)", [f.id, asOf, renewal])).rows[0];
}
async function preview(f: Fixture) {
  const row = (await reader.read({ skus: [f.sku], horizonDays: 14, excludeOrderId: null })).get(f.sku)!;
  const promise = await atp(f);
  expect(row.available).toBe(Number(promise.available_quantity));
  expect(row.availableForNewPurchases).toBe(row.available);
  expect(row.providerForSale).toBe(Number(promise.for_sale_quantity));
  expect(row.activeHolds).toBe(Number(promise.hard_hold_quantity));
  expect(row.safetyStock).toBe(Number(promise.safety_quantity));
  expect(row.renewalDemand).toBe(Number(promise.soft_subscription_demand_quantity));
  return row;
}
async function refuses(action: () => Promise<unknown>, message = "inventory_external_provider_insufficient_available_stock", code = "23514") {
  await db.query("SAVEPOINT refusal");
  try { await expect(action()).rejects.toMatchObject({ message, code }); }
  finally { await db.query("ROLLBACK TO SAVEPOINT refusal; RELEASE SAVEPOINT refusal"); }
}

it("one-time preview is stock minus holds and the checkout allocator uses the same budget", async () => {
  const f = await fixture();
  const checkout = await order(f);
  const payment = randomUUID();
  await db.query("INSERT INTO public.commerce_payments(id,order_id,provider,provider_payment_id,status,amount_cents,currency) VALUES($1::uuid,$2,'test',$1::text,'pending',100,'XTS')", [payment, checkout]);
  await db.query("INSERT INTO public.commerce_payment_intents(target_kind,order_id,payment_id,status,amount_cents,currency) VALUES('one_time_order',$1,$2,'created',100,'XTS')", [checkout, payment]);
  await reserve(f, checkout, null, 3, "checkout_payment_window", (await db.query("SELECT (now()+interval '24 hours')::text AS at")).rows[0].at);
  expect(await preview(f)).toMatchObject({ source: "provider", providerForSale: 20, activeHolds: 3, renewalDemand: 0, available: 17, stale: false });
  const [row] = (await db.query("SELECT mode,subscription_id,subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [checkout])).rows;
  expect(row).toEqual({ mode: "one_time", subscription_id: null, subscription_cycle_id: null });
  expect((await db.query("SELECT target_kind,subscription_id,subscription_cycle_id FROM public.commerce_payment_intents WHERE order_id=$1", [checkout])).rows).toEqual([
    { target_kind: "one_time_order", subscription_id: null, subscription_cycle_id: null },
  ]);
  const [hold] = (await db.query("SELECT kind,status,subscription_cycle_id,extract(epoch FROM expires_at-now()) AS lease FROM public.inventory_reservations WHERE order_id=$1", [checkout])).rows;
  expect(hold).toMatchObject({ kind: "checkout_payment_window", status: "reserved", subscription_cycle_id: null });
  expect(Number(hold.lease)).toBeGreaterThanOrEqual(86400);
  expect(calls).toHaveLength(1);
  expect((await db.query("SELECT count(*)::integer AS n FROM public.inventory_reservations WHERE order_id=$1", [checkout])).rows[0].n).toBe(1);
  await refuses(() => reserve(f, checkout, null, 18));
  await reserve(f, checkout, null, 17);
  expect((await preview(f)).available).toBe(0);
});

it("refuses a NULL as-of timestamp and preserves the protected budget for a non-null timestamp", async () => {
  const f = await fixture(), own = await subscription(f, 6);
  await subscription(f, 3, 14);
  await reserve(f, await order(f, own), own.cycle, 2, "subscription_retry_window");
  const checkout = await order(f);
  await reserve(f, checkout, null, 3);
  const before = await preview(f);
  expect(before).toMatchObject({ providerForSale: 20, activeHolds: 5, renewalDemand: 7, available: 8, availableForNewPurchases: 8, stale: false });
  await refuses(() => db.query("SELECT public.inventory_new_purchase_stock_read($1::jsonb,NULL::timestamptz) AS response", [JSON.stringify([f.sku])])
    .then(result => result.rows[0].response), "inventory_stock_as_of_invalid", "22023");
  expect(await preview(f)).toEqual(before);
  await refuses(() => reserve(f, checkout, null, 9));
  await reserve(f, checkout, null, 8);
  expect((await preview(f)).available).toBe(0);
});

it("protects uncredited 14-day demand and provider-tagged 72-hour holds without changing M10 filtering", async () => {
  const f = await fixture();
  const own = await subscription(f, 6), other = await subscription(f, 3, 14);
  const ownOrder = await order(f, own), another = await order(f);
  const receipt = await reserve(f, ownOrder, own.cycle, 2, "subscription_retry_window");
  await reserve(f, another, null, 3);
  expect(Number((await db.query("SELECT extract(epoch FROM expires_at-now()) AS seconds FROM public.inventory_reservations WHERE id=$1", [receipt.reservationId])).rows[0].seconds)).toBe(72 * 3600);
  expect(await preview(f)).toMatchObject({ activeHolds: 5, renewalDemand: 7, available: 8 });
  expect(Number((await atp(f, true)).available_quantity)).toBe(15);
  await refuses(() => reserve(f, another, null, 9));
  // An untagged fixture hold remains outside the landed managed ATP filter.
  await db.query(`INSERT INTO public.inventory_reservations(idempotency_key,order_id,sku_id,location_id,quantity,kind,expires_at,metadata)
    SELECT $1,$2,$3,id,3,'manual_ops',NULL,'{}' FROM public.inventory_locations WHERE code=$4`, [randomUUID(), another, f.id, location]);
  expect(await preview(f)).toMatchObject({ activeHolds: 5, renewalDemand: 7, available: 8 });
  await db.query("UPDATE public.inventory_balances SET safety_stock=1 WHERE sku_id=$1", [f.id]);
  expect(await preview(f)).toMatchObject({ safetyStock: 1, available: 7 });
  await db.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [other.id]);
  expect((await preview(f)).available).toBe(10);
  asOf = (await db.query("SELECT expires_at::text AS at FROM public.inventory_reservations WHERE id=$1", [receipt.reservationId])).rows[0].at;
  expect(await preview(f)).toMatchObject({ activeHolds: 0, renewalDemand: 6, available: 13, stale: true });
});

async function replacementOrder(f: Fixture, sub?: Awaited<ReturnType<typeof subscription>>) {
  const id = await order(f, sub), address = randomUUID(), actor = randomUUID(), payment = randomUUID(), item = randomUUID();
  await db.query("INSERT INTO public.admin_users(id,email,role) VALUES($1,$2,'admin')", [actor, `${actor}@example.invalid`]);
  await db.query("INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country) VALUES($1,$2,'shipping','Example 1','Example','00000','ZZ')", [address, f.client]);
  await db.query("UPDATE public.commerce_orders SET status='fulfilled',shipping_address_id=$2 WHERE id=$1", [id, address]);
  if (sub) await db.query("UPDATE public.subscription_cycles SET status='paid',order_id=$2 WHERE id=$1", [sub.cycle, id]);
  await db.query(`INSERT INTO public.commerce_order_items(id,order_id,sku_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,allocation_ordinal,vat_rate_bps)
    VALUES($1,$2,$3,1,100,100,0,100,100,1,0)`, [item, id, f.id]);
  // The landed cycle-item trigger reserves the original parcel. Retire that
  // original through the landed consume command before testing its replacement.
  if (sub) await db.query(`SELECT public.inventory_consume_reservation_for_fulfillment(
    'original-consumed:'||id::text,id,'{}') FROM public.inventory_reservations WHERE order_id=$1 AND status='reserved'`, [id]);
  await db.query("INSERT INTO public.commerce_payments(id,order_id,provider,provider_payment_id,status,amount_cents,currency) VALUES($1::uuid,$2,'test',$1::text,'succeeded',100,'XTS')", [payment, id]);
  await db.query(`INSERT INTO public.commerce_payment_intents(target_kind,order_id,payment_id,status,amount_cents,currency,subscription_id,subscription_cycle_id)
    VALUES($1,$2,$3,'succeeded',100,'XTS',$4,$5)`, [sub ? "subscription_cycle" : "one_time_order", id, payment, sub?.id ?? null, sub?.cycle ?? null]);
  const contact = { schemaVersion: 1, revision: 1, source: "synthetic", recipientName: "Example", contactPhone: "+10000000000", line1: "Example 1", city: "Example", postalCode: "00000", country: "ZZ", selectedDelivery: { providerKind: provider, serviceCode: "TEST", kind: "courier" } };
  await db.query(`INSERT INTO public.commerce_fulfillment_orders(order_id,client_id,shipping_address_id,create_idempotency_key,status,provider_kind,shipping_address_snapshot)
    VALUES($1,$2,$3,$4,'delivered',$5,$6)`, [id, f.client, address, randomUUID(), provider, { deliveryContact: contact }]);
  return { id, actor, item };
}
async function replace(o: Awaited<ReturnType<typeof replacementOrder>>) {
  return (await db.query("SELECT public.commerce_oms_request_replacement_shipment($1,$2,'damaged',$3,'{}') AS response", [randomUUID(), o.id, o.actor])).rows[0].response;
}

it("actual matching-cycle replacement cannot consume another subscription's live reservation", async () => {
  const f = await fixture(3), own = await subscription(f, 1);
  const replacement = await replacementOrder(f, own), protectedSub = await subscription(f, 3);
  const held = await reserve(f, await order(f, protectedSub), protectedSub.cycle, 3, "subscription_retry_window");
  expect(await preview(f)).toMatchObject({ activeHolds: 3, available: 0 });
  expect(Number((await atp(f, true)).available_quantity)).toBe(0);
  await refuses(() => replace(replacement));
  expect((await db.query("SELECT quantity,status FROM public.inventory_reservations WHERE id=$1", [held.reservationId])).rows[0]).toEqual({ quantity: 3, status: "reserved" });
  expect((await db.query("SELECT count(*)::integer AS n FROM public.inventory_reservations WHERE order_id=$1 AND status='reserved'", [replacement.id])).rows[0].n).toBe(0);
  await db.query("UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=4,provider_total_quantity=4 WHERE catalog_sku_id=$1", [f.id]);
  expect((await preview(f)).available).toBe(0);
  expect(Number((await atp(f, true)).available_quantity)).toBe(1);
  expect((await replace(replacement)).replacement.sequenceNo).toBe(1);
  const rows = (await db.query("SELECT subscription_cycle_id,quantity,status,expires_at FROM public.inventory_reservations WHERE order_id=$1 AND status='reserved'", [replacement.id])).rows;
  expect(rows).toEqual([{ subscription_cycle_id: own.cycle, quantity: 1, status: "reserved", expires_at: null }]);
});

it("one-time replacement and mismatched cycle get no soft-demand exemption; matching replacement retains M10 priority", async () => {
  const f = await fixture(3), own = await subscription(f, 1);
  const oneTime = await replacementOrder(f), matching = await replacementOrder(f, own);
  const protectedSub = await subscription(f, 3);
  expect((await preview(f)).available).toBe(0);
  expect(Number((await atp(f, true)).available_quantity)).toBe(3);
  await refuses(() => replace(oneTime));
  await refuses(() => reserve(f, matching.id, protectedSub.cycle, 1, "manual_ops"));
  expect((await db.query("SELECT count(*)::integer AS n FROM public.inventory_reservations WHERE sku_id=$1 AND status='reserved'", [f.id])).rows[0].n).toBe(0);
  // The landed true exemption removes ALL soft demand, including the other
  // subscription's unreserved demand. This is existing M10 renewal policy.
  expect((await replace(matching)).replacement.sequenceNo).toBe(1);
  expect((await preview(f)).available).toBe(0);
});

it("subtracts the channel exposure hook and rolls its replacement back", async () => {
  const f = await fixture();
  await subscription(f, 6);
  const baseline = await preview(f);
  await db.query("CREATE OR REPLACE FUNCTION public.inventory_channel_exposure_quantity(p_sku_id uuid) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT 4::bigint; $$");
  expect((await preview(f)).available).toBe(baseline.available! - 4);
  expect(Number((await atp(f)).channel_exposure_quantity)).toBe(4);
});

it("reports conservative stale for either provider while preserving ATP quantities; missing source has bounded zeros", async () => {
  const f = await fixture();
  const initial = await atp(f);
  const other = `synthetic-${randomUUID()}`;
  await db.query("INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region) VALUES($1,'fulfillment','Synthetic second source','active',ARRAY['ZZ'])", [other]);
  await db.query(`INSERT INTO public.fulfillment_provider_stock_current(provider_kind,sku,catalog_sku_id,provider_total_quantity,provider_for_sale_quantity,provider_reserved_unavailable_quantity,last_synced_at,stale_after,sync_run_id)
    VALUES($1,$2,$3,20,20,0,now()-interval '2 hours',now()-interval '1 hour','f3-second')`, [other, f.sku, f.id]);
  expect(await preview(f)).toMatchObject({ stale: true, source: "provider", providerForSale: 20, available: 20 });
  expect(await atp(f)).toEqual(initial);
  await db.query("UPDATE public.fulfillment_provider_stock_current SET stale_after=now()+interval '1 hour' WHERE catalog_sku_id=$1", [f.id]);
  expect((await preview(f)).stale).toBe(false);
  await db.query("UPDATE public.fulfillment_provider_stock_current SET stale_after=$3::timestamptz WHERE catalog_sku_id=$1 AND provider_kind=$2", [f.id, provider, asOf]);
  expect(await preview(f)).toMatchObject({ stale: true, available: 20 });
  expect(await atp(f)).toEqual(initial);
  const staleOrder = await order(f);
  await refuses(() => reserve(f, staleOrder, null, 1), "inventory_external_provider_stock_stale");
  await db.query("DELETE FROM public.fulfillment_provider_stock_current WHERE catalog_sku_id=$1", [f.id]);
  const missing = (await reader.read({ skus: [f.sku, "UNKNOWN"], horizonDays: 14, excludeOrderId: null }));
  expect(missing.get(f.sku)).toMatchObject({ catalogSkuId: f.id, source: "missing", providerForSale: null, available: 0, stale: false });
  expect(missing.get("UNKNOWN")).toMatchObject({ catalogSkuId: null, source: "missing", available: 0 });
});

it("bounds raw JSON array items before deduplication and preserves read-only service ACL/shape", async () => {
  for (const input of [null, {}, "SKU"]) await refuses(() => db.query("SELECT public.inventory_new_purchase_stock_read($1::jsonb,now())", [JSON.stringify(input)]), "inventory_stock_skus_invalid", "22023");
  await refuses(() => db.query("SELECT public.inventory_new_purchase_stock_read($1::jsonb,now())", [JSON.stringify(Array(201).fill("SKU"))]), "inventory_stock_skus_limit_exceeded", "22023");
  expect((await db.query("SELECT public.inventory_new_purchase_stock_read($1::jsonb,now()) AS response", [JSON.stringify(Array(200).fill("SKU"))])).rows[0].response).toHaveLength(1);
  const signature = "public.inventory_new_purchase_stock_read(jsonb,timestamptz)";
  const fn = (await db.query("SELECT p.provolatile,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.oid=$1::regprocedure", [signature])).rows[0];
  expect(fn).toMatchObject({ provolatile: "s", prosecdef: false, proconfig: ["search_path=pg_catalog"] });
  expect(fn.body).toContain("inventory_available_to_promise(sku.id,p_as_of,false)");
  expect(fn.body).not.toMatch(/p_for_subscription_renewal|\b(?:INSERT|UPDATE|DELETE)\b/iu);
  expect(fn.body).not.toContain(provider);
  for (const role of ["anon", "authenticated", "openlup_mcp_reader"]) {
    await db.query(`SET LOCAL ROLE ${role}`);
    await refuses(() => db.query("SELECT public.inventory_new_purchase_stock_read('[]',now())"), "permission denied for function inventory_new_purchase_stock_read", "42501");
    await db.query("RESET ROLE; SET LOCAL ROLE postgres");
  }
  // These base-table grants are test scaffolding for the fixed-priority reader
  // fixture as pinned: an invoker function composed over an invoker ATP that
  // service_role cannot read without them.
  // This test proves body semantics (arithmetic, stale/missing/NULL/options
  // behaviour, allocator agreement) and the deny-by-default refusal of
  // non-granted roles. It does NOT prove privilege correctness of the granted role.
  // Privilege proof as the granted role with real ATP data belongs to the control
  // change that owns the reader fixture and to the managed rail landing.
  await db.query("GRANT SELECT ON public.subscriptions, public.subscription_lines, public.subscription_cycles, public.inventory_reservations, public.inventory_balances, public.inventory_locations, public.catalog_skus, public.fulfillment_provider_stock_current TO service_role");
  await db.query("SET LOCAL ROLE service_role");
  expect((await db.query("SELECT public.inventory_new_purchase_stock_read('[]',now()) AS response")).rows[0].response).toEqual([]);
  const f = await db.query("SELECT public.inventory_new_purchase_stock_read('[\"UNKNOWN\"]',now()) AS response");
  expect(f.rows[0].response[0].source).toBe("missing");
});

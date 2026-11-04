/** Selected public donor fit; explicit files only, no managed-chain parity claim. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const donorFiles = [
  "supabase/migrations/00000000000000_platform_schema_baseline.sql",
  "supabase/migrations/20261024175000_inventory_available_to_promise.sql",
  "supabase/migrations/20261024184000_inventory_reserve_order_uses_seam.sql",
];
let container: PostgresContainer | undefined, admin: Pool, runtime: Pool, provider: string, location: string;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `g4-donor-${process.pid}`, password: "synthetic-conformance" });
  admin = new Pool({ connectionString: container.connectionString });
  const db = await admin.connect();
  try {
    await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
    for (const file of donorFiles) await db.query(readFileSync(file, "utf8").replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
  } finally { db.release(); }
  // Provider tokens are read from the actual donor; no deployment-specific fixture literal.
  const source = readFileSync(donorFiles[2], "utf8");
  provider = /IF p_provider_kind = '([^']+)'/u.exec(source)![1];
  location = /WHERE code = '([^']+)'/u.exec(source)![1];
  await admin.query(`INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
    VALUES($1,'fulfillment','Synthetic','active',ARRAY['ZZ']) ON CONFLICT(kind) DO NOTHING`, [provider]);
  await admin.query(`INSERT INTO public.inventory_locations(code,display_name,kind,status,region,fulfillable,provider_kind)
    VALUES($1,'Synthetic','third_party_logistics','active','ZZ',true,$2) ON CONFLICT(code) DO NOTHING`, [location, provider]);
  await admin.query("CREATE ROLE g4_donor_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'");
  await admin.query("GRANT service_role TO g4_donor_runtime");
  const url = new URL(container.connectionString); url.username = "g4_donor_runtime";
  runtime = new Pool({ connectionString: url.toString(), options: "-c role=service_role" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [admin, runtime]); }, postgresTeardownTimeoutMs);

async function fixture(available = 5, quantities = [2]) {
  const skuId = randomUUID(), client = randomUUID(), order = randomUUID();
  const sku = `SYN-${skuId}`;
  await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await admin.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Synthetic','active')", [skuId, sku]);
  await admin.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
    VALUES($1,$1,$2,'Synthetic','other','active',1,1)`, [skuId, sku]);
  await admin.query("SELECT public.fulfillment_provider_upsert_stock_current($1,$2,$3,$4,$4,0,now(),now()+interval '1 hour','g4','{}')", [randomUUID(), provider, sku, available]);
  await admin.query(`INSERT INTO public.commerce_orders(id,client_id,status,mode,currency,total_cents,subtotal_cents,region_code)
    VALUES($1,$2,'draft','one_time','XTS',0,0,'ZZ')`, [order, client]);
  const items: { orderItemId: string; skuId: string; quantity: number }[] = [];
  for (const [i, quantity] of quantities.entries()) {
    const id = randomUUID();
    await admin.query(`INSERT INTO public.commerce_order_items(id,order_id,sku_id,quantity,unit_price_cents,total_cents,
      discount_allocated_cents,effective_total_cents,effective_net_cents,allocation_ordinal)
      VALUES($1,$2,$3,$4,0,0,0,0,0,$5)`, [id, order, skuId, quantity, i + 1]);
    items.push({ orderItemId: id, skuId, quantity });
  }
  return { skuId, sku, order, items };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function reserve(f: Fixture, key = randomUUID(), expiry: string | null = null, items = f.items, payment = "created") {
  return (await runtime.query(`SELECT public.inventory_reserve_order_items($1,$2,NULL,$3::jsonb,
    'checkout_payment_window',$4,$5,'{"source":"synthetic"}'::jsonb,$6) result`,
  [key, f.order, JSON.stringify(items), payment, expiry, provider])).rows[0].result;
}
async function budget(f: Fixture) {
  return (await admin.query("SELECT hard_hold_quantity,available_quantity FROM public.inventory_available_to_promise($1,now(),false)", [f.skuId])).rows[0];
}
async function release(id: string, key = randomUUID()) {
  return (await runtime.query("SELECT public.inventory_release_reservation($1,$2,'cancelled','{}') result", [key, id])).rows[0].result;
}
it("pins batch fields, metadata, effect order, replay differences and persisted terminal state", async () => {
  const f = await fixture(), key = randomUUID(), first = await reserve(f, key);
  expect(first).toMatchObject({ contractVersion: "inventory.v0", status: "reserved", replayed: false,
    reservations: [{ orderItemId: f.items[0].orderItemId, status: "reserved", replayed: false }] });
  const id = first.reservations[0].reservationId;
  const persisted = async () => (await admin.query(`SELECT r.order_id,r.order_item_id,r.quantity,r.status,r.metadata,
    b.reserved,(SELECT count(*)::int FROM public.inventory_stock_movements m WHERE m.reservation_id=r.id) movements
    FROM public.inventory_reservations r JOIN public.inventory_balances b ON b.sku_id=r.sku_id AND b.location_id=r.location_id
    WHERE r.id=$1`, [id])).rows[0];
  expect(await persisted()).toMatchObject({ order_id: f.order, order_item_id: f.items[0].orderItemId, quantity: 2,
    status: "reserved", reserved: 2, movements: 1, metadata: { source: "synthetic", providerKind: provider } });
  // Trigger faults after a reservation insert but before its counter/movement must roll the whole call back.
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE FUNCTION pg_temp.g4_movement_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'g4_after_reservation_before_receipt'; END $$`);
    await db.query("CREATE TRIGGER g4_movement_fault BEFORE INSERT ON public.inventory_stock_movements FOR EACH ROW EXECUTE FUNCTION pg_temp.g4_movement_fault()");
    await db.query("SAVEPOINT fault");
    await expect(db.query(`SELECT public.inventory_reserve_order($1,$2,$3,NULL,$4,1,'checkout_payment_window','created',NULL,'{}',$5)`,
      [randomUUID(), f.order, f.items[0].orderItemId, f.skuId, provider])).rejects.toThrow("g4_after_reservation_before_receipt");
    await db.query("ROLLBACK TO SAVEPOINT fault");
    expect((await db.query("SELECT sum(quantity)::int quantity FROM public.inventory_reservations WHERE order_id=$1", [f.order])).rows[0].quantity).toBe(2);
  } finally { await db.query("ROLLBACK"); db.release(); }
  // Donor replays a changed quantity; native intentionally refuses it.
  expect(await reserve(f, key, null, [{ ...f.items[0], quantity: 3 }])).toMatchObject({ reservations: [{ reservationId: id, replayed: true }] });
  expect(await budget(f)).toEqual({ hard_hold_quantity: "2", available_quantity: "3" });
  expect(await release(id)).toMatchObject({ status: "released", replayed: false });
  expect(await release(id)).toMatchObject({ status: "released", replayed: true });
  expect(await persisted()).toMatchObject({ status: "released", reserved: 0, movements: 2 });
  expect(await reserve(f, key)).toMatchObject({ reservations: [{ reservationId: id, status: "released", replayed: true }] });
});
it("rolls back a late batch shortage, rejects payment/item shapes, and characterizes elapsed expiry", async () => {
  const f = await fixture(3, [2, 2]);
  await expect(reserve(f)).rejects.toThrow("inventory_external_provider_insufficient_available_stock");
  expect((await admin.query("SELECT * FROM public.inventory_reservations WHERE order_id=$1", [f.order])).rows).toEqual([]);
  expect(await budget(f)).toEqual({ hard_hold_quantity: "0", available_quantity: "3" });
  await expect(reserve(f, randomUUID(), null, [], "failed")).rejects.toThrow("inventory_reservation_items_invalid");
  await expect(reserve(f, randomUUID(), null, [f.items[0]], "failed")).rejects.toThrow("inventory_reservation_payment_status_not_reservable");
  const elapsed = new Date(Date.now() - 60_000).toISOString();
  const held = await reserve(f, randomUUID(), elapsed, [f.items[0]]);
  expect(held.reservations[0].status).toBe("reserved");
  expect(await budget(f)).toEqual({ hard_hold_quantity: "0", available_quantity: "3" });
  const id = held.reservations[0].reservationId;
  expect((await runtime.query("SELECT public.inventory_expire_reservations(100) result")).rows[0].result.expiredCount).toBeGreaterThanOrEqual(1);
  expect(await release(id)).toMatchObject({ status: "expired", replayed: true });
  expect((await admin.query("SELECT reserved FROM public.inventory_balances WHERE sku_id=$1", [f.skuId])).rows[0].reserved).toBe(0);
});
it("serializes competing holds and racing release/expiry with exactly one stock restoration", async () => {
  const f = await fixture(2), attempts = await Promise.allSettled([reserve(f), reserve(f)]);
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(await budget(f)).toEqual({ hard_hold_quantity: "2", available_quantity: "0" });
  const winner = attempts.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>;
  const id = winner.value.reservations[0].reservationId;
  // Both commands are eligible without any timing sleep; managed expiry is server-clock based.
  await admin.query("UPDATE public.inventory_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
  await Promise.all([release(id), runtime.query("SELECT public.inventory_expire_reservations(100)")]);
  expect((await admin.query("SELECT reserved FROM public.inventory_balances WHERE sku_id=$1", [f.skuId])).rows[0].reserved).toBe(0);
  expect(await budget(f)).toEqual({ hard_hold_quantity: "0", available_quantity: "2" });
  expect(await release(id)).toMatchObject({ replayed: true });
});

it("shares one per-item effect across equivalent UUID spellings within a batch", async () => {
  for (const spelling of ["uppercase", "braced", "hyphenless"] as const) {
    const f = await fixture(), canonical = "a" + f.items[0].orderItemId.slice(1);
    await admin.query("UPDATE public.commerce_order_items SET id=$2 WHERE id=$1", [f.items[0].orderItemId, canonical]);
    const item = { ...f.items[0], orderItemId: canonical };
    const alias = spelling === "uppercase" ? canonical.toUpperCase()
      : spelling === "braced" ? `{${canonical}}` : canonical.replaceAll("-", "");
    const key = randomUUID(), items = [item, { ...item, orderItemId: alias }];
    const first = await reserve(f, key, null, items), id = first.reservations[0].reservationId;
    expect(first.reservations).toMatchObject([{ reservationId: id, replayed: false }, { reservationId: id, replayed: true }]);
    expect((await admin.query(`SELECT count(*)::int holds,sum(quantity)::int quantity,
      (SELECT count(*)::int FROM public.inventory_stock_movements WHERE reservation_id=$2) movements
      FROM public.inventory_reservations WHERE order_id=$1`, [f.order, id])).rows)
      .toEqual([{ holds: 1, quantity: 2, movements: 1 }]);
    expect(await budget(f)).toEqual({ hard_hold_quantity: "2", available_quantity: "3" });
    expect(await reserve(f, key, null, items)).toMatchObject({ reservations: [
      { reservationId: id, replayed: true }, { reservationId: id, replayed: true },
    ] });
    expect((await admin.query("SELECT count(*)::int movements FROM public.inventory_stock_movements WHERE reservation_id=$1", [id])).rows)
      .toEqual([{ movements: 1 }]);
  }
});

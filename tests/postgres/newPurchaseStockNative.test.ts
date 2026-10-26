/** F3 native preview conformance. No one-time/replacement allocator is available. */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createInventoryBindings, createNewPurchaseStockAvailabilityPort, createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const EPOCH = Date.UTC(2030, 0, 1, 12), HOUR = 3_600_000, DAY = 24 * HOUR;
const at = (offset = 0) => new Date(EPOCH + offset).toISOString();
let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Native preview proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `new-purchase-stock-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native preview PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool }).apply();
}, postgresSetupTimeoutMs);
beforeEach(async () => { db = await pool.connect(); await db.query("BEGIN"); });
afterEach(async () => { if (db) { await db.query("ROLLBACK"); db.release(); } });
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

async function stock(quantity = 20) {
  const skuId = randomUUID(), source = randomUUID(), sku = `SKU-${skuId}`;
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,$2,'Example')", [skuId, sku]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ($1,$1,$2,'Example')", [skuId, sku]);
  await db.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES ($1,$2,$3,$3,0,'sellable',$4,$5,'example',$1,$6)`, [source, sku, quantity, at(-HOUR), at(30 * DAY), "a".repeat(64)]);
  return { skuId, source, sku };
}
type Stock = Awaited<ReturnType<typeof stock>>;
async function subscription(f: Stock, quantity: number, due: string | null = at(), status = "active") {
  const client = randomUUID(), id = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES ($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status) VALUES ($1,$2,28,$3,$4)", [id, client, due, status]);
  await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES ($1,'XXX',$2,'example',$3,'example')", [id, f.source, at()]);
  await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES ($1,1,$2,$3,100)", [id, f.sku, quantity]);
  return id;
}
async function hold(f: Stock, id: string, quantity: number) {
  const snapshot = { contractVersion: "platform.subscription.renewal.v1", subscriptionId: id, scheduledAt: at(), cycleNumber: 2,
    currency: "XXX", stockSourceKey: f.source, totalAmountMinor: quantity * 100, lines: [{ sku: f.sku, quantity }] };
  const identity = (await db.query("SELECT public.subscription_renewal_identity($1,$2) AS key", [id, at()])).rows[0].key;
  const op = (await db.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'example',300,$4) AS response", [identity, "b".repeat(64), snapshot, at()])).rows[0].response;
  const result = await createPostgresRenewalReservationPort(db).reserve({ operationId: op.operationId, claimToken: op.claimToken, now: at(), holdSeconds: 86400 });
  expect(result).toMatchObject({ reserved: true, status: "held", replayed: false });
  return { ...result, operationId: op.operationId };
}
function binding(f: Stock, asOf = at()) {
  return createInventoryBindings({ dataKind: "postgres", provider: { stockMasterProvider: "example", providerSchema: z.literal("example") },
    executor: db, stockSourceKey: f.source, now: () => asOf });
}
async function preview(f: Stock, asOf = at()) {
  const selected = binding(f, asOf);
  expect(selected.readiness).toEqual({ ready: true, reason: null });
  expect(selected.unsupported.newPurchaseStockRead).toBeNull();
  return (await selected.newPurchaseStockReadPort!.read({ skus: [f.sku], horizonDays: 14, excludeOrderId: null })).get(f.sku)!;
}
async function atp(f: Stock, renewal = false, asOf = at()) {
  return (await db.query("SELECT public.inventory_available_to_promise($1,$2,$3,$4) AS response", [f.source, f.sku, asOf, renewal])).rows[0].response;
}
async function budget(f: Stock, available: number, holds: number, demand: number, exposure = 0, asOf = at()) {
  const row = await preview(f, asOf);
  expect(row).toMatchObject({ activeHolds: holds, safetyStock: 0, renewalDemand: demand, available, availableForNewPurchases: available, excludedOrderHolds: 0 });
  expect(await atp(f, false, asOf)).toMatchObject({ available_quantity: available, hard_hold_quantity: holds,
    soft_subscription_demand_quantity: demand, channel_exposure_quantity: exposure, safety_quantity: 0 });
  return row;
}

it("W2 counts all live holds without provider tags and ignores expired/released/consumed holds", async () => {
  const f = await stock();
  const unrelated = await stock(200);
  await subscription(unrelated, 99);
  await budget(f, 20, 0, 0);
  const first = await subscription(f, 2), second = await subscription(f, 3), ended = await subscription(f, 4);
  const a = await hold(f, first, 2), b = await hold(f, second, 3), c = await hold(f, ended, 4);
  await db.query("UPDATE public.subscriptions SET status='paused'");
  await db.query("UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL WHERE id=$1", [b.reservationId]);
  // A held reservation expiring exactly at the read instant is no longer live.
  await db.query("UPDATE public.fulfillment_inventory_reservations SET created_at=$2,expires_at=$3 WHERE id=$1", [c.reservationId, at(-HOUR), at()]);
  await budget(f, 15, 5, 0);
  for (const status of ["expired", "released", "consumed"]) {
    await db.query("UPDATE public.fulfillment_inventory_reservations SET status=$2,terminal_reason=$3 WHERE id=$1", [c.reservationId, status, status === "consumed" ? null : "example"]);
    await budget(f, 15, 5, 0);
  }
  await db.query("UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason='example' WHERE id=$1", [a.reservationId]);
  await budget(f, 17, 3, 0);
});

it("W2 protects uncredited due demand and a 72-hour hold without double subtraction or a preview waiver", async () => {
  const f = await stock(), own = await subscription(f, 6);
  await subscription(f, 3, at(7 * DAY));
  await budget(f, 11, 0, 9);
  const a = await hold(f, own, 2);
  // Read fixture only: native reserve caps newly created holds at 24 hours.
  await db.query("UPDATE public.fulfillment_inventory_reservations SET expires_at=$2 WHERE id=$1", [a.reservationId, at(72 * HOUR)]);
  expect((await db.query("SELECT extract(epoch FROM expires_at-created_at)::int AS seconds FROM public.fulfillment_inventory_reservations WHERE id=$1", [a.reservationId])).rows).toEqual([{ seconds: 72 * 3600 }]);
  await budget(f, 11, 2, 7);
  const other = await subscription(f, 3), b = await hold(f, other, 3);
  await db.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [other]);
  await db.query("UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL WHERE id=$1", [b.reservationId]);
  const before = (await db.query("SELECT to_jsonb(r) AS row FROM public.fulfillment_inventory_reservations r ORDER BY id")).rows;
  await budget(f, 8, 5, 7);
  expect(await atp(f, true)).toMatchObject({ available_quantity: 15, soft_subscription_demand_quantity: 7 });
  for (const mode of ["new_purchase", "renewal"] as const) {
    const port = createNewPurchaseStockAvailabilityPort({ readPort: binding(f).newPurchaseStockReadPort!, functionMissingFallback: null,
      functionMissingError: "missing", defaultHorizonDays: 14, defaultLowStockThreshold: 1, observe: { warn() {} },
      deriveOfferAvailability: input => ({ ...input, status: "available", visibleInConfigurator: true, reasonCode: "stock_available" }) }, { mode });
    expect(await port.getAvailability({ items: [{ sku: f.sku, productSlug: "example", variantId: "example", requestedQuantity: 1, checkoutMode: "one_time" }] })).toMatchObject([{ sellableNow: 8 }]);
  }
  expect((await db.query("SELECT to_jsonb(r) AS row FROM public.fulfillment_inventory_reservations r ORDER BY id")).rows).toEqual(before);
  await budget(f, 8, 5, 7, 0, at(72 * HOUR - 1));
  // At expiry the matching two units become soft demand again: the protected total stays twelve.
  await budget(f, 8, 3, 9, 0, at(72 * HOUR));
});

it.each([
  ["active", 14 * DAY, 16], ["active", 14 * DAY + 1, 20], ["active", null, 20],
  ["paused", 0, 20], ["cancelled", 0, 20],
] as const)("W2 limits demand to active due subscriptions: %s / %s", async (status, offset, available) => {
  const f = await stock();
  await subscription(f, 4, offset === null ? null : at(offset), status);
  await budget(f, available, 0, 20 - available);
});

it("W2 credits only the matching due cycle, excludes paid/cancelled credit and refuses an unsupported cycle status", async () => {
  const f = await stock(), own = await subscription(f, 6), a = await hold(f, own, 2);
  await budget(f, 14, 2, 4);
  await db.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [own, at(DAY)]);
  await budget(f, 12, 2, 6);
  await db.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [own, at()]);
  await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint) VALUES ($1,$2,'paid',$3,$4)", [own, at(), a.operationId, "b".repeat(64)]);
  for (const status of ["paid", "cancelled"]) {
    await db.query("UPDATE public.subscription_cycles SET status=$2 WHERE subscription_id=$1", [own, status]);
    await budget(f, 12, 2, 6);
  }
  await db.query("SAVEPOINT unsupported_cycle");
  await expect(db.query("UPDATE public.subscription_cycles SET status='skipped' WHERE subscription_id=$1", [own])).rejects.toMatchObject({ code: "23514", constraint: "subscription_cycles_status_check" });
  await db.query("ROLLBACK TO SAVEPOINT unsupported_cycle");
});

it("W2 subtracts channel exposure through the existing hook before returning the same ATP budget", async () => {
  const f = await stock(), own = await subscription(f, 6);
  await subscription(f, 3, at(DAY));
  await hold(f, own, 2);
  expect((await db.query("SELECT public.inventory_channel_exposure_quantity($1,$2) AS quantity", [f.source, f.sku])).rows).toEqual([{ quantity: 0 }]);
  await budget(f, 11, 2, 7);
  // This replacement is confined to this disposable database transaction and rolled back.
  await db.query(`CREATE OR REPLACE FUNCTION public.inventory_channel_exposure_quantity(p_source_key text,p_sku text)
    RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT '4'::jsonb $$`);
  await budget(f, 7, 2, 7, 4);
});

it("W2 clamps oversubscribed budgets and reports stale or absent native stock without local fallback", async () => {
  const f = await stock(5), own = await subscription(f, 8);
  await hold(f, own, 3);
  await budget(f, 0, 3, 5);
  await db.query("UPDATE public.fulfillment_stock_current SET total_quantity=20,for_sale_quantity=20 WHERE source_key=$1", [f.source]);
  await budget(f, 12, 3, 5);
  await db.query("UPDATE public.fulfillment_stock_current SET stale_after=$2 WHERE source_key=$1", [f.source, at()]);
  expect(await budget(f, 0, 3, 5)).toMatchObject({ source: "provider", providerForSale: 20, stale: true });
  expect(await atp(f)).toMatchObject({ for_sale_quantity: 0 });
  await db.query("DELETE FROM public.fulfillment_stock_current WHERE source_key=$1", [f.source]);
  expect(await budget(f, 0, 3, 5)).toMatchObject({ source: "missing", providerForSale: null, stale: false, catalogSkuId: f.skuId });
  expect((await db.query("SELECT to_regclass('public.inventory_balances') AS local")).rows).toEqual([{ local: null }]);
  expect(await preview({ ...f, sku: "SKU-UNKNOWN" })).toMatchObject({ source: "missing", catalogSkuId: null, available: 0, availableForNewPurchases: 0, activeHolds: 0, renewalDemand: 0 });
});

it("refuses own-order exclusions and nonstandard horizons through the real native binding", async () => {
  const f = await stock(), port = binding(f).newPurchaseStockReadPort!;
  for (const options of [{ horizonDays: 14, excludeOrderId: randomUUID() }, { horizonDays: 0, excludeOrderId: null }, { horizonDays: 15, excludeOrderId: null }]) {
    await expect(port.read({ skus: [f.sku], ...options })).rejects.toThrow("native_stock_read_options_unsupported");
  }
  await budget(f, 20, 0, 0);
});

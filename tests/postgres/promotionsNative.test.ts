/** Existing native read/lifecycle subset only; no code resolver or mounted acceptance parity claim. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { evaluatePromos } from "@openlup/core/promo";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresCommercePromoDataPort, createPostgresPromotionClaimSweepPort, PROMOTIONS_MIGRATIONS } from "@openlup/platform/promotions";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool;
const customer = "c5000000-0000-4000-8000-000000000001";
const at = "2026-10-20T12:00:00.000Z", before = "2026-10-20T10:00:00.000Z";
const sweepInput = { now: at, limit: 1, claimLeaseMinutes: 15, graceMinutes: 5 };
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const runner = () => createPostgresMigrationRunner({ connectionString: container!.connectionString }, { poolFactory: () => pool });
const definition = (id: string, status = "active") => ({ id, status, code: null, name: "Example discount", trigger_type: "automatic", discount_type: "percentage", discount_value: 10, applies_to_kind: "order_total", applies_to_payload: {}, stacking_rule: "exclusive", eligibility: {}, valid_from: "2026-01-01T00:00:00Z", valid_to: null, region_availability: ["ZZ"], redemption_limit_global: null, redemption_limit_per_customer: null });
const executor = (db: Pool | PoolClient) => ({ query: (sql: string, values?: readonly unknown[]) => db.query(sql, values ? [...values] : undefined) });
const read = () => createPostgresCommercePromoDataPort(executor(pool));
const sweep = () => createPostgresPromotionClaimSweepPort(executor(pool));
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["commerce_orders", "commerce_order_items", "commerce_order_adjustments", "commerce_promotion_claims", "commerce_promotion_claim_events", "commerce_order_draft_receipts", "outbox_events"])
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
async function draft(key: string, expires = "2026-10-20T11:00:00.000Z") {
  const order = randomUUID();
  const db = await pool.connect();
  try {
  await db.query("BEGIN");
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,created_at) VALUES ($1,$2,'XXX',900,$3)", [order, customer, before]);
  await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES ($1,1,1,900,900)", [order]);
  const adjustment = (await db.query("INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint) SELECT $1,'promotion_discount','order_total',100,promotion_id,definition_fingerprint FROM public.commerce_promotion_definitions WHERE promotion_id='example' RETURNING id", [order])).rows[0].id;
  await db.query("INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,amount_off_minor,reserved_at,expires_at) SELECT promotion_id,definition_fingerprint,$1,$2,$3,100,$4,$5 FROM public.commerce_promotion_definitions WHERE promotion_id='example'", [adjustment, order, customer, before, expires]);
  await db.query("INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload) VALUES ($1,$2,$3,'{}')", [key, "a".repeat(32), order]);
  await db.query("INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES ('commerce_order',$1,'commerce.order_draft.created',$2,'{}')", [order, key]);
  await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  return order;
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Promotions native proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `promotions-native-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Promotions PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await runner().apply();
  await pool.query("INSERT INTO public.clients(id,email) VALUES ($1,'customer@example.invalid')", [customer]);
  for (const [id, status, active] of [["example", "active", true], ["inactive", "active", false], ["paused", "paused", true]] as const)
    await pool.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES ($1,$2,$3)", [id, definition(id, status), active]);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it("installs the complete canonical chain, validates 47/48 projections and replays with no pending work", async () => {
  expect(PROMOTIONS_MIGRATIONS.map(unit => unit.position)).toEqual([47, 48]);
  for (const unit of PROMOTIONS_MIGRATIONS) {
    const bytes = readFileSync(unit.catalogPath);
    expect(readFileSync(unit.url)).toEqual(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
    expect([manifest.baseline, ...manifest.forward][unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
  }
  const history = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
  expect(history.map(({ catalog_path, sha256, position }) => ({ file: catalog_path, sha256, position }))).toEqual([manifest.baseline, ...manifest.forward].map((unit: { file: string; sha256: string }, position: number) => ({ ...unit, position })));
  await runner().apply();
  expect((await runner().status()).pending).toEqual([]);
  expect((await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows).toEqual(history);
  expect((await pool.query("SELECT convalidated FROM pg_constraint WHERE conname IN ('commerce_order_items_promoted_allocation_check','commerce_order_draft_receipts_invalidation_check')")).rows).toEqual([{ convalidated: true }, { convalidated: true }]);
});
it("reads active evaluator rows, paid/redemption counts and conservative device evidence without durable writes", async () => {
  const order = await draft("read-lifecycle");
  await pool.query("UPDATE public.commerce_orders SET status='paid',paid_at=$2 WHERE id=$1", [order, at]);
  // Repeating the terminal transition creates no second claim event.
  await pool.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1", [order]);
  const subscription = randomUUID(), cycle = randomUUID(), subscriptionOrder = await draft("read-subscription");
  await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,$3)", [subscription, customer, at]);
  await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES ($1,$2,$3)", [cycle, subscription, at]);
  await pool.query("UPDATE public.commerce_orders SET status='paid',subscription_cycle_id=$2,paid_at=$3 WHERE id=$1", [subscriptionOrder, cycle, at]);
  const initial = await snapshot();
  const candidates = await read().listActivePromotions();
  expect(candidates).toEqual([definition("example")]);
  expect(evaluatePromos({ candidates, now: at, cart: { region_code: "ZZ", cart_mode: "one_time", cart_subtotal_minor: 10000, shipping_amount_minor: 500, client_orders_count: await read().countPaidOrders(customer), applied_codes: [] } })).toMatchObject([{ promotion_id: "example", amount_off_minor: 1000 }]);
  expect(await read().countPaidOrders(customer)).toBe(2);
  expect(await read().countPaidOrdersByMode(customer)).toEqual({ oneTime: 1, subscription: 1 });
  expect(await read().redemptionCounts(customer)).toEqual(new Map([["example", { global: 2, perCustomer: 2 }]]));
  expect(await read().redemptionCounts(null)).toEqual(new Map([["example", { global: 2, perCustomer: 0 }]]));
  expect(await read().deviceFirstOrderRedeemed("visitor")).toBe(false);
  expect(await read().deviceFirstOrderRedeemed(" ")).toBe(false);
  expect(await snapshot()).toEqual(initial);
  expect((await pool.query("SELECT transition FROM public.commerce_promotion_claim_events")).rows).toEqual([{ transition: "redeemed" }, { transition: "redeemed" }]);
});
it("bounds sweep, releases claims, fences receipts/outbox, preserves money and makes replay inert", async () => {
  const orders = [await draft("sweep-first"), await draft("sweep-second")];
  const money = (await pool.query("SELECT * FROM public.commerce_order_adjustments ORDER BY id")).rows;
  expect(await sweep().sweep(sweepInput)).toEqual({ checked: 1, cancelled: 1, skipped: 0 });
  expect((await pool.query("SELECT status FROM public.commerce_orders WHERE id=ANY($1) ORDER BY status", [orders])).rows).toEqual([{ status: "cancelled" }, { status: "pending_payment" }]);
  expect(await sweep().sweep(sweepInput)).toEqual({ checked: 1, cancelled: 1, skipped: 0 });
  const terminal = await snapshot();
  expect(await sweep().sweep(sweepInput)).toEqual({ checked: 0, cancelled: 0, skipped: 0 });
  expect(await snapshot()).toEqual(terminal);
  expect((await pool.query("SELECT * FROM public.commerce_order_adjustments ORDER BY id")).rows).toEqual(money);
  expect((await pool.query("SELECT status,release_reason FROM public.commerce_promotion_claims WHERE order_id=ANY($1)", [orders])).rows).toEqual(orders.map(() => ({ status: "released", release_reason: "order_cancelled" })));
  expect((await pool.query("SELECT invalidation_reason,invalidated_at IS NOT NULL AS fenced FROM public.commerce_order_draft_receipts WHERE order_id=ANY($1)", [orders])).rows).toEqual(orders.map(() => ({ invalidation_reason: "stale_promotion_claim", fenced: true })));
  expect((await pool.query("SELECT processed_at IS NOT NULL AS terminal,metadata->>'terminalReason' AS reason FROM public.outbox_events WHERE aggregate_id=ANY($1)", [orders])).rows).toEqual(orders.map(() => ({ terminal: true, reason: "stale_promotion_claim" })));
  for (const limit of [0, 201]) await expect(sweep().sweep({ ...sweepInput, limit })).rejects.toMatchObject({ code: "22023", message: "promotion_claim_sweep_invalid_input" });
});
it("skips locked orders and settlement work without consuming claims", async () => {
  const locked = await draft("sweep-locked"), settling = await draft("sweep-settling");
  await pool.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES ($1,'synthetic',900,'XXX','settling-key')", [settling]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT 1 FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [locked]);
    expect(await sweep().sweep({ ...sweepInput, limit: 2 })).toEqual({ checked: 1, cancelled: 0, skipped: 1 });
    expect((await pool.query("SELECT status FROM public.commerce_promotion_claims WHERE order_id=ANY($1)", [[locked, settling]])).rows).toEqual([{ status: "reserved" }, { status: "reserved" }]);
  } finally { await client.query("ROLLBACK"); client.release(); }
  expect(await sweep().sweep({ ...sweepInput, limit: 2 })).toEqual({ checked: 2, cancelled: 1, skipped: 1 });
  await pool.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [settling]);
});
it("denies unauthorized roles and admits only explicit invoker read grants", async () => {
  await pool.query("CREATE ROLE promotions_reader NOLOGIN; CREATE ROLE promotions_denied NOLOGIN");
  const client = await pool.connect();
  try {
    await client.query("SET ROLE promotions_denied");
    for (const operation of [() => createPostgresCommercePromoDataPort(executor(client)).listActivePromotions(), () => createPostgresPromotionClaimSweepPort(executor(client)).sweep(sweepInput), () => client.query("SELECT * FROM public.commerce_promotion_claims"), () => client.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition) VALUES ('denied','{}')")])
      await expect(operation()).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
    await client.query("GRANT EXECUTE ON FUNCTION public.commerce_promotion_active_definitions() TO promotions_reader");
    await client.query("SET ROLE promotions_reader");
    // Invoker rights still require the relation grant; execute alone is insufficient.
    await expect(createPostgresCommercePromoDataPort(executor(client)).listActivePromotions()).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
    await client.query("GRANT SELECT ON public.commerce_promotion_definitions TO promotions_reader");
    await client.query("SET ROLE promotions_reader");
    expect(await createPostgresCommercePromoDataPort(executor(client)).listActivePromotions()).toEqual([definition("example")]);
    await expect(createPostgresPromotionClaimSweepPort(executor(client)).sweep(sweepInput)).rejects.toMatchObject({ code: "42501" });
    await expect(client.query("UPDATE public.commerce_promotion_definitions SET active=false")).rejects.toMatchObject({ code: "42501" });
    await expect(client.query("SELECT public.commerce_create_promoted_order_draft_with_outbox('denied','{}','[]',NULL)")).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
    const surfaces = ["commerce_promotion_definitions", "commerce_order_adjustments", "commerce_promotion_claims", "commerce_promotion_claim_events"];
    expect((await client.query("SELECT c.relname FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) AND a.grantee=0", [surfaces])).rows).toEqual([]);
  } finally { await client.query("RESET ROLE"); client.release(); }
});

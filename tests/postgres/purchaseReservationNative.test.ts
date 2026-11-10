import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, expectTypeOf, it } from "vitest";
import { createPostgresAbandonedCheckoutCompensationPort, createPostgresPurchaseReservationPort, type PurchaseReservationInput } from "@openlup/platform/inventory";
import { createPostgresAdminInventoryPort } from "@openlup/platform/inventory";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import { z } from "zod";
import { PgGatewayClient } from "@openlup/platform/data";
import { createCheckoutCompensationRpcAdapter, type CheckoutCompensationPort } from "@openlup/platform/commerce/server";
import { isExpandOnlyPlatformForward, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { withIssuedPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady,
  postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { AT, later, call, renewal, prepareOriginal, failure, request, positive } from "./subscriptionNativeFixture.js";

const exec = promisify(execFile), name = `g4-native-${process.pid}`;
const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "postgres", runtimeLogin: "g4_runtime", restoreLogin: "g4_restore" } as const;
let container: PostgresContainer | undefined, admin: Pool, runtime: Pool, migration: Pool;
let inherited: Awaited<ReturnType<typeof renewal>>;
let beforeUpgradeRows: { row: Record<string, unknown> }[], beforeUpgradeAcl: unknown;
const forward = "db/platform/migrations/20261101224000_new_purchase_inventory_reservations.sql";
function connect() {
  admin = new Pool({ connectionString: container!.connectionString });
  migration = new Pool({ connectionString: container!.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  const url = new URL(container!.connectionString); url.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: url.toString(), options: "-c role=service_role", max: 8 });
}

// Compare every persisted field at full precision without session-zone display differences.
async function readSnapshot(sql: string, values: unknown[] = []) {
  const db = await admin.connect();
  try {
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL TimeZone='UTC'");
    const result = await db.query(sql, values);
    await db.query("COMMIT");
    return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
const port = () => createPostgresPurchaseReservationPort(runtime);
const runner = (root?: string) => createPostgresMigrationRunner({ connectionString: container!.connectionString },
  { installation, root, poolFactory: () => migration });
beforeAll(async () => {
  // The helper's default tmpfs is intentionally empty after a container restart.
  // Keep this fixture's PGDATA in its disposable writable layer, outside that mount.
  container = await runPostgresContainer({ name, password: "synthetic-conformance",
    runOptions: ["-e", "PGDATA=/var/lib/postgresql/g4-data"] });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  admin = new Pool({ connectionString: container.connectionString });
  for (const login of [installation.runtimeLogin, installation.restoreLogin]) {
    await admin.query(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  }
  await admin.end(); connect();
  await withIssuedPlatformCatalog(async root => { await runner(root).apply(); });
  inherited = await renewal(admin);
  await call(admin, "fulfillment_reserve_subscription_renewal", [inherited.operation, inherited.token, 900, AT]);
  for (const status of ["committed", "consumed", "released", "expired"]) {
    const f = await renewal(admin);
    await call(admin, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
    await admin.query(`UPDATE public.fulfillment_inventory_reservations SET status=$2,
      terminal_reason=CASE WHEN $2 IN ('released','expired') THEN 'synthetic' ELSE NULL END WHERE renewal_operation_id=$1`, [f.operation, status]);
  }
  expect((await admin.query(`SELECT attnotnull FROM pg_attribute
    WHERE attrelid='public.fulfillment_inventory_reservations'::regclass AND attname='renewal_operation_id'`)).rows).toEqual([{ attnotnull: true }]);
  await expect(admin.query(`INSERT INTO public.fulfillment_inventory_reservations(operation_fingerprint,source_key,expires_at,created_at)
    VALUES($1,'synthetic',$2,$3)`, ["a".repeat(64), later(1), AT])).rejects.toMatchObject({ code: "23502", column: "renewal_operation_id" });
  beforeUpgradeRows = (await readSnapshot(`SELECT to_jsonb(r) row FROM public.fulfillment_inventory_reservations r ORDER BY id`)).rows;
  expect(beforeUpgradeRows).toHaveLength(5);
  expect(beforeUpgradeRows.every(r => typeof r.row.renewal_operation_id === "string")).toBe(true);
  beforeUpgradeAcl = (await admin.query("SELECT relacl::text acl FROM pg_class WHERE oid='public.fulfillment_inventory_reservations'::regclass")).rows[0].acl;
  // Existing command cancellation cannot lock term lines as this runtime on
  // the issued prefix. Record the same refusal before introducing G4.
  // Pre-existing qualified-runtime limit; closed by F-QUALIFIED-LIFECYCLE-LOCK.
  await expect(call(runtime, "subscription_command_apply", [randomUUID(), inherited.client, randomUUID(), inherited.subscription, "cancel", {}, later(1)]))
    .rejects.toMatchObject({ code: "42501", message: "permission denied for table subscription_renewal_term_lines" });
  expect((await admin.query("SELECT has_table_privilege('service_role','public.commerce_promotion_claim_events','SELECT') allowed")).rows).toEqual([{ allowed: false }]);
  await runner().apply();
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [admin, runtime, migration]); }, postgresTeardownTimeoutMs);

async function stock(available = 10) {
  const id = randomUUID(), source = randomUUID(), sku = `SKU-${id}`;
  await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic')", [id, sku]);
  await admin.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Synthetic')", [id, sku]);
  await admin.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
    inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES($1,$2,$3,$3,0,'sellable',$4,'2027-12-01','g4',$1,$5)`, [source, sku, available, AT, "a".repeat(64)]);
  return { id, source, sku };
}
type Stock = Awaited<ReturnType<typeof stock>>;
async function purchase(f: Stock, quantities = [2]): Promise<PurchaseReservationInput> {
  const order = randomUUID(), client = randomUUID();
  const items: PurchaseReservationInput["items"][number][] = [];
  await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',0)", [order, client]);
    for (const [i, quantity] of quantities.entries()) {
      const orderItemId = randomUUID();
      await db.query(`INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        VALUES($1,$2,$3,$4,$5,0,0)`, [orderItemId, order, f.id, i + 1, quantity]);
      items.push({ orderItemId, skuId: f.id, quantity });
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  return { idempotencyKey: randomUUID(), orderId: order, stockSourceKey: f.source, items,
    paymentStatus: "created", expiresAt: later(1), now: AT, metadata: { source: "synthetic" } };
}
async function budget(f: Stock, now = AT, forRenewal = false) {
  return call(runtime, "inventory_available_to_promise", [f.source, f.sku, now, forRenewal]);
}
async function rows(orderId: string) {
  return (await readSnapshot(`SELECT to_jsonb(r) header,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sku) FROM public.fulfillment_inventory_reservation_lines l WHERE l.reservation_id=r.id) lines
    FROM public.fulfillment_inventory_reservations r WHERE r.purchase_order_id=$1 ORDER BY r.id`, [orderId])).rows;
}
async function release(id: string, now = AT, key = randomUUID()) {
  return port().releaseReservation({ idempotencyKey: key, reservationId: id, reason: "cancelled", now });
}
it("upgrades an existing renewal unchanged and exposes only bounded functions to the actual restricted login", async () => {
  expect((await readSnapshot(`SELECT to_jsonb(r)-'purchase_order_id' row FROM public.fulfillment_inventory_reservations r ORDER BY id`)).rows).toEqual(beforeUpgradeRows);
  expect((await admin.query(`SELECT count(*)::int total,count(renewal_operation_id)::int owned,
    count(purchase_order_id)::int purchases FROM public.fulfillment_inventory_reservations`)).rows).toEqual([{ total: 5, owned: 5, purchases: 0 }]);
  expect((await admin.query("SELECT relacl::text acl FROM pg_class WHERE oid='public.fulfillment_inventory_reservations'::regclass")).rows[0].acl).toEqual(beforeUpgradeAcl);
  expect((await runtime.query("SELECT current_user,session_user")).rows[0]).toEqual({ current_user: "service_role", session_user: "g4_runtime" });
  expect((await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='g4_runtime'")).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  expect((await admin.query("SELECT status,purchase_order_id FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1", [inherited.operation])).rows)
    .toEqual([{ status: "held", purchase_order_id: null }]);
  const constraints = (await admin.query(`SELECT conname,convalidated FROM pg_constraint WHERE conrelid='public.fulfillment_inventory_reservations'::regclass`)).rows;
  expect(constraints).toEqual(expect.arrayContaining([
    { conname: "fulfillment_inventory_reservations_operation_key", convalidated: true },
    { conname: "fulfillment_inventory_reservations_renewal_operation_id_fkey", convalidated: true },
    { conname: "fulfillment_inventory_reservations_owner_check", convalidated: true },
    { conname: "fulfillment_inventory_reservations_purchase_order_fkey", convalidated: true },
  ]));
  await expect(runtime.query("INSERT INTO public.fulfillment_purchase_reservation_receipts VALUES('forbidden','{}','{}',now())")).rejects.toMatchObject({ code: "42501" });
  const deniedInput = await purchase(await stock());
  const ownerInsert = `INSERT INTO public.fulfillment_inventory_reservations(
    renewal_operation_id,purchase_order_id,operation_fingerprint,source_key,expires_at,created_at)
    VALUES($1,$2,$3,'synthetic',$4,$5)`;
  for (const [operation, order] of [[null, null], [inherited.operation, deniedInput.orderId]]) {
    await expect(admin.query(ownerInsert, [operation, order, "a".repeat(64), later(1), AT]))
      .rejects.toMatchObject({ code: "23514", constraint: "fulfillment_inventory_reservations_owner_check" });
  }
  await expect(admin.query(ownerInsert, [null, randomUUID(), "a".repeat(64), later(1), AT]))
    .rejects.toMatchObject({ code: "23503", constraint: "fulfillment_inventory_reservations_purchase_order_fkey" });
  await expect(admin.query(ownerInsert, [inherited.operation, null, "a".repeat(64), later(1), AT]))
    .rejects.toMatchObject({ code: "23505", constraint: "fulfillment_inventory_reservations_operation_key" });
  for (const role of ["anon", "authenticated"]) {
    const url = new URL(container!.connectionString); url.username = installation.runtimeLogin;
    const browser = new Pool({ connectionString: url.toString(), options: `-c role=${role}` });
    try {
      const denied = createPostgresPurchaseReservationPort(browser);
      await expect(denied.reserveOrderItems(deniedInput)).rejects.toMatchObject({ code: "42501" });
      await expect(denied.releaseReservation({ idempotencyKey: randomUUID(), reservationId: randomUUID(), reason: "cancelled", now: AT })).rejects.toMatchObject({ code: "42501" });
      await expect(denied.expireReservations({ now: AT })).rejects.toMatchObject({ code: "42501" });
      await expect(createPostgresAbandonedCheckoutCompensationPort(browser, () => AT).cancelAbandonedOrder({ idempotencyKey: randomUUID(), orderId: deniedInput.orderId, reason: "cancelled" })).rejects.toMatchObject({ code: "42501" });
    }
    finally { await browser.end(); }
  }
  for (const name of ["fulfillment_reserve_purchase_order_items", "fulfillment_release_purchase_reservation", "fulfillment_expire_purchase_reservations", "commerce_cancel_abandoned_purchase_checkout"]) {
    expect((await admin.query("SELECT prosecdef,proconfig FROM pg_proc WHERE proname=$1", [name])).rows)
      .toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] }]);
  }
});
// Accepted pre-admission definition; the probe transaction never commits this object.
const preAdmissionExpiry = String.raw`CREATE FUNCTION public.fulfillment_expire_purchase_reservations(p_now timestamptz DEFAULT now(),p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE reservation record; count integer:=0;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'fulfillment_purchase_expiry_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR reservation IN SELECT id FROM public.fulfillment_inventory_reservations
    WHERE purchase_order_id IS NOT NULL AND status='held' AND expires_at<=p_now
    ORDER BY expires_at,id LIMIT p_limit FOR UPDATE LOOP
    UPDATE public.fulfillment_inventory_reservations SET status='expired',terminal_reason='reservation_expired',updated_at=p_now
      WHERE id=reservation.id;
    count:=count+1;
  END LOOP;
  RETURN jsonb_build_object('contractVersion','inventory.v0','expiredCount',count);
END;
$$;`;
async function expiryExecution(db: PoolClient, signature: string) {
  const attributes = (await db.query<{ owner: string; acl: string | null }>(
    "SELECT p.proowner::regrole::text owner,p.proacl::text acl FROM pg_catalog.pg_proc p WHERE p.oid=$1::regprocedure", [signature])).rows[0];
  const execute = (await db.query<{ role: string; allowed: boolean }>(
    "SELECT r.rolname role,pg_catalog.has_function_privilege(r.oid,$1::text,'EXECUTE') allowed FROM pg_catalog.pg_roles r ORDER BY r.rolname", [signature])).rows;
  return { ...attributes, execute };
}
it("preserves expiry ACL for every role and its migration owner", async () => {
  const db = await migration.connect();
  try {
    await db.query("BEGIN");
    await db.query(preAdmissionExpiry.replace("public.fulfillment_expire_purchase_reservations(", "public.g4_pre_admission_expiry_probe("));
    await db.query("REVOKE ALL ON FUNCTION public.g4_pre_admission_expiry_probe(timestamptz,integer) FROM PUBLIC,anon,authenticated");
    await db.query("GRANT EXECUTE ON FUNCTION public.g4_pre_admission_expiry_probe(timestamptz,integer) TO service_role");
    const before = await expiryExecution(db, "public.g4_pre_admission_expiry_probe(timestamptz,integer)");
    const after = await expiryExecution(db, "public.fulfillment_expire_purchase_reservations(timestamptz,integer)");
    expect(after).toEqual(before);
    expect(after.owner).toBe(installation.migrationLogin);
    const definition = (await db.query<{ prosecdef: boolean; proconfig: string[]; prosrc: string }>(
      "SELECT prosecdef,proconfig,prosrc FROM pg_catalog.pg_proc WHERE oid='public.fulfillment_expire_purchase_reservations(timestamptz,integer)'::regprocedure")).rows[0];
    expect(definition).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] });
    expect(definition.prosrc).toContain("NOT pg_catalog.isfinite(p_now)");
    expect(definition.prosrc).toContain("p_limit NOT BETWEEN 1 AND 1000");
    expect(definition.prosrc).toContain("WHERE purchase_order_id IS NOT NULL AND status='held' AND expires_at<=p_now");
    expect(definition.prosrc).toContain("public.inventory_admission_try_enter()");
    expect(definition.prosrc).toContain("pg_catalog.jsonb_build_object(");
    console.log(JSON.stringify({ expiryExecutionBefore: before, expiryExecutionAfter: after }));
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("uses the unchanged table grammar and narrows only the new receipt table without RLS or grants", async () => {
  const statements = sqlStatements(readFileSync(forward, "utf8"));
  const tables = statements.filter(s => /^CREATE TABLE /u.test(s));
  const ownerCheck = readFileSync(forward, "utf8").match(/CONSTRAINT fulfillment_inventory_reservations_owner_check\s+CHECK (\(.+\)) NOT VALID/u)?.[1];
  expect(ownerCheck).toBe("((renewal_operation_id IS NULL) = (purchase_order_id IS NOT NULL))");
  for (const mode of [false, true]) expect(isExpandOnlyPlatformForward(`CREATE TABLE public.g4_owner_probe (renewal_operation_id uuid,purchase_order_id uuid,CHECK ${ownerCheck});`, mode)).toBe(true);
  expect(tables).toHaveLength(1);
  for (const statement of tables) {
    expect(isExpandOnlyPlatformForward(statement)).toBe(true);
    expect(isExpandOnlyPlatformForward(statement, true)).toBe(true);
  }
  expect(statements.filter(s => /^ALTER TABLE .*ENABLE ROW LEVEL SECURITY/um.test(s))).toEqual([]);
  expect(statements.filter(s => /GRANT .* ON TABLE /u.test(s))).toEqual([]);
  const narrowing = statements.filter(s => s === "REVOKE ALL ON TABLE public.fulfillment_purchase_reservation_receipts FROM PUBLIC;"
    || s.startsWith("DO ") && s.includes("EXECUTE 'REVOKE ALL ON TABLE public.fulfillment_purchase_reservation_receipts FROM "));
  expect(narrowing).toHaveLength(4);
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    // Fixture-only effective grants simulate grants inherited from defaults;
    // the feature statements must remove them, without modifying default ACLs.
    await db.query("GRANT ALL ON TABLE public.fulfillment_purchase_reservation_receipts TO PUBLIC,anon,authenticated,service_role");
    for (const statement of narrowing) await db.query(statement);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await db.query(`SELECT has_table_privilege($1,'public.fulfillment_purchase_reservation_receipts',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed`, [role])).rows).toEqual([{ allowed: false }]);
    }
    expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.fulfillment_purchase_reservation_receipts'::regclass")).rows)
      .toEqual([{ relrowsecurity: false }]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("persists the ordered batch, serializes JS arrays as JSON, and refuses every changed keyed input", async () => {
  const f = await stock(), input = await purchase(f, [2, 3]), held = await port().reserveOrderItems(input);
  expect(held).toMatchObject({ status: "reserved", replayed: false, reservations: input.items.map(i => ({ orderItemId: i.orderItemId, status: "reserved", replayed: false })) });
  expect(held.reservations).toHaveLength(2);
  expect(await budget(f)).toMatchObject({ hard_hold_quantity: 5, available_quantity: 5 });
  const before = await rows(input.orderId);
  expect(before.map(r => r.lines[0].quantity).sort()).toEqual([2, 3]);
  expect(await port().reserveOrderItems({ ...input, now: later(2) })).toMatchObject({ replayed: true, reservations: held.reservations.map(r => ({ reservationId: r.reservationId, replayed: true })) });
  expect(await rows(input.orderId)).toEqual(before);
  const otherZone = await runtime.connect();
  try {
    await otherZone.query("SET TIME ZONE 'Pacific/Honolulu'");
    expect(await createPostgresPurchaseReservationPort(otherZone).reserveOrderItems(input)).toMatchObject({ replayed: true });
  } finally { await otherZone.query("RESET TIME ZONE"); otherZone.release(); }
  for (const changed of [
    { ...input, orderId: randomUUID() }, { ...input, stockSourceKey: randomUUID() },
    { ...input, items: [{ ...input.items[0], quantity: 1 }] }, { ...input, paymentStatus: "succeeded" as const },
    { ...input, expiresAt: later(2) }, { ...input, metadata: { source: "changed" } },
  ]) await expect(port().reserveOrderItems(changed)).rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
  expect(await rows(input.orderId)).toEqual(before);
  const id = held.reservations[0].reservationId, key = randomUUID();
  expect(await release(id, AT, key)).toMatchObject({ status: "released", replayed: false });
  const released = await rows(input.orderId);
  expect(await release(id, later(1), key)).toMatchObject({ replayed: true });
  await expect(port().releaseReservation({ idempotencyKey: key, reservationId: id, reason: "changed", now: AT })).rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
  await expect(release(held.reservations[1].reservationId, AT, key)).rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
  expect(await rows(input.orderId)).toEqual(released);
  expect(await budget(f)).toMatchObject({ hard_hold_quantity: 3, available_quantity: 7 });
});
it("retains SQL-only expiry identity across spellings, zones and microsecond changes", async () => {
  for (const [expiry, equivalent, changed, receiptText] of [
    ["2026-09-02T12:00:00.123456Z", "2026-09-02T21:00:00.123456+09:00", "2026-09-02T12:00:00.123457Z", "2026-09-02T12:00:00.123456"],
    ["2026-09-02T12:00:00.000000Z", "2026-09-02T12:00:00Z", "2026-09-02T12:00:00.000001Z", "2026-09-02T12:00:00"],
  ]) {
    const f = await stock(), input = { ...await purchase(f), expiresAt: expiry };
    const zones = ["UTC", "Etc/GMT-9", "Etc/GMT+5"], clients = await Promise.all(zones.map(() => runtime.connect()));
    const db = clients[0];
    try {
      const pids: number[] = [];
      for (const [index, session] of clients.entries()) {
        await session.query("SELECT set_config('TimeZone',$1,false)", [zones[index]]);
        expect((await session.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
          .toEqual([{ current_user: "service_role", session_user: "g4_runtime", rolsuper: false, rolbypassrls: false }]);
        pids.push((await session.query("SELECT pg_backend_pid() pid")).rows[0].pid);
      }
      expect(new Set(pids).size).toBe(3);
      const bound = createPostgresPurchaseReservationPort(db), held = await bound.reserveOrderItems(input);
      const before = await rows(input.orderId);
      const stockBefore = (await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows;
      for (const session of clients) {
        const bound = createPostgresPurchaseReservationPort(session);
        for (const expiresAt of [expiry, equivalent]) expect(await bound.reserveOrderItems({ ...input, expiresAt }))
          .toMatchObject({ replayed: true, reservations: [{ reservationId: held.reservations[0].reservationId, replayed: true }] });
        await expect(bound.reserveOrderItems({ ...input, expiresAt: changed }))
          .rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
        expect((await admin.query(`SELECT count(*)::int receipts, min(command->>'expiresAt') expiry,
          count(DISTINCT encode(sha256(convert_to(command::text,'UTF8')),'hex'))::int fingerprints
          FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1`, [input.idempotencyKey])).rows)
          .toEqual([{ receipts: 1, expiry: receiptText, fingerprints: 1 }]);
        expect((await admin.query(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expiry,
          operation_fingerprint=(SELECT encode(sha256(convert_to(command::text,'UTF8')),'hex')
          FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$2) same_fingerprint
          FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1`, [input.orderId, input.idempotencyKey])).rows)
          .toEqual([{ expiry, same_fingerprint: true }]);
        expect(await rows(input.orderId)).toEqual(before);
        expect(await budget(f)).toMatchObject({ hard_hold_quantity: 2, available_quantity: 8 });
        expect((await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows).toEqual(stockBefore);
      }
      for (const expiresAt of ["infinity", "-infinity"]) await expect(bound.reserveOrderItems({ ...input, idempotencyKey: randomUUID(), expiresAt }))
        .rejects.toThrow("fulfillment_purchase_reservation_elapsed_expiry");
      for (const now of [null, "infinity", "-infinity"]) await expect(db.query(
        "SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), input.orderId, input.stockSourceKey, JSON.stringify(input.items), input.paymentStatus, expiry, "{}", now]))
        .rejects.toThrow("fulfillment_purchase_reservation_invalid_input");
      const defaultInput = { ...await purchase(f), expiresAt: null };
      const defaultHold = await bound.reserveOrderItems(defaultInput);
      expect(await bound.reserveOrderItems(defaultInput)).toMatchObject({ replayed: true, reservations: [{ reservationId: defaultHold.reservations[0].reservationId }] });
      expect((await admin.query("SELECT command->'expiresAt' expiry FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [defaultInput.idempotencyKey])).rows).toEqual([{ expiry: null }]);
    } finally { for (const session of clients) { await session.query("RESET TIME ZONE"); session.release(); } }
  }
});
it("refuses malformed, elapsed, missing, stale, unavailable and foreign-item requests without partial holds", async () => {
  const f = await stock(3), input = await purchase(f, [2, 2]);
  // ErrorResponse can precede transaction abort and admission-lock release.
  // One session queues the next probe behind ReadyForQuery instead of entering
  // on another pooled connection while the previous refusal is still aborting.
  const db = await runtime.connect(), scoped = createPostgresPurchaseReservationPort(db);
  const scopedRelease = (reservationId: string) => scoped.releaseReservation({
    idempotencyKey: randomUUID(), reservationId, reason: "cancelled", now: AT,
  });
  try {
    for (const expiresAt of [AT, later(-1), "infinity"]) {
      await expect(scoped.reserveOrderItems({ ...input, expiresAt })).rejects.toThrow("fulfillment_purchase_reservation_elapsed_expiry");
    }
    for (const [delta, reason] of [
      [{ items: [] }, "inventory_reservation_items_invalid"],
      [{ items: [{ ...input.items[0], quantity: 0 }] }, "inventory_reservation_item_invalid"],
      [{ items: [{ ...input.items[0], orderItemId: randomUUID() }] }, "fulfillment_purchase_reservation_item_mismatch"],
      [{ items: [input.items[0], input.items[0]] }, "inventory_reservation_item_invalid"],
      [{ stockSourceKey: randomUUID() }, "inventory_external_provider_stock_missing"],
      [{ idempotencyKey: "short" }, "fulfillment_purchase_reservation_invalid_input"],
    ] as const) await expect(scoped.reserveOrderItems({ ...input, ...delta })).rejects.toThrow(reason);
    await expect(db.query(`SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,'failed',$5,'{}',$6)`,
      [input.idempotencyKey, input.orderId, f.source, JSON.stringify(input.items), input.expiresAt, AT])).rejects.toThrow("inventory_reservation_payment_status_not_reservable");
    await expect(scoped.reserveOrderItems(input)).rejects.toThrow("inventory_external_provider_insufficient_available_stock");
    expect(await rows(input.orderId)).toEqual([]);
    const args: unknown[] = [input.idempotencyKey, input.orderId, f.source, JSON.stringify(input.items), "created", input.expiresAt, "{}", AT];
    for (const [index, value, reason] of [
      [1, randomUUID(), "fulfillment_purchase_reservation_order_invalid"],
      [2, "invalid source", "fulfillment_purchase_reservation_invalid_input"],
      [3, "{}", "inventory_reservation_items_invalid"],
      [3, JSON.stringify([{ ...input.items[0], skuId: "invalid" }]), "inventory_reservation_item_invalid"],
      [6, "[]", "fulfillment_purchase_reservation_invalid_input"],
      [7, "infinity", "fulfillment_purchase_reservation_invalid_input"],
    ] as const) {
      const changed = [...args]; changed[index] = value;
      await expect(db.query(`SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,$5,$6,$7,$8)`, changed)).rejects.toThrow(reason);
    }
    await expect(scoped.releaseReservation({ idempotencyKey: randomUUID(), reservationId: randomUUID(), reason: "", now: AT })).rejects.toThrow("fulfillment_purchase_release_invalid_input");
    await expect(db.query("SELECT public.fulfillment_expire_purchase_reservations(NULL,1)")).rejects.toThrow("fulfillment_purchase_expiry_invalid_input");
    await admin.query("UPDATE public.fulfillment_stock_current SET stale_after=$2,last_synced_at=$3 WHERE source_key=$1", [f.source, AT, later(-1)]);
    await expect(scoped.reserveOrderItems(input)).rejects.toThrow("inventory_external_provider_stock_stale");
    expect(await rows(input.orderId)).toEqual([]);
    await expect(scopedRelease(randomUUID())).rejects.toThrow("inventory_reservation_not_found");
    await expect(scopedRelease((await admin.query("SELECT id FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1", [inherited.operation])).rows[0].id))
      .rejects.toThrow("inventory_reservation_not_found");
    for (const limit of [0, 1001]) await expect(scoped.expireReservations({ now: AT, limit })).rejects.toThrow("fulfillment_purchase_expiry_invalid_input");
  } finally {
    try { await db.query("ROLLBACK"); } finally { db.release(); }
  }
});
it("rolls back all created headers and lines when the final durable receipt cannot be written", async () => {
  const f = await stock(), input = await purchase(f, [2, 3]), db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE FUNCTION pg_temp.g4_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'g4_final_receipt_fault'; END $$`);
    await db.query("CREATE TRIGGER g4_receipt_fault BEFORE INSERT ON public.fulfillment_purchase_reservation_receipts FOR EACH ROW EXECUTE FUNCTION pg_temp.g4_receipt_fault()");
    await db.query("SAVEPOINT attempt; SET LOCAL ROLE service_role");
    await expect(createPostgresPurchaseReservationPort(db).reserveOrderItems(input)).rejects.toThrow("g4_final_receipt_fault");
    await db.query("ROLLBACK TO SAVEPOINT attempt");
    expect((await db.query("SELECT * FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1", [input.orderId])).rows).toEqual([]);
    expect((await db.query("SELECT * FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [input.idempotencyKey])).rows).toEqual([]);
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await budget(f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
});
it("serializes competing keys and matching replay, then races hold/release/expiry without restoring stock twice", async () => {
  const f = await stock(2), first = await purchase(f), second = await purchase(f);
  const admitting = await runtime.connect();
  const attempts = await (async () => {
    try {
      await admitting.query("BEGIN");
      const admitted = await createPostgresPurchaseReservationPort(admitting).reserveOrderItems(first);
      // Keep the successful admission transaction open while the competing call executes.
      const outcomes = await Promise.allSettled([Promise.resolve(admitted), port().reserveOrderItems(second)]);
      expect(outcomes[1]).toMatchObject({ status: "rejected", reason: {
        name: "InventoryPersistenceError", details: { code: "55P03", reason: "inventory_admission_busy" },
      } });
      expect(await rows(second.orderId)).toEqual([]);
      await admitting.query("COMMIT");
      return outcomes;
    } finally { await admitting.query("ROLLBACK"); admitting.release(); }
  })();
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const winner = attempts[0].status === "fulfilled" ? first : second;
  const replay = await Promise.all([port().reserveOrderItems(winner), port().reserveOrderItems(winner)]);
  expect(replay[0]).toEqual(replay[1]);
  expect(await budget(f)).toMatchObject({ hard_hold_quantity: 2, available_quantity: 0 });
  const id = replay[0].reservations[0].reservationId, third = { ...await purchase(f), now: later(1), expiresAt: later(2) };
  const releasing = await runtime.connect(), releaseKey = randomUUID();
  const before = (await readSnapshot("SELECT to_jsonb(r) row FROM public.fulfillment_inventory_reservations r ORDER BY id")).rows;
  const receiptCount = (await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts")).rows;
  try {
    await releasing.query("BEGIN");
    const released = await createPostgresPurchaseReservationPort(releasing).releaseReservation({
      idempotencyKey: releaseKey, reservationId: id, reason: "cancelled", now: later(1),
    });
    const outcomes = await Promise.allSettled([Promise.resolve(released),
      port().expireReservations({ now: later(1) }), port().reserveOrderItems(third)]);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { status: "released", replayed: false } });
    expect(outcomes.slice(1)).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({
      details: { code: "55P03", reason: "inventory_admission_busy" },
    }) }), expect.objectContaining({ status: "rejected", reason: expect.objectContaining({
      details: { code: "55P03", reason: "inventory_admission_busy" },
    }) })]);
    // Neither refused call writes: the other session still sees the entire original graph.
    expect((await readSnapshot("SELECT to_jsonb(r) row FROM public.fulfillment_inventory_reservations r ORDER BY id")).rows).toEqual(before);
    expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts")).rows).toEqual(receiptCount);
    expect(await rows(third.orderId)).toEqual([]);
    await releasing.query("COMMIT");
  } finally { await releasing.query("ROLLBACK"); releasing.release(); }
  // The concurrent outcome is exactly release-only; finish the refused calls serially.
  expect((await rows(winner.orderId))[0].header.status).toBe("released");
  expect(await budget(f, later(1))).toMatchObject({ hard_hold_quantity: 0, available_quantity: 2 });
  expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [releaseKey])).rows).toEqual([{ n: 1 }]);
  await port().expireReservations({ now: later(1) });
  const replacement = await port().reserveOrderItems(third);
  expect(await port().reserveOrderItems(third)).toMatchObject({ replayed: true,
    reservations: [{ reservationId: replacement.reservations[0].reservationId, replayed: true }] });
  expect(await rows(third.orderId)).toHaveLength(1);
  expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [third.idempotencyKey])).rows).toEqual([{ n: 1 }]);
  expect(await createPostgresPurchaseReservationPort(runtime).releaseReservation({
    idempotencyKey: releaseKey, reservationId: id, reason: "cancelled", now: later(1),
  })).toMatchObject({ status: "released", replayed: true });
  expect((await rows(winner.orderId))[0].header.status).toMatch(/^(released|expired)$/u);
  expect(await budget(f, later(1))).toMatchObject({ hard_hold_quantity: 2, available_quantity: 0 });
  expect(await release(id, later(1))).toMatchObject({ replayed: true });
  // Expiry skips the live replacement and all renewal ownership.
  expect(await port().expireReservations({ now: later(1) })).toMatchObject({ expiredCount: 0 });
  expect((await admin.query("SELECT status FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1", [inherited.operation])).rows[0].status).toBe("held");
});
it("shares hard-hold accounting and stock locks with renewal and stock wait without crediting purchase as renewal", async () => {
  const f = await renewal(admin), sku = f.snapshot.lines[0].sku;
  const id = (await admin.query("SELECT id FROM public.catalog_skus WHERE sku=$1", [sku])).rows[0].id;
  const s = { id, sku, source: f.source }, input = await purchase(s, [8]);
  // Renewal now shares admission; concurrent entry is covered by the gate witness.
  const held = await port().reserveOrderItems(input);
  const reserved = await call(runtime, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  expect(reserved).toMatchObject({ reserved: true });
  expect(await budget(s)).toMatchObject({ hard_hold_quantity: 10, soft_subscription_demand_quantity: 0, available_quantity: 0 });
  expect(await call(runtime, "subscription_stock_wait_deficits", [f.snapshot, f.operation, AT])).toEqual([]);
  await release(held.reservations[0].reservationId);
  expect(await budget(s)).toMatchObject({ hard_hold_quantity: 2, soft_subscription_demand_quantity: 0, available_quantity: 8 });
  const g = await renewal(admin), gsku = g.snapshot.lines[0].sku;
  const gs = { source: g.source, sku: gsku, id: (await admin.query("SELECT id FROM public.catalog_skus WHERE sku=$1", [gsku])).rows[0].id };
  const purchaseHold = await port().reserveOrderItems(await purchase(gs, [8]));
  // A provider observation can shrink after admission; neither renewal nor stock wait may spend purchase units.
  await admin.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=9 WHERE source_key=$1", [g.source]);
  expect(await budget(gs, AT, true)).toMatchObject({ hard_hold_quantity: 8, available_quantity: 1 });
  expect(await call(runtime, "subscription_stock_wait_deficits", [g.snapshot, g.operation, AT])).toMatchObject([{ reservedUnits: 0, missingUnits: 1 }]);
  expect(await call(runtime, "fulfillment_reserve_subscription_renewal", [g.operation, g.token, 900, AT])).toMatchObject({ reserved: false, reason: "inventory_unavailable" });
  await release(purchaseHold.reservations[0].reservationId);
  expect(await call(runtime, "subscription_stock_wait_deficits", [g.snapshot, g.operation, AT])).toEqual([]);
});
it("retry refuses to recommit stock spent by purchase and succeeds after its release", async () => {
  const f = await renewal(admin), original = await prepareOriginal(runtime, f);
  await call(runtime, "subscription_retry_apply_failure", [f.operation, randomUUID(), failure()]);
  const sku = f.snapshot.lines[0].sku, id = (await admin.query("SELECT id FROM public.catalog_skus WHERE sku=$1", [sku])).rows[0].id;
  const s = { source: f.source, sku, id };
  const held = await port().reserveOrderItems({ ...await purchase(s, [8]), expiresAt: later(30) });
  await admin.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=9 WHERE source_key=$1", [f.source]);
  const input = request({ ...f, original }), key = randomUUID();
  await expect(call(runtime, "subscription_retry_prepare", [f.operation, key, input, later(0.5)])).rejects.toThrow("subscription_retry_not_due_or_ambiguous");
  await expect(call(runtime, "subscription_retry_prepare", [f.operation, key, input, later(25)])).rejects.toThrow("subscription_retry_inventory_unavailable");
  expect(await budget(s, later(25), true)).toMatchObject({ hard_hold_quantity: 8, available_quantity: 1 });
  await release(held.reservations[0].reservationId, later(25));
  expect(await call(runtime, "subscription_retry_prepare", [f.operation, key, input, later(25)])).toMatchObject({ execute: true });
  expect(await budget(s, later(25), true)).toMatchObject({ hard_hold_quantity: 2, available_quantity: 7 });
  expect((await admin.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].status).toBe("active");
});
it("keeps expiry ordering/limit and durable replay through a real PostgreSQL restart", async () => {
  await port().expireReservations({ now: later(100) });
  const f = await stock(), input = await purchase(f), held = await port().reserveOrderItems(input);
  const other = { ...await purchase(f), expiresAt: later(2) };
  await port().reserveOrderItems(other);
  expect(await port().expireReservations({ now: later(1), limit: 1 })).toMatchObject({ expiredCount: 1 });
  expect((await rows(input.orderId))[0].header.status).toBe("expired");
  expect((await rows(other.orderId))[0].header.status).toBe("held");
  expect(await budget(f, later(1))).toMatchObject({ hard_hold_quantity: 2, available_quantity: 8 });
  const before = await rows(input.orderId);
  await runtime.end(); await admin.end(); await migration.end();
  await exec("docker", ["restart", name], { timeout: 30_000 });
  expect(await waitForPostgresTcpReady(container!.connectionString)).toBe(true);
  connect();
  expect(await rows(input.orderId)).toEqual(before);
  expect(await port().reserveOrderItems({ ...input, now: later(3) })).toMatchObject({ replayed: true,
    reservations: [{ reservationId: held.reservations[0].reservationId, status: "expired", replayed: true }] });
  await expect(port().reserveOrderItems({ ...input, metadata: { changed: true } })).rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
  expect(await release(held.reservations[0].reservationId, later(3))).toMatchObject({ status: "expired", replayed: true });
  expect(await rows(input.orderId)).toEqual(before);
  expect(await port().expireReservations({ now: later(3) })).toMatchObject({ expiredCount: 1 });
  expect(await port().expireReservations({ now: later(3) })).toMatchObject({ expiredCount: 0 });
  expect(await budget(f, later(3))).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
  expect(await runner().apply()).toEqual({ applied: [] });
}, 60_000);

async function besideRenewal(f: Awaited<ReturnType<typeof renewal>>, quantity = 2) {
  const sku = f.snapshot.lines[0].sku;
  const id = (await admin.query("SELECT id FROM public.catalog_skus WHERE sku=$1", [sku])).rows[0].id;
  const input = { ...await purchase({ id, sku, source: f.source }, [quantity]), expiresAt: later(30) };
  const held = await port().reserveOrderItems(input);
  return { input, held, stock: { id, sku, source: f.source } };
}
async function renewalRows() {
  return (await readSnapshot("SELECT to_jsonb(r) row FROM public.fulfillment_inventory_reservations r WHERE renewal_operation_id IS NOT NULL ORDER BY id")).rows;
}
it("renewal release and expiry exclude NULL owners; purchase release and expiry preserve all renewal rows", async () => {
  const f = await renewal(admin);
  const own = await call(runtime, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  const p = await besideRenewal(f), beforeRelease = await renewalRows();
  expect(await call(runtime, "subscription_read_renewal", [f.identity])).toMatchObject({ reservationId: own.reservationId });
  await release(p.held.reservations[0].reservationId);
  expect(await renewalRows()).toEqual(beforeRelease);
  const other = await besideRenewal(f), beforeRenewalRelease = await rows(other.input.orderId);
  await call(runtime, "fulfillment_release_subscription_renewal", [f.operation, f.token, "synthetic_release", AT]);
  expect(await rows(other.input.orderId)).toEqual(beforeRenewalRelease);

  const g = await renewal(admin);
  await call(runtime, "fulfillment_reserve_subscription_renewal", [g.operation, g.token, 900, AT]);
  const elapsed = await besideRenewal(g);
  // Make both owner classes elapsed through their original API inputs.
  const short = { ...elapsed.input, idempotencyKey: randomUUID(), expiresAt: later(1) };
  await port().reserveOrderItems(short);
  const beforeRenewalExpiry = await rows(elapsed.input.orderId);
  expect(await call(runtime, "fulfillment_expire_subscription_renewals", [later(1), 1000])).toBeGreaterThan(0);
  expect(await rows(elapsed.input.orderId)).toEqual(beforeRenewalExpiry);
  const h = await renewal(admin);
  await call(runtime, "fulfillment_reserve_subscription_renewal", [h.operation, h.token, 900, AT]);
  const beforePurchaseExpiry = await renewalRows();
  expect(await port().expireReservations({ now: later(1) })).toMatchObject({ expiredCount: 1 });
  expect(await renewalRows()).toEqual(beforePurchaseExpiry);
});
it.each(["preflight", "cancel", "succeeded", "refused", "late_recovery"])("%s mutates only its renewal owner beside NULL purchase owners", async action => {
  const f = await renewal(admin);
  if (action === "succeeded" || action === "refused" || action === "late_recovery") await prepareOriginal(runtime, f);
  else await call(runtime, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  if (action === "late_recovery") await call(runtime, "subscription_retry_apply_failure", [f.operation, randomUUID(), failure()]);
  const p = await besideRenewal(f), before = await rows(p.input.orderId);
  if (action === "preflight") await call(runtime, "subscription_refuse_renewal_preflight", [f.operation, f.token, "synthetic", AT]);
  else if (action === "cancel") {
    const args = [randomUUID(), f.client, randomUUID(), f.subscription, "cancel", {}, later(1)];
    await admin.query("UPDATE public.subscriptions SET created_at=$2,started_at=$2 WHERE id=$1", [f.subscription, AT]);
    // The shared lock and conflict completion admits the term-line row lock on this runtime.
    expect(await call(runtime, "subscription_command_apply", args)).toMatchObject({ status: "applied" });
  }
  else if (action === "late_recovery") await call(runtime, "subscription_retry_record_recovery", [f.operation, randomUUID(), positive(f)]);
  else await call(runtime, "commerce_record_subscription_renewal_outcome", [f.operation, randomUUID(), f.fingerprint, action, "original-ack", action === "refused" ? "declined" : null, AT]);
  expect(await rows(p.input.orderId)).toEqual(before);
  expect(await call(runtime, "subscription_stock_wait_mark_resumed", [p.input.orderId])).toBeNull();
});
it("stock-wait recovery chooses its original expired renewal, never a NULL-owner purchase", async () => {
  const f = await renewal(admin);
  const own = await call(runtime, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  const p = await besideRenewal(f), before = await rows(p.input.orderId);
  await call(runtime, "fulfillment_expire_subscription_renewals", [later(1), 1000]);
  const result = await call(runtime, "subscription_stock_wait_recover_refusal", [f.operation, f.fingerprint, "g4-fixture", later(1)]);
  expect(result).toMatchObject({ reservationId: own.reservationId, waiting: false });
  expect(await rows(p.input.orderId)).toEqual(before);
  expect(await call(runtime, "subscription_stock_wait_recover_refusal", [f.operation, f.fingerprint, "g4-fixture", later(1)]))
    .toMatchObject({ reservationId: own.reservationId, replayed: true });
});
it("stock sync/admin aggregate NULL-owner quantities while renewal-only listing never maps them as renewals", async () => {
  const f = await renewal(admin);
  const own = await call(runtime, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  const p = await besideRenewal(f);
  const stockSync = createPostgresFulfillmentStockSyncPort(runtime, { sourceKey: f.source, readLocalInventoryStock: async () => [] });
  expect(await stockSync.readActiveReservations([p.stock.sku], AT)).toEqual(new Map([[p.stock.sku, 4]]));
  const inventory = createPostgresAdminInventoryPort(runtime, { stockMasterProvider: "synthetic", providerSchema: z.literal("synthetic") }, () => AT);
  expect((await inventory.listStock({ skuId: p.stock.id, includeZero: true, page: 1, pageSize: 10 })).stock)
    .toMatchObject([{ reserved: 4, availableNow: 6 }]);
  expect((await inventory.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 })).skus.find(r => r.skuId === p.stock.id))
    .toMatchObject({ openHardReservations: 4, sellableNow: 6 });
  expect(await inventory.checkAtp({ contractVersion: "inventory.v0", requestedAt: AT, orderMode: "one_time",
    noSplitShipment: true, minShelfLifeDays: 0, lines: [{ skuId: p.stock.id, sku: p.stock.sku, quantity: 7 }] }))
    .toMatchObject({ status: "insufficient" });
  const reservations = await inventory.listReservations({ page: 1, pageSize: 100 });
  expect(reservations.reservations.some(r => r.id === own.reservationId)).toBe(true);
  expect(reservations.reservations.some(r => r.id === p.held.reservations[0].reservationId)).toBe(false);
});
it("stale promotion cleanup does not mistake a NULL purchase owner for a paid renewal commitment", async () => {
  const f = await stock(), input = { ...await purchase(f), expiresAt: later(30) };
  await port().reserveOrderItems(input);
  const promotion = randomUUID();
  const definition = { id: promotion, status: "active", trigger_type: "automatic", discount_type: "fixed_amount",
    applies_to_kind: "order_total", stacking_rule: "exclusive", eligibility: {}, applies_to_payload: {}, region_availability: ["ZZ"] };
  await admin.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,definition_fingerprint)
    VALUES($1,$2,'')`, [promotion, definition]);
  await admin.query(`WITH adjustment AS (
    INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
    SELECT $1,'promotion_discount','order_total',1,promotion_id,definition_fingerprint FROM public.commerce_promotion_definitions WHERE promotion_id=$2 RETURNING *
  ) INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,amount_off_minor,reserved_at,expires_at)
    SELECT promotion_id,definition_fingerprint,id,order_id,1,$3,$4 FROM adjustment`, [input.orderId, promotion, AT, later(1)]);
  await admin.query("UPDATE public.commerce_orders SET created_at=$2 WHERE id=$1", [input.orderId, AT]);
  const before = await rows(input.orderId);
  // The shared lock and conflict completion grants only the claim-event arbiter columns.
  expect((await admin.query("SELECT has_table_privilege('service_role','public.commerce_promotion_claim_events','SELECT') allowed")).rows).toEqual([{ allowed: false }]);
  expect(await call(runtime, "commerce_sweep_stale_promotion_claims", [later(2), 200, 15, 0])).toMatchObject({ cancelled: 1 });
  expect((await admin.query("SELECT status FROM public.commerce_orders WHERE id=$1", [input.orderId])).rows).toEqual([{ status: "cancelled" }]);
  expect(await rows(input.orderId)).toEqual(before);
});


async function abandoned() {
  const f = await stock(), input = await purchase(f, [2, 3]), db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE public.commerce_order_items SET unit_amount_minor=100,line_amount_minor=quantity*100 WHERE order_id=$1", [input.orderId]);
    await db.query("UPDATE public.commerce_orders SET total_amount_minor=500 WHERE id=$1", [input.orderId]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  const intent = randomUUID();
  await admin.query(`INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
    VALUES($1,$2,'synthetic',500,'XXX',$3)`, [intent, input.orderId, randomUUID()]);
  await call(admin, "subscription_declare_provisional_activation", [randomUUID(), input.orderId, 28, AT]);
  const held = await port().reserveOrderItems(input);
  const cancel: Parameters<CheckoutCompensationPort["cancelAbandonedOrder"]>[0] = { idempotencyKey: randomUUID(), orderId: input.orderId, reason: "checkout_failed_before_dispatch" };
  return { f, input, intent, held, cancel };
}
const compensate = (now = AT) => createPostgresAbandonedCheckoutCompensationPort(runtime, () => now);
async function compensationState(orderId: string) {
  const result: Record<string, unknown> = {};
  for (const table of ["commerce_orders", "commerce_settlement_intents", "subscription_activations", "commerce_checkout_compensations"]) {
    result[table] = (await readSnapshot(`SELECT to_jsonb(t) row FROM public.${table} t WHERE ${table === "commerce_orders" ? "id" : "order_id"}=$1 ORDER BY to_jsonb(t)::text`, [orderId])).rows;
  }
  result.reservations = await rows(orderId);
  result.receipts = (await readSnapshot(`SELECT to_jsonb(r) row FROM public.fulfillment_purchase_reservation_receipts r
    WHERE command->>'orderId'=$1 OR command->>'reservationId' IN
      (SELECT id::text FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1::uuid) ORDER BY idempotency_key`, [orderId])).rows;
  return result;
}
it("binds native aggregate cancellation instead of the absent generic RPC and releases all holds once", async () => {
  expectTypeOf<ReturnType<typeof createPostgresAbandonedCheckoutCompensationPort>>()
    .toEqualTypeOf<Pick<CheckoutCompensationPort, "cancelAbandonedOrder">>();
  const f = await abandoned();
  f.cancel.idempotencyKey = f.input.idempotencyKey;
  await expect(createCheckoutCompensationRpcAdapter(new PgGatewayClient(runtime)).cancelAbandonedOrder(f.cancel))
    .rejects.toMatchObject({ details: { code: "42883" } });
  await expect(call(runtime, "commerce_compensate_abandoned_checkout", [randomUUID(), f.input.orderId, "pre_dispatch", AT]))
    .rejects.toMatchObject({ code: "42501", message: "permission denied for table commerce_checkout_compensations" });
  expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 5, available_quantity: 5 });
  const outcomes = await Promise.all([compensate().cancelAbandonedOrder(f.cancel), compensate().cancelAbandonedOrder(f.cancel)]);
  expect(outcomes).toEqual([{ cancelled: true }, { cancelled: true }]);
  expect((await admin.query("SELECT status,metadata FROM public.commerce_orders WHERE id=$1", [f.input.orderId])).rows).toEqual([{ status: "cancelled", metadata: {} }]);
  expect((await admin.query("SELECT status,failure_reason FROM public.commerce_settlement_intents WHERE id=$1", [f.intent])).rows)
    .toEqual([{ status: "failed", failure_reason: f.cancel.reason }]);
  expect((await admin.query("SELECT state FROM public.subscription_activations WHERE order_id=$1", [f.input.orderId])).rows).toEqual([{ state: "compensated" }]);
  expect((await admin.query("SELECT count(*)::int n FROM public.commerce_checkout_compensations WHERE order_id=$1", [f.input.orderId])).rows).toEqual([{ n: 1 }]);
  expect((await rows(f.input.orderId)).map(r => r.header.status)).toEqual(["released", "released"]);
  expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
  const before = await compensationState(f.input.orderId);
  expect(await compensate(later(2)).cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: true });
  for (const changed of [{ ...f.cancel, reason: "changed" }, { ...f.cancel, orderId: randomUUID() }]) {
    await expect(compensate().cancelAbandonedOrder(changed)).rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
  }
  await expect(port().reserveOrderItems({ ...f.input, idempotencyKey: randomUUID() })).rejects.toThrow("fulfillment_purchase_reservation_order_invalid");
  expect(await port().reserveOrderItems(f.input)).toMatchObject({ replayed: true, reservations: [{ status: "released" }, { status: "released" }] });
  expect(await compensationState(f.input.orderId)).toEqual(before);
});
it("rolls back cancel, activation, intent, ledger and every release if a purchase release fails", async () => {
  const f = await abandoned(), before = await compensationState(f.input.orderId), db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE FUNCTION pg_temp.g4_release_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'g4_atomic_release_fault'; END $$`);
    await db.query("CREATE TRIGGER g4_release_fault BEFORE UPDATE ON public.fulfillment_inventory_reservations FOR EACH ROW EXECUTE FUNCTION pg_temp.g4_release_fault()");
    await db.query("SAVEPOINT attempt; SET LOCAL ROLE service_role");
    await expect(createPostgresAbandonedCheckoutCompensationPort(db, () => AT).cancelAbandonedOrder(f.cancel)).rejects.toThrow("g4_atomic_release_fault");
    await db.query("ROLLBACK TO SAVEPOINT attempt");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await compensationState(f.input.orderId)).toEqual(before);
  expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 5, available_quantity: 5 });
  expect(await compensate().cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: true });
});
it.each(["paid", "captured", "indeterminate", "settled"])("preserves %s money and its purchase holds instead of cancelling", async state => {
  const f = await abandoned();
  if (state === "paid") await call(runtime, "commerce_record_settlement", [randomUUID(), f.intent, "succeeded", "server-capture", {}, AT]);
  else if (state === "settled") await admin.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=$2 WHERE id=$1", [f.intent, AT]);
  else await admin.query(`INSERT INTO public.payment_truth_events(source_event_id,event_fingerprint,ingest_idempotency_key,
    settlement_intent_id,outcome,amount_minor,currency_code,source_evidence,occurred_at)
    VALUES($1,$2,$1,$3,$4,500,'XXX','{}',$5)`, [randomUUID(), "a".repeat(64), f.intent, state, AT]);
  const before = await compensationState(f.input.orderId);
  expect(await compensate().cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: false });
  const after = await compensationState(f.input.orderId);
  expect({ ...after, receipts: before.receipts }).toEqual(before);
  expect((await admin.query("SELECT result->>'reason' reason FROM public.fulfillment_purchase_reservation_receipts WHERE command->>'orderId'=$1 AND command->>'action'='cancel'", [f.input.orderId])).rows)
    .toEqual([{ reason: "money_recorded" }]);
  expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 5, available_quantity: 5 });
});
it("refuses malformed compensation input and durably replays a missing-order result", async () => {
  const order = randomUUID(), key = randomUUID();
  for (const args of [["short", order, "reason", AT], [key, null, "reason", AT], [key, order, "", AT], [key, order, "x".repeat(181), AT], [key, order, "reason", "infinity"]]) {
    await expect(call(runtime, "commerce_cancel_abandoned_purchase_checkout", args)).rejects.toThrow("commerce_checkout_compensation_invalid_input");
  }
  const input = { idempotencyKey: key, orderId: order, reason: "not_found" };
  expect(await compensate().cancelAbandonedOrder(input)).toEqual({ cancelled: false });
  expect(await compensate(later(2)).cancelAbandonedOrder(input)).toEqual({ cancelled: false });
});
it("keeps cancellation after restart and retains the earlier payment slot's late-capture boundary", async () => {
  const f = await abandoned();
  expect(await compensate().cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: true });
  const before = await compensationState(f.input.orderId);
  await runtime.end(); await admin.end(); await migration.end();
  await exec("docker", ["restart", name], { timeout: 30_000 });
  expect(await waitForPostgresTcpReady(container!.connectionString)).toBe(true); connect();
  expect(await compensationState(f.input.orderId)).toEqual(before);
  expect(await compensate(later(1)).cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: true });
  const source = randomUUID(), args = [source, "b".repeat(64), source, f.intent, "captured", 500, "XXX", later(1), null, null,
    { sourceKind: "accepted_event", sourceReference: "server-late-capture", observedStatus: "captured", observedAt: later(1), payloadFingerprint: "c".repeat(64) }, "fixture", "/repair", "fixture"];
  const reviewSlot = (await admin.query("SELECT 1 FROM pg_attribute WHERE attrelid='public.payment_truth_events'::regclass AND attname='review_required_at' AND NOT attisdropped")).rowCount === 1;
  expect(reviewSlot).toBe(true); // The integrated predecessor must exercise the joined capture-after-cancel proof.
  if (reviewSlot) {
    expect(await call(runtime, "payment_truth_ingest_event", args)).toMatchObject({ event: { outcome: "captured", applicationStatus: "review_required" } });
    expect((await admin.query("SELECT state,outcome,review_required_at IS NOT NULL review,settlement_transition_id,accounting_document_id FROM public.payment_truth_events WHERE source_event_id=$1", [source])).rows)
      .toEqual([{ state: "open", outcome: "captured", review: true, settlement_transition_id: null, accounting_document_id: null }]);
  } else {
    // The earlier slot is absent here: prove the base refuses to settle/reopen,
    // and explicitly do not claim its future review disposition passed.
    await expect(call(runtime, "payment_truth_ingest_event", args)).rejects.toThrow("commerce_settlement_record_order_not_payable");
    expect((await admin.query("SELECT count(*)::int n FROM public.payment_truth_events WHERE source_event_id=$1", [source])).rows).toEqual([{ n: 0 }]);
  }
  const after = await compensationState(f.input.orderId);
  expect(after).toEqual(before);
  expect(await budget(f.f, later(1))).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
}, 60_000);

it("refuses renewal-order compensation and serializes purchase admission and settlement with cancellation", async () => {
  const r = await renewal(admin), prepared = await prepareOriginal(runtime, r);
  await expect(compensate().cancelAbandonedOrder({ idempotencyKey: randomUUID(), orderId: prepared.orderId, reason: "not_checkout" }))
    .rejects.toThrow("commerce_checkout_compensation_renewal_order_unsupported");
  const f = await abandoned();
  const admission = { ...f.input, idempotencyKey: randomUUID() };
  const cancelling = await runtime.connect(), beforeCancel = await rows(f.input.orderId);
  const receiptCount = (await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts")).rows;
  const results = await (async () => {
    try {
      await cancelling.query("BEGIN");
      const cancelled = await createPostgresAbandonedCheckoutCompensationPort(cancelling, () => AT).cancelAbandonedOrder(f.cancel);
      // The completed cancel holds admission until commit while the competing reserve tries it.
      const outcomes = await Promise.allSettled([Promise.resolve(cancelled), port().reserveOrderItems(admission)]);
      expect(outcomes[1]).toMatchObject({ status: "rejected", reason: {
        name: "InventoryPersistenceError", details: { code: "55P03", reason: "inventory_admission_busy" },
      } });
      expect(await rows(f.input.orderId)).toEqual(beforeCancel);
      expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts")).rows).toEqual(receiptCount);
      await cancelling.query("COMMIT");
      return outcomes;
    } finally { await cancelling.query("ROLLBACK"); cancelling.release(); }
  })();
  expect(results[0]).toMatchObject({ status: "fulfilled", value: { cancelled: true } });
  if (results[1].status === "rejected") {
    const refusal = results[1].reason;
    if (refusal instanceof Error && refusal.message === "fulfillment_purchase_reservation_order_invalid") {
      expect(refusal).toMatchObject({ code: "22023" });
    } else {
      expect(refusal).toMatchObject({ name: "InventoryPersistenceError",
        details: { code: "55P03", reason: "inventory_admission_busy" } });
    }
  }
  expect((await rows(f.input.orderId)).every(row => row.header.status === "released")).toBe(true);
  expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
  expect((await admin.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.input.orderId])).rows).toEqual([{ status: "cancelled" }]);
  expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [admission.idempotencyKey])).rows).toEqual([{ n: 0 }]);
  const terminal = await rows(f.input.orderId);
  expect(await compensate().cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: true });
  expect(await rows(f.input.orderId)).toEqual(terminal);
  expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts WHERE command->>'action'='cancel' AND command->>'orderId'=$1", [f.input.orderId])).rows).toEqual([{ n: 1 }]);
  const g = await abandoned();
  const race = await Promise.allSettled([compensate().cancelAbandonedOrder(g.cancel), call(runtime, "commerce_record_settlement", [randomUUID(), g.intent, "succeeded", "race-capture", {}, AT])]);
  const status = (await admin.query("SELECT status FROM public.commerce_orders WHERE id=$1", [g.input.orderId])).rows[0].status;
  if (status === "paid") {
    expect(race[0]).toMatchObject({ status: "fulfilled", value: { cancelled: false } });
    expect(race[1].status).toBe("fulfilled");
    expect(await budget(g.f)).toMatchObject({ hard_hold_quantity: 5, available_quantity: 5 });
  } else {
    expect(status).toBe("cancelled");
    expect(race[0]).toMatchObject({ status: "fulfilled", value: { cancelled: true } });
    expect(race[1]).toMatchObject({ status: "rejected" });
    expect(await budget(g.f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
  }
});

// Source-pinned admission witness; provenance is kept in the maintainer packet.
it("matches the characterized admission body and keeps its helper owner-only", async () => {
  const row = (await admin.query("SELECT prosrc,prosecdef FROM pg_proc WHERE oid='public.inventory_admission_try_enter()'::regprocedure")).rows[0];
  const normalized = String(row.prosrc).replaceAll("pg_catalog.", "").replace(/\s+/gu, " ").trim();
  expect(createHash("sha256").update(normalized).digest("hex")).toBe("eb9582a0fff10fcd04666bce0695efca9aba75dbb079184da0ca677dbb853f07");
  expect(row.prosecdef).toBe(true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await admin.query("SELECT has_function_privilege($1,'public.inventory_admission_try_enter()','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
  expect((await runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: "service_role", session_user: "g4_runtime", rolsuper: false, rolbypassrls: false }]);
  await expect(runtime.query("SELECT public.inventory_admission_try_enter()"))
    .rejects.toMatchObject({ code: "42501" });
});
it("refuses reserve release and expiry without writes while another session owns admission", async () => {
  const f = await stock(), input = await purchase(f), held = await port().reserveOrderItems(input);
  const fresh = await purchase(f), id = held.reservations[0].reservationId;
  const before = await rows(input.orderId), receipts = (await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts")).rows;
  const stockBefore = (await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows;
  const blocker = await admin.connect();
  try {
    await blocker.query("BEGIN; SELECT pg_advisory_xact_lock(846832106,1)");
    expect(await port().reserveOrderItems(input)).toMatchObject({ replayed: true });
    await expect(port().reserveOrderItems({ ...fresh, items: [{ ...fresh.items[0], quantity: 0 }] }))
      .rejects.toMatchObject({ code: "22023", message: "inventory_reservation_item_invalid" });
    for (const invoke of [() => port().reserveOrderItems(fresh), () => release(id), () => port().expireReservations({ now: later(1) })]) {
      await expect(invoke()).rejects.toMatchObject({ name: "InventoryPersistenceError",
        message: "Inventory admission temporarily unavailable", details: { code: "55P03", reason: "inventory_admission_busy" } });
    }
    expect(await rows(input.orderId)).toEqual(before);
    expect(await rows(fresh.orderId)).toEqual([]);
    expect((await admin.query("SELECT count(*)::int n FROM public.fulfillment_purchase_reservation_receipts")).rows).toEqual(receipts);
    expect((await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows).toEqual(stockBefore);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  expect((await port().reserveOrderItems(fresh)).reservations).toHaveLength(1);
  expect(await release(id)).toMatchObject({ status: "released" });
  expect((await port().expireReservations({ now: later(1) })).expiredCount).toBeGreaterThanOrEqual(1);
  expect((await rows(fresh.orderId))[0].header.status).toBe("expired");
});
it("refuses both unsupported isolation levels through all three runtime entries", async () => {
  const input = await purchase(await stock()), held = await port().reserveOrderItems(input);
  const before = await rows(input.orderId), fresh = await purchase(await stock()), db = await runtime.connect();
  const scoped = createPostgresPurchaseReservationPort(db);
  try {
    for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
      for (const invoke of [() => scoped.reserveOrderItems(fresh),
        () => scoped.releaseReservation({ idempotencyKey: randomUUID(), reservationId: held.reservations[0].reservationId, reason: "cancelled", now: AT }),
        () => scoped.expireReservations({ now: later(1) })]) {
        await db.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await expect(invoke()).rejects.toMatchObject({ name: "InventoryPersistenceError",
          message: "Inventory reservation RPC failed", details: { code: "22023" } });
        await db.query("ROLLBACK");
      }
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await rows(input.orderId)).toEqual(before);
});
it("caps lock waits inside the call and restores transaction-local settings", async () => {
  const input = await purchase(await stock()), db = await runtime.connect(), blocker = await admin.connect();
  const scoped = createPostgresPurchaseReservationPort(db);
  try {
    for (const [prior, expected] of [["0", "50ms"], ["25ms", "25ms"], ["75ms", "50ms"]]) {
      await db.query("BEGIN"); await db.query("SELECT set_config('lock_timeout',$1,true)", [prior]);
      await scoped.reserveOrderItems(input);
      expect((await db.query("SHOW lock_timeout")).rows).toEqual([{ lock_timeout: expected }]);
      await db.query("ROLLBACK");
    }
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [input.orderId]);
    await db.query("BEGIN; SET LOCAL lock_timeout='0'");
    const start = performance.now();
    await expect(scoped.reserveOrderItems(input)).rejects.toMatchObject({ name: "InventoryPersistenceError",
      details: { code: "55P03", reason: "inventory_lock_unavailable" } });
    expect(performance.now() - start).toBeLessThan(2000);
    await db.query("ROLLBACK");
    expect((await db.query("SHOW lock_timeout")).rows).toEqual([{ lock_timeout: "0" }]);
    expect(await rows(input.orderId)).toEqual([]);
  } finally { await db.query("ROLLBACK"); await blocker.query("ROLLBACK"); db.release(); blocker.release(); }
});

// Exact characterized predicate; private provenance and carrier digest are in the maintainer packet.
it("pins the characterized cancellation in-flight predicate and terminal unpaid allowlist", async () => {
  const predicate = String.raw`  IF EXISTS (
    SELECT 1
      FROM public.commerce_payment_attempts payment_attempt
      JOIN public.commerce_payment_intents payment_intent
        ON payment_intent.id = payment_attempt.payment_intent_id
     WHERE payment_intent.order_id = p_order_id
       AND payment_attempt.status IN (
         'created', 'sent_to_provider', 'requires_action', 'processing'
       )
  ) THEN
    RETURN 'provider_attempt_in_flight';
  END IF;`;
  expect(createHash("sha256").update(predicate).digest("hex")).toBe("7e5a72572a60a84f52f79111335657088d1a7ac922f73f7a02ef169970f019c0");
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query("CREATE TEMP TABLE commerce_payment_intents(id uuid,order_id uuid) ON COMMIT DROP");
    await db.query("CREATE TEMP TABLE commerce_payment_attempts(payment_intent_id uuid,status text) ON COMMIT DROP");
    await db.query(`CREATE FUNCTION pg_temp.g4_characterized_guard(p_order_id uuid) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN ${predicate.replaceAll("public.", "pg_temp.")} RETURN NULL; END; $$`);
    const order = randomUUID(), intent = randomUUID();
    await db.query("INSERT INTO pg_temp.commerce_payment_intents VALUES($1,$2)", [intent, order]);
    for (const status of ["created", "sent_to_provider", "requires_action", "processing", "blocked_preflight", "failed", "cancelled", "expired"]) {
      await db.query("TRUNCATE pg_temp.commerce_payment_attempts");
      await db.query("INSERT INTO pg_temp.commerce_payment_attempts VALUES($1,$2)", [intent, status]);
      expect((await db.query("SELECT pg_temp.g4_characterized_guard($1) result", [order])).rows[0].result)
        .toBe(["created", "sent_to_provider", "requires_action", "processing"].includes(status) ? "provider_attempt_in_flight" : null);
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
});
async function simulatorCheckout() {
  const f = await abandoned();
  await admin.query("UPDATE public.commerce_settlement_intents SET channel_key='sandbox' WHERE id=$1", [f.intent]);
  return { ...f, begin: [randomUUID(), f.intent, "d".repeat(64), {}, AT] };
}
const cancelCheckout = (db: Pool | PoolClient, f: Awaited<ReturnType<typeof simulatorCheckout>>) =>
  call(db, "commerce_cancel_abandoned_purchase_checkout", [f.cancel.idempotencyKey, f.input.orderId, f.cancel.reason, AT]);
async function attemptState(f: Awaited<ReturnType<typeof simulatorCheckout>>) {
  return { compensation: await compensationState(f.input.orderId), stock: await budget(f.f),
    attempts: (await readSnapshot("SELECT to_jsonb(a) row FROM public.payment_simulator_attempts a WHERE settlement_intent_id=$1 ORDER BY id", [f.intent])).rows,
    observations: (await readSnapshot(`SELECT to_jsonb(e) row FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a
      ON a.id=e.attempt_id WHERE a.settlement_intent_id=$1 ORDER BY e.id`, [f.intent])).rows };
}
it("refuses a dispatched attempt without any write and permits cancellation after terminal failure", async () => {
  const f = await simulatorCheckout();
  const attempt = await call(runtime, "payment_simulator_begin_attempt", f.begin);
  expect(attempt).toMatchObject({ state: "dispatched", active: true });
  const before = await attemptState(f);
  expect(await cancelCheckout(runtime, f)).toEqual({ cancelled: false, reason: "provider_attempt_in_flight" });
  expect(await compensate().cancelAbandonedOrder(f.cancel)).toEqual({ cancelled: false });
  expect(await attemptState(f)).toEqual(before);
  await call(runtime, "payment_simulator_record_observation", [attempt.id, randomUUID(), "e".repeat(64), "refused", AT]);
  expect(await cancelCheckout(runtime, f)).toMatchObject({ cancelled: true, releasedCount: 2, replayed: false });
  expect(await cancelCheckout(runtime, f)).toMatchObject({ cancelled: true, releasedCount: 2, replayed: true });
  expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
  expect((await rows(f.input.orderId)).map(r => r.header.status)).toEqual(["released", "released"]);
  expect((await admin.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [f.intent])).rows).toEqual([{ status: "failed" }]);
});
it.each(["expired", "captured", "indeterminate"])("maps the simulator %s outcome without cancelling live or uncertain money", async state => {
  const f = await simulatorCheckout(), attempt = await call(runtime, "payment_simulator_begin_attempt", f.begin);
  await call(runtime, "payment_simulator_record_observation", [attempt.id, randomUUID(), "e".repeat(64), state, AT]);
  const before = await attemptState(f);
  if (state === "expired") {
    expect(await cancelCheckout(runtime, f)).toMatchObject({ cancelled: true, releasedCount: 2 });
    expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
  } else {
    expect(await cancelCheckout(runtime, f)).toEqual({ cancelled: false, reason: "money_recorded", orderStatus: "pending_payment" });
    expect(await attemptState(f)).toEqual(before);
  }
});
async function blockedBy(pid: number, blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await admin.query("SELECT $2::int=ANY(pg_catalog.pg_blocking_pids($1)) blocked", [pid, blocker])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("compensation_race_did_not_block_on_order");
}
// Two committed interleavings include observable blocking; allow container scheduling headroom.
it.each(["begin", "cancel"])("serializes simulator begin versus compensation with %s winning", async winner => {
  const f = await simulatorCheckout(), first = await runtime.connect(), second = await runtime.connect();
  let pending: Promise<unknown> | undefined;
  try {
    const firstPid = (await first.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await first.query("BEGIN");
    if (winner === "begin") {
      expect(await call(first, "payment_simulator_begin_attempt", f.begin)).toMatchObject({ state: "dispatched" });
      pending = cancelCheckout(second, f);
    } else {
      expect(await cancelCheckout(first, f)).toMatchObject({ cancelled: true });
      pending = call(second, "payment_simulator_begin_attempt", f.begin).then(value => ({ value }), error => ({ error }));
    }
    await blockedBy(secondPid, firstPid);
    await first.query("COMMIT");
    if (winner === "begin") {
      expect(await pending).toEqual({ cancelled: false, reason: "provider_attempt_in_flight" });
      expect((await admin.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.input.orderId])).rows).toEqual([{ status: "pending_payment" }]);
      expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 5, available_quantity: 5 });
      expect((await admin.query("SELECT count(*)::int n FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1 AND state='dispatched'", [f.intent])).rows).toEqual([{ n: 1 }]);
      expect((await admin.query("SELECT count(*)::int n FROM public.commerce_checkout_compensations WHERE order_id=$1", [f.input.orderId])).rows).toEqual([{ n: 0 }]);
    } else {
      expect(await pending).toMatchObject({ error: { code: "22023", message: "payment_simulator_order_not_payable" } });
      expect((await admin.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.input.orderId])).rows).toEqual([{ status: "cancelled" }]);
      expect(await budget(f.f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
      expect((await admin.query("SELECT count(*)::int n FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1", [f.intent])).rows).toEqual([{ n: 0 }]);
      expect((await admin.query("SELECT count(*)::int n FROM public.commerce_checkout_compensations WHERE order_id=$1", [f.input.orderId])).rows).toEqual([{ n: 1 }]);
    }
  } finally {
    await first.query("ROLLBACK");
    if (pending) await pending;
    first.release(); second.release();
  }
}, 30_000);

it("refuses duplicate UUID identities atomically while retaining single alias inputs and exact replay", async () => {
  expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user")).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const spelling of ["uppercase", "braced", "hyphenless"] as const) {
    const f = await stock(), input = await purchase(f);
    const canonical = "a" + input.items[0].orderItemId.slice(1);
    await admin.query("UPDATE public.commerce_order_items SET id=$2 WHERE id=$1", [input.items[0].orderItemId, canonical]);
    const item = { ...input.items[0], orderItemId: canonical };
    const alias = spelling === "uppercase" ? canonical.toUpperCase()
      : spelling === "braced" ? `{${canonical}}` : canonical.replaceAll("-", "");
    const aliased = { ...item, orderItemId: alias };
    const stockBefore = (await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows;
    for (const items of [[item, aliased], [aliased, item]]) {
      await expect(port().reserveOrderItems({ ...input, items }))
        .rejects.toMatchObject({ code: "22023", message: "inventory_reservation_item_invalid" });
      expect(await rows(input.orderId)).toEqual([]);
      expect((await admin.query("SELECT count(*)::int receipts FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [input.idempotencyKey])).rows)
        .toEqual([{ receipts: 0 }]);
      expect(await budget(f)).toMatchObject({ hard_hold_quantity: 0, available_quantity: 10 });
      expect((await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows).toEqual(stockBefore);
    }
    const single = { ...input, items: [aliased] }, first = await port().reserveOrderItems(single);
    expect(first).toMatchObject({ replayed: false, reservations: [{ orderItemId: alias, replayed: false }] });
    const persisted = await rows(input.orderId);
    expect(persisted).toHaveLength(1);
    expect(await port().reserveOrderItems(single)).toMatchObject({ replayed: true,
      reservations: [{ reservationId: first.reservations[0].reservationId, replayed: true }] });
    await expect(port().reserveOrderItems({ ...single, items: [item] }))
      .rejects.toThrow("fulfillment_purchase_reservation_idempotency_conflict");
    expect(await rows(input.orderId)).toEqual(persisted);
    expect((await admin.query("SELECT count(*)::int receipts FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=$1", [input.idempotencyKey])).rows)
      .toEqual([{ receipts: 1 }]);
    expect(await budget(f)).toMatchObject({ hard_hold_quantity: 2, available_quantity: 8 });
    expect((await readSnapshot("SELECT to_jsonb(s) row FROM public.fulfillment_stock_current s WHERE source_key=$1", [f.source])).rows).toEqual(stockBefore);
  }
});

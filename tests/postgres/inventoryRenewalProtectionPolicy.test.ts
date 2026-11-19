import { installCheckoutRecoveryReminderSchedule } from "@openlup/platform/commerce/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresStockAvailability, installRenewalStockProtectionPolicy, readRenewalStockProtectionPolicy, type RenewalStockProtectionPolicy } from "@openlup/platform/inventory";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { assertNativeStoreForward, readReviewedForwardRegistry, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { composeNativeBindings } from "../../examples/neutral-store/host/native-composition.ts";
import { createOriginPolicy } from "../../examples/neutral-store/host/origin-policy.ts";

const corpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/inventory/inventory_renewal_protection.json", import.meta.url), "utf8",
)) as Array<{ name: string; input: string; accepted: boolean; normalized?: RenewalStockProtectionPolicy; code?: string }>;
const source = "policy-fixture", sku = "POLICY-FIXTURE";
const installation = { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
  bootstrapLogin: "postgres", runtimeLogin: "starter_runtime", restoreLogin: "starter_restore" } as const;
let resource: PostgresContainer | undefined, db: Pool, asOf: string;
const atp = async (renewal = false, name = "public.inventory_available_to_promise") =>
  (await db.query(`SELECT ${name}($1,$2,$3,$4) AS result`, [source, sku, asOf, renewal])).rows[0].result;
const shape = async () => (await db.query(`SELECT proowner,proacl,prolang,provolatile,prosecdef,proconfig,prorettype,proargtypes
  FROM pg_proc WHERE oid='public.inventory_available_to_promise(text,text,timestamptz,boolean)'::regprocedure`)).rows;

beforeAll(async () => {
  resource = await runPostgresContainer({ name: `inventory-policy-${process.pid}`, password: "synthetic-policy" });
  if (!await waitForPostgresTcpReady(resource.connectionString)) throw new Error("policy PostgreSQL unavailable");
  db = new Pool({ connectionString: resource.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await db.query(`CREATE ROLE starter_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-runtime';
    CREATE ROLE starter_restore LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`);
  await createPostgresMigrationRunner({ connectionString: resource.connectionString }, { installation, poolFactory: () => db }).apply();
  // Independent historical body, retained byte-for-byte apart from the temporary name.
  const old = sqlStatements(readFileSync("db/platform/migrations/20261024183000_inventory_available_to_promise.sql", "utf8"))
    .find(sql => sql.startsWith("CREATE FUNCTION public.inventory_available_to_promise("))!;
  await db.query(old.replace("public.inventory_available_to_promise(", "public.inventory_policy_before_k7("));
  const previousReader = sqlStatements(readFileSync("db/platform/migrations/20261123130000_inventory_renewal_protection_policy.sql", "utf8"))
    .find(sql => sql.startsWith("CREATE FUNCTION public.inventory_renewal_protection_days("))!;
  await db.query(previousReader.replace("public.inventory_renewal_protection_days(", "public.inventory_renewal_protection_before_f2a("));
  asOf = (await db.query("SELECT date_trunc('second', statement_timestamp())::text AS instant")).rows[0].instant;
  const id = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES ($1,'policy@example.invalid')", [id]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,'policy-fixture','Fixture')", [id]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ($1,$1,$2,'Fixture')", [id, sku]);
  await db.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES ($1,$2,100,100,0,'sellable',$3,$3::timestamptz + interval '1 day','fixture','policy-fixture',$4)`, [source, sku, asOf, "a".repeat(64)]);
  await db.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    SELECT $1,$2 || '-' || i,100,100,0,'sellable',$3,$3::timestamptz + interval '1 day','fixture','policy-fixture-' || i,$4
    FROM generate_series(1,24) AS i`, [source, sku, asOf, "a".repeat(64)]);
  // 7-day boundary plus the requested 13/14/15-day cohort and 21-day boundary.
  for (const days of [7, 13, 14, 15, 21, 22]) {
    const subscription = randomUUID();
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,$3::timestamptz+make_interval(days=>$4))", [subscription, id, asOf, days]);
    await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES ($1,'XXX',$2,'fixture',$3,'fixture')", [subscription, source, asOf]);
    await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES ($1,1,$2,$3,100)", [subscription, sku, days]);
  }
  // Existing eligible-held/committed accounting must remain unchanged by policy.
  const order = randomUUID();
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES ($1,$2,'XXX',0)", [order, id]);
  for (const [status, quantity, expiryHours] of [["held", 2, 1], ["committed", 3, null], ["held", 9, 0]] as const) {
    const reservation = randomUUID();
    await db.query(`INSERT INTO public.fulfillment_inventory_reservations(id,source_key,purchase_order_id,operation_fingerprint,status,expires_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::timestamptz + make_interval(hours=>$7),$6::timestamptz - interval '1 day')`,
    [reservation, source, order, "b".repeat(64), status, asOf, expiryHours]);
    await db.query("INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity) VALUES ($1,repeat('b',64),$2,$3)", [reservation, sku, quantity]);
  }
}, postgresSetupTimeoutMs);
beforeEach(async () => { await db.query("DELETE FROM public.commerce_settings WHERE key='inventory_renewal_protection'"); });
afterAll(async () => { await closePostgres(resource, db); }, postgresTeardownTimeoutMs);

it.each([
  "20261123130000_inventory_renewal_protection_policy.sql",
  "20261125010000_inventory_renewal_protection_validation.sql",
])("admits %s against its complete native prefix", file => {
  const path = `db/platform/migrations/${file}`;
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  const prefix = [manifest.baseline, ...manifest.forward.filter((unit: { file: string }) => unit.file < path)]
    .map((unit: { file: string }) => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, path, readFileSync(path), prefix)).not.toThrow();
});

it("D: absence and the adopter 14-day literal equal the historical ATP body; 7/21 change only soft priority", async () => {
  const attributes = await shape(), baseline = await atp(false, "public.inventory_policy_before_k7");
  expect(baseline).toMatchObject({ available_quantity: 61, hard_hold_quantity: 5, soft_subscription_demand_quantity: 34 });
  const fallback = await readRenewalStockProtectionPolicy(db);
  expect(fallback).toEqual({ revision: "default", renewalProtectionDays: 14 });
  const sqlFallback = (await db.query("SELECT public.inventory_renewal_protection_days() AS days")).rows[0]?.days;
  expect(sqlFallback).toBe(fallback.renewalProtectionDays);
  const stock = createPostgresStockAvailability(db, { sourceKey: source, now: () => asOf });
  expect((await stock.readInstalled([sku])).get(sku)).toMatchObject({ availableForNewPurchases: 61, renewalDemand: 34 });
  expect((await db.query("SELECT key FROM public.commerce_settings WHERE key='inventory_renewal_protection'")).rows).toEqual([]);
  expect(await atp()).toEqual(baseline);
  // An adopter revision labels the installed value without changing its stock behavior.
  await installRenewalStockProtectionPolicy(db, { revision: "adopter-1", renewalProtectionDays: 14 });
  expect(await atp()).toEqual(baseline);
  for (const [days, demand] of [[7, 7], [21, 70]]) {
    await installRenewalStockProtectionPolicy(db, { revision: `fixture-${days}`, renewalProtectionDays: days });
    expect(await atp()).toEqual({ ...baseline, soft_subscription_demand_quantity: demand, available_quantity: 95 - demand });
    expect(await atp(true)).toEqual({ ...baseline, soft_subscription_demand_quantity: demand, available_quantity: 95 });
    expect((await stock.readPort.read({ skus: [sku], horizonDays: days, excludeOrderId: null })).get(sku))
      .toMatchObject({ renewalDemand: demand, availableForNewPurchases: 95 - demand });
    const before = (await db.query("SELECT * FROM public.fulfillment_inventory_reservations ORDER BY id")).rows;
    await expect(stock.readPort.read({ skus: [sku], horizonDays: 14, excludeOrderId: null })).rejects.toThrow("native_stock_read_options_unsupported");
    expect((await db.query("SELECT * FROM public.fulfillment_inventory_reservations ORDER BY id")).rows).toEqual(before);
  }
  expect(await shape()).toEqual(attributes);
});

it.each(corpus)("shared corpus (PostgreSQL): $name", async ({ input, accepted, normalized, code }) => {
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('inventory_renewal_protection',$1)", [input]);
  const previous = () => db.query("SELECT public.inventory_renewal_protection_before_f2a() AS days");
  const current = () => db.query("SELECT public.inventory_renewal_protection_days() AS days");
  const validate = () => db.query(`SELECT result, result->>'renewalProtectionDays' AS days_text
    FROM (SELECT public.inventory_renewal_protection_validate($1::jsonb) AS result) AS validated`, [input]);
  if (accepted) {
    const days = normalized!.renewalProtectionDays;
    expect((await previous()).rows).toEqual([{ days }]);
    expect((await current()).rows).toEqual([{ days }]);
    expect((await validate()).rows).toEqual([{ result: normalized, days_text: String(days) }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(previous()).rejects.toMatchObject(refusal);
    await expect(current()).rejects.toMatchObject(refusal);
    await expect(validate()).rejects.toMatchObject(refusal);
  }
});

it("reads the installer change without restart in one query for either 1 or 25 SKUs", async () => {
  const client = await db.connect();
  const install = await db.connect();
  try {
    await installRenewalStockProtectionPolicy(install, { revision: "initial-14", renewalProtectionDays: 14 });
    const calls: string[] = [];
    const stock = createPostgresStockAvailability({
      query(sql, params) {
        calls.push(sql);
        return client.query(sql, params);
      },
    }, { sourceKey: source, now: () => asOf });
    expect((await stock.readInstalled([sku])).get(sku)).toMatchObject({ availableForNewPurchases: 61, renewalDemand: 34 });
    expect(calls.splice(0)).toEqual([expect.stringContaining("public.inventory_new_purchase_stock_read(")]);
    await installRenewalStockProtectionPolicy(install, { revision: "change-21", renewalProtectionDays: 21 });
    const skus = [sku, ...Array.from({ length: 24 }, (_, index) => `${sku}-${index + 1}`)];
    const result = await stock.readInstalled(skus);
    expect(result.size).toBe(25);
    expect(result.get(sku)).toMatchObject({ availableForNewPurchases: 25, renewalDemand: 70 });
    expect(result.get(skus[24]!)).toMatchObject({ availableForNewPurchases: 100, renewalDemand: 0 });
    expect(calls).toEqual([expect.stringContaining("public.inventory_new_purchase_stock_read(")]);
  } finally {
    client.release();
    install.release();
  }
});

it("malformed installed policy always names the error, including empty demand and renewal exemption", async () => {
  const stock = createPostgresStockAvailability(db, { sourceKey: source, now: () => asOf });
  for (const value of [null, "{bad", ...corpus.filter(row => !row.accepted).map(row => row.input)]) {
    await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('inventory_renewal_protection',$1) ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text", [value]);
    for (const renewal of [false, true]) await expect(atp(renewal)).rejects.toMatchObject({ code: "22023", message: "inventory_renewal_protection_policy_invalid" });
    await expect(db.query("SELECT public.inventory_available_to_promise('missing','missing',$1,false)", [asOf]))
      .rejects.toMatchObject({ code: "22023", message: "inventory_renewal_protection_policy_invalid" });
    await expect(stock.readInstalled(["missing"]))
      .rejects.toMatchObject({ code: "22023", message: "inventory_renewal_protection_policy_invalid" });
    await expect(readRenewalStockProtectionPolicy(db)).rejects.toThrow("inventory_renewal_protection_policy_invalid");
  }
});

it("restricted native startup refuses drift before serving or writing, with installer-only policy writes", async () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  // Deliberately avoid assuming a built-in configuration ID.
  config.id = "policy-startup-fixture";
  const url = new URL(resource!.connectionString); url.username = "starter_runtime"; url.password = "synthetic-runtime";
  const runtime = new Pool({ connectionString: url.toString() });
  try {
    for (const policy of [{ ...config.inventory.renewalProtection, revision: "different" },
      { ...config.inventory.renewalProtection, renewalProtectionDays: 21 }]) {
      await installRenewalStockProtectionPolicy(db, policy);
      const before = (await db.query("SELECT * FROM public.commerce_settings ORDER BY key")).rows;
      await expect(composeNativeBindings(url.toString(), createOriginPolicy(config, 4319), config)).rejects.toThrow("starter_installed_policy_drift");
      expect((await db.query("SELECT * FROM public.commerce_settings ORDER BY key")).rows).toEqual(before);
    }
    await installRenewalStockProtectionPolicy(db, config.inventory.renewalProtection);
    expect(await readRenewalStockProtectionPolicy(runtime)).toEqual(config.inventory.renewalProtection);
    expect(await createPostgresStockAvailability(runtime, { sourceKey: source, now: () => asOf }).availableToPromise(sku, asOf))
      .toMatchObject({ availableQuantity: 61 });
    expect((await createPostgresStockAvailability(runtime, { sourceKey: source, now: () => asOf }).readInstalled([sku])).get(sku))
      .toMatchObject({ availableForNewPurchases: 61 });
    await expect(runtime.query("SELECT public.inventory_renewal_protection_validate($1::jsonb)", [JSON.stringify(config.inventory.renewalProtection)]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(installRenewalStockProtectionPolicy(runtime, config.inventory.renewalProtection)).rejects.toMatchObject({ code: "42501" });
    await installCheckoutRecoveryReminderSchedule(db, config.checkoutRecoveryReminders);
    const bindings = await composeNativeBindings(url.toString(), createOriginPolicy(config, 4319), config);
    await bindings.close();
  } finally { await runtime.end(); }
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { previewSetting, settingsReadTools } from "@openlup/platform/operations/server";
import { installCheckoutRecoveryReminderSchedule } from "@openlup/platform/commerce/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresStockAvailability, installRenewalStockProtectionPolicy, previewRenewalStockProtection, readRenewalStockProtectionPolicy, renewalStockProtectionPreviewResult, type RenewalStockProtectionPolicy } from "@openlup/platform/inventory";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { assertNativeStoreForward, readReviewedForwardRegistry, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { configurations, selectConfiguration } from "../../examples/neutral-store/owned/store.config.ts";
import { composeNativeBindings } from "../../examples/neutral-store/host/native-composition.ts";
import { sizedHostPorts } from "../../examples/neutral-store/host/editor-ports.ts";
import { applyDemoSeed } from "../../examples/neutral-store/installation/install.ts";
import { createOriginPolicy } from "../../examples/neutral-store/host/origin-policy.ts";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

const corpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/inventory/inventory_renewal_protection.json", import.meta.url), "utf8",
)) as Array<{ name: string; input: string; accepted: boolean; normalized?: RenewalStockProtectionPolicy; decodedNormalized?: RenewalStockProtectionPolicy; code?: string }>;
const source = `starter-demo:${selectConfiguration().id}`, sku = "POLICY-FIXTURE";
const fixtureSkus = [sku, ...Array.from({ length: 24 }, (_, index) => `${sku}-${index + 1}`)];
const noStockSku = `${sku}-NO-STOCK`;
const missingSku = `${sku}-MISSING`;
const previewStockSql = "SELECT public.inventory_new_purchase_stock_preview($1::text,$2::jsonb,$3::timestamptz,$4::jsonb) AS response";
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
  await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title)
    SELECT gen_random_uuid(),$1,value,'Fixture' FROM unnest($2::text[]) value`, [id, [...fixtureSkus, noStockSku]]);
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
  "20261123142000_inventory_renewal_protection_validation.sql",
  "20261123147000_inventory_atp_aggregate_renewal_credits.sql",
  "20261123152000_inventory_new_purchase_stock_preview.sql",
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
    const decoded = corpus.find(row => row.input === value)?.decodedNormalized;
    if (decoded) await expect(readRenewalStockProtectionPolicy(db)).resolves.toEqual(decoded);
    else await expect(readRenewalStockProtectionPolicy(db)).rejects.toThrow("inventory_renewal_protection_policy_invalid");
  }
});

async function expectValidatorAccess(runtime: Pool) {
  const sql = "SELECT public.inventory_renewal_protection_validate($1::jsonb) AS result";
  const valid = '{"revision":"fixture","renewalProtectionDays":14.0}';
  expect((await runtime.query(sql, [valid])).rows).toEqual([{ result: { revision: "fixture", renewalProtectionDays: 14 } }]);
  await expect(runtime.query(sql, ['{"revision":"fixture","renewalProtectionDays":0}']))
    .rejects.toMatchObject({ code: "22023", message: "inventory_renewal_protection_policy_invalid" });
  expect((await runtime.query(`SELECT rolname FROM pg_catalog.pg_roles
    WHERE has_function_privilege(oid, 'public.inventory_renewal_protection_validate(jsonb)', 'EXECUTE')
    <> has_function_privilege(oid, 'public.inventory_renewal_protection_days()', 'EXECUTE')`)).rows).toEqual([]);

  const client = await runtime.connect();
  try {
    await client.query("SET ROLE anon");
    await expect(client.query(sql, [valid]))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function inventory_renewal_protection_validate" });
  } finally {
    try { await client.query("RESET ROLE"); } finally { client.release(); }
  }
}

it.each(["legacy", "separate", "admin-managed", "admin-operator"] as const)(
  "matches horizon reader permissions for the %s runtime", async profile => {
    const fixture = await installAccountMutations(profile);
    try { await expectValidatorAccess(fixture.runtime); }
    finally { await fixture.close(); }
  }, postgresSetupTimeoutMs,
);

it("revokes default validator execution grants for anon and authenticated", async () => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Replay the unlanded forward as its owner with browser-role defaults in place.
    await client.query(`DROP FUNCTION public.inventory_renewal_protection_validate(jsonb);
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated`);
    await client.query(readFileSync("db/platform/migrations/20261123142000_inventory_renewal_protection_validation.sql", "utf8"));
    for (const role of ["anon", "authenticated"]) {
      await client.query(`SET LOCAL ROLE ${role}; SAVEPOINT validator_call`);
      await expect(client.query("SELECT public.inventory_renewal_protection_validate($1::jsonb)", [
        '{"revision":"fixture","renewalProtectionDays":14}',
      ])).rejects.toMatchObject({ code: "42501", message: "permission denied for function inventory_renewal_protection_validate" });
      await client.query("ROLLBACK TO SAVEPOINT validator_call; RESET ROLE");
    }
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
});

it("a custom runtime needs a direct validator grant only for direct calls", async () => {
  const client = await db.connect();
  const proposed = '{"revision":"proposed","renewalProtectionDays":14.0}';
  try {
    await client.query("BEGIN");
    await installRenewalStockProtectionPolicy(client, { revision: "installed", renewalProtectionDays: 21 });
    await client.query(`CREATE ROLE inventory_preview_runtime NOLOGIN;
      GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_days() TO inventory_preview_runtime;
      SET LOCAL ROLE inventory_preview_runtime;
      SAVEPOINT horizon_only`);
    expect((await client.query(`SELECT pg_has_role(current_user, 'service_role', 'MEMBER') AS member,
      has_table_privilege(current_user, 'public.commerce_settings', 'SELECT') AS reads_settings`)).rows)
      .toEqual([{ member: false, reads_settings: false }]);
    await expect(client.query("SELECT public.inventory_renewal_protection_validate($1::jsonb)", [proposed]))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function inventory_renewal_protection_validate" });
    await client.query("ROLLBACK TO SAVEPOINT horizon_only");
    expect((await client.query("SELECT public.inventory_renewal_protection_days() AS days")).rows)
      .toEqual([{ days: 21 }]);

    await client.query(`RESET ROLE;
      GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_validate(jsonb) TO inventory_preview_runtime;
      SET LOCAL ROLE inventory_preview_runtime`);
    expect((await client.query(`SELECT public.inventory_renewal_protection_days() AS days,
      public.inventory_renewal_protection_validate($1::jsonb) AS policy`, [proposed])).rows)
      .toEqual([{ days: 21, policy: { revision: "proposed", renewalProtectionDays: 14 } }]);
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
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
    await expectValidatorAccess(runtime);
    const key = "inventory_renewal_protection";
    const preview = await previewSetting({ key, proposed: config.inventory.renewalProtection }, {
      [key]: (proposed, input) => previewRenewalStockProtection(key, proposed, { ...input, db: runtime, sourceKey: source }),
    });
    expect(preview).toMatchObject({ validation: { state: "valid", value: config.inventory.renewalProtection } });
    await expect(installRenewalStockProtectionPolicy(runtime, config.inventory.renewalProtection)).rejects.toMatchObject({ code: "42501" });
    await installCheckoutRecoveryReminderSchedule(db, config.checkoutRecoveryReminders);
    const bindings = await composeNativeBindings(url.toString(), createOriginPolicy(config, 4319), config);
    await bindings.close();
  } finally { await runtime.end(); }
});

it.each([0, 3661, null, 14.5])("refuses proposed SQL horizon %s", async days => {
  await expect(db.query(previewStockSql, [source, JSON.stringify([sku]), asOf, days]))
    .rejects.toMatchObject({ code: "22023", message: "inventory_renewal_protection_policy_invalid" });
});

it("preview denies browser roles and uses the caller's stock privileges", async () => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT rolname,
      has_function_privilege(oid,'public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb)','EXECUTE') AS allowed
      FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname`);
    expect(rows).toEqual([{ rolname: "anon", allowed: false }, { rolname: "authenticated", allowed: false }]);
    await client.query(`CREATE ROLE inventory_preview_table_denied NOLOGIN;
      GRANT EXECUTE ON FUNCTION public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb),
        public.inventory_renewal_protection_validate(jsonb) TO inventory_preview_table_denied;
      SET LOCAL ROLE inventory_preview_table_denied`);
    await expect(client.query(previewStockSql, [source, JSON.stringify([sku]), asOf, 14]))
      .rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/^permission denied for table /u) });
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); }
  }
});

it("matches installed availability field for field across instants and horizons with renewal credits", async () => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const original = sqlStatements(readFileSync("db/platform/migrations/20261123130000_inventory_renewal_protection_policy.sql", "utf8"))
      .find(sql => sql.startsWith("CREATE OR REPLACE FUNCTION public.inventory_available_to_promise("))!;
    await client.query(original.replace("public.inventory_available_to_promise(", "public.inventory_before_credit_aggregation("));
    await client.query(`WITH operations AS (
      INSERT INTO public.subscription_renewal_operations (
        subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,
        claim_token,claimed_by,claimed_at,lease_expires_at)
      SELECT s.id, s.next_cycle_at + CASE WHEN l.quantity=15 THEN interval '1 day' ELSE interval '0' END,
        1, 'atp-fixture:' || s.id || ':new', repeat('c',64), '{}', gen_random_uuid(), 'fixture',
        $1::timestamptz, $1::timestamptz + interval '5 minutes'
      FROM public.subscriptions s JOIN public.subscription_renewal_term_lines l ON l.subscription_id=s.id
      WHERE l.sku=$3 AND l.quantity IN (7,13,14,15)
      RETURNING id,subscription_id,operation_fingerprint
    ), terminal AS (
      INSERT INTO public.subscription_cycles (
        subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
      SELECT o.subscription_id, s.next_cycle_at, 'skipped', o.id, o.operation_fingerprint
      FROM operations o JOIN public.subscriptions s ON s.id=o.subscription_id
      JOIN public.subscription_renewal_term_lines l ON l.subscription_id=o.subscription_id
      WHERE l.quantity=13
    ), reservations AS (
      INSERT INTO public.fulfillment_inventory_reservations (
        renewal_operation_id,operation_fingerprint,source_key,status,expires_at,created_at)
      SELECT o.id,o.operation_fingerprint,$2,'held',
        $1::timestamptz + CASE WHEN l.quantity=14 THEN interval '0' ELSE interval '1 day' END,
        $1::timestamptz - interval '1 day'
      FROM operations o JOIN public.subscription_renewal_term_lines l ON l.subscription_id=o.subscription_id
      RETURNING id,operation_fingerprint
    )
    INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity)
    SELECT id,operation_fingerprint,$3,10 FROM reservations`, [asOf, source, sku]);
    const expectPreviewParity = async () => {
      const { rows } = await client.query(`SELECT
        public.inventory_new_purchase_stock_read($1,$2,instant) AS installed,
        public.inventory_new_purchase_stock_preview($1,$2,instant,to_jsonb(public.inventory_renewal_protection_days())) AS proposed
        FROM (VALUES ($3::timestamptz - interval '1 second'), ($3::timestamptz),
          ($3::timestamptz + interval '1 day')) observations(instant)`,
      [source, JSON.stringify([...fixtureSkus, noStockSku, missingSku]), asOf]);
      expect(rows).toHaveLength(3);
      for (const { installed, proposed } of rows) {
        expect(installed).toHaveLength(fixtureSkus.length + 2);
        expect(proposed).toEqual(installed);
      }
    };
    await expectPreviewParity();
    await installRenewalStockProtectionPolicy(client, { revision: "fixture-21", renewalProtectionDays: 21 });
    await expectPreviewParity();
    const { rows } = await client.query(`SELECT mode,
      public.inventory_before_credit_aggregation($1,$2,$3,mode) AS before,
      public.inventory_available_to_promise($1,$2,$3,mode) AS after
      FROM (VALUES (false), (true), (NULL)) AS modes(mode)`, [source, sku, asOf]);
    for (const { mode, before, after } of rows) {
      expect(after).toEqual(before);
      expect(after).toMatchObject({
        available_quantity: mode === true ? 65 : 2,
        hard_hold_quantity: 35,
        soft_subscription_demand_quantity: 63,
      });
    }
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); }
  }
});

it("matches CLI JSON and MCP for a refusal and a 14 to 21 preview with six queries for 1 or 25 SKUs and no writes", async () => {
  const key = "inventory_renewal_protection";
  const current = { revision: "fixture-14", renewalProtectionDays: 14 };
  const proposed = { revision: "fixture-21", renewalProtectionDays: 21 };
  await installRenewalStockProtectionPolicy(db, current);
  const state = async () => (await db.query(`SELECT
    (SELECT jsonb_agg(s ORDER BY key) FROM public.commerce_settings s) AS settings,
    (SELECT jsonb_agg(r ORDER BY id) FROM public.fulfillment_inventory_reservations r) AS reservations,
    (SELECT jsonb_agg(l ORDER BY reservation_id, sku) FROM public.fulfillment_inventory_reservation_lines l) AS reservation_lines,
    (SELECT jsonb_agg(s ORDER BY source_key, sku) FROM public.fulfillment_stock_current s) AS stock`)).rows;
  const before = await state();
  const url = new URL(resource!.connectionString);
  url.username = installation.runtimeLogin;
  url.password = "synthetic-runtime";
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  const runtime = new Pool({ connectionString: url.toString() });
  const instant = new Date(asOf).toISOString();
  const calls: string[] = [];
  const tool = settingsReadTools.find(candidate => candidate.name === "settings__preview")!;
  const server = new Server({ name: "settings-preview-fixture", version: "1" }, { capabilities: { tools: {} } });
  const mcp = new Client({ name: "settings-preview-witness", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    expect(params.name).toBe(tool.name);
    const result = await previewSetting(params.arguments, {
      [key]: (candidate, input) => previewRenewalStockProtection(key, candidate, {
        ...input, sourceKey: source,
        db: { async connect() {
          const client = await runtime.connect();
          return {
            query(sql, params) { calls.push(sql); return client.query(sql, params); },
            release: error => client.release(error),
          };
        } },
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  const preview = async (selected: string[], value = proposed) => {
    const result = await mcp.callTool({ name: tool.name, arguments: { key, proposed: value, skus: selected, asOf: instant } });
    return result.structuredContent;
  };
  try {
    expect((await runtime.query("SELECT session_user AS role")).rows).toEqual([{ role: installation.runtimeLogin }]);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    expect((await mcp.listTools()).tools[0]?.annotations?.readOnlyHint).toBe(true);
    const options = { cwd: fileURLToPath(new URL("../../examples/neutral-store/", import.meta.url)), encoding: "utf8" } as const;
    const unknownKey = "unknown_setting";
    const refused = await mcp.callTool({ name: tool.name, arguments: { key: unknownKey, proposed } });
    expect(refused.structuredContent).toMatchObject({ schemaVersion: 1, refusal: { code: "commerce_setting_unknown" } });
    const cliRefused = spawnSync("npm", ["--silent", "run", "settings", "--", "preview",
      unknownKey, "--value", JSON.stringify(proposed), "--json"], options);
    expect(cliRefused.status, cliRefused.stderr).toBe(1);
    expect(JSON.parse(cliRefused.stdout)).toEqual(refused.structuredContent);

    for (const selected of [[sku], fixtureSkus]) {
      const result = await preview(selected);
      expect(result).toMatchObject({
        key, asOf: instant, current, proposed, difference: { renewalProtectionDays: 7 },
        validation: { state: "valid", value: proposed },
        effect: {
          existingReservations: "unchanged", newPurchaseAvailability: "equal-or-lower",
          skus: expect.arrayContaining([{ sku, source: "provider", stale: false,
            currentAvailableForNewPurchases: 61, proposedAvailableForNewPurchases: 25 }]),
        },
        uncertainty: expect.stringMatching(/estimate at the same instant and in the same snapshot.*Recorded stock and demand can change/u),
      });
      expect(renewalStockProtectionPreviewResult.parse(result).effect.skus).toHaveLength(selected.length);
      expect(calls.splice(0)).toEqual([
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        expect.stringContaining("SELECT value_text FROM public.commerce_settings"),
        expect.stringContaining("SELECT public.inventory_new_purchase_stock_read("),
        expect.stringContaining("SELECT public.inventory_renewal_protection_validate("),
        expect.stringContaining("SELECT public.inventory_new_purchase_stock_preview("),
        "ROLLBACK",
      ]);
      if (selected.length === 1) {
        const args = ["--silent", "run", "settings", "--", "preview", key, "--value", JSON.stringify(proposed),
          "--database-url", url.toString(), "--sku", sku, "--as-of", instant];
        const json = spawnSync("npm", [...args, "--json"], options);
        expect(json.status, json.stderr).toBe(0);
        expect(JSON.parse(json.stdout)).toEqual(result);
        const readable = spawnSync("npm", args, options);
        expect(readable.status, readable.stderr).toBe(0);
        expect(readable.stdout).toContain(`${sku}: 61 currently available`);
        expect(readable.stdout).toContain("New purchase availability: equal-or-lower");
      }
    }
    const stockRow = (result: unknown) => renewalStockProtectionPreviewResult.parse(result).effect.skus.find(row => row.sku === sku);
    expect(stockRow(await preview([sku], current))).toMatchObject({
      currentAvailableForNewPurchases: 61, proposedAvailableForNewPurchases: 61,
    });
    expect(stockRow(await preview([sku], { revision: "shorter", renewalProtectionDays: 7 }))).toMatchObject({
      currentAvailableForNewPurchases: 61, proposedAvailableForNewPurchases: 88,
    });
    const missing = renewalStockProtectionPreviewResult.parse(await preview([noStockSku, missingSku]));
    expect(missing.effect.skus).toEqual([missingSku, noStockSku].map(sku => ({
      sku, source: "missing", stale: false, currentAvailableForNewPurchases: null, proposedAvailableForNewPurchases: null,
    })));
    expect(stockRow(await preview([sku], { revision: "invalid", renewalProtectionDays: 0 }))).toMatchObject({
      currentAvailableForNewPurchases: 61, proposedAvailableForNewPurchases: null,
    });
    for (const entry of corpus) {
      const decoded = JSON.parse(entry.input);
      const expected = entry.decodedNormalized ?? entry.normalized;
      const { structuredContent } = await mcp.callTool({ name: tool.name, arguments: { key, proposed: decoded, asOf: instant } });
      expect(structuredContent, entry.name).toMatchObject({
        schemaVersion: 1, validation: expected ? { state: "valid", value: expected } : { state: "invalid", code: entry.code },
      });
      expect(JSON.stringify(structuredContent), entry.name).toContain(`"proposed":${JSON.stringify(decoded)}`);
      if (decoded === null || typeof decoded !== "object" || entry.decodedNormalized || entry.name === "additional field") {
        const cli = spawnSync("npm", ["--silent", "run", "settings", "--", "preview",
          key, `--value=${entry.input}`, "--database-url", url.toString(), "--as-of", instant, "--json"], options);
        expect(cli.status, cli.stderr).toBe(0);
        expect(JSON.parse(cli.stdout)).toEqual(structuredContent);
      }
    }
  } finally {
    try {
      await mcp.close();
      await server.close();
    } finally {
      await runtime.end();
    }
  }
  expect(await state()).toEqual(before);
});

it("matches the installed stock read with contrasting sources, classes, due terms, cycle statuses, and exposure", async () => {
  const [, sourceSku, packagingSku, pausedSku, foreignTermsSku, paidSku, skippedSku, cancelledSku,
    nullClassSku, cancelledSubscriptionSku] = fixtureSkus;
  const otherSource = "policy-fixture:other";
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Pins the stock source filter: this SKU has a different quantity in the other source.
    await client.query(`INSERT INTO public.fulfillment_stock_current
      (source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,
       last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
      VALUES ($1,$2,37,37,0,'sellable',$3,$3::timestamptz + interval '1 day','fixture','other-source',repeat('a',64))`,
    [otherSource, sourceSku, asOf]);
    // Pins r.source_key=p_source_key in 20261123152000_inventory_new_purchase_stock_preview.sql:29 with a live hold from the other source.
    await client.query(`WITH other_order AS (
      INSERT INTO public.commerce_orders(client_id,currency_code,total_amount_minor)
      SELECT id,'XXX',0 FROM public.clients WHERE email='policy@example.invalid' RETURNING id
    ), other_hold AS (
      INSERT INTO public.fulfillment_inventory_reservations
        (source_key,purchase_order_id,operation_fingerprint,status,expires_at,created_at)
      SELECT $1,id,repeat('b',64),'held',$2::timestamptz + interval '1 day',$2::timestamptz
      FROM other_order RETURNING id
    )
    INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity)
    SELECT id,repeat('b',64),$3,12 FROM other_hold`, [otherSource, asOf, sourceSku]);
    // Pins the sellable inventory-class filter: packaging has 100 units and contributes zero to ATP.
    await client.query("UPDATE public.fulfillment_stock_current SET inventory_class='packaging' WHERE source_key=$1 AND sku=$2",
      [source, packagingSku]);
    // Pins stock.inventory_class='sellable' in 20261123152000_inventory_new_purchase_stock_preview.sql:41 against treating NULL as sellable.
    await client.query("UPDATE public.fulfillment_stock_current SET inventory_class=NULL WHERE source_key=$1 AND sku=$2",
      [source, nullClassSku]);
    for (const [item, subscriptionStatus, termsSource, cycleStatus] of [
      // Pins the active-subscription filter: the paused subscription has due terms.
      [pausedSku, "paused", source, null],
      // Pins s.status='active' in 20261123152000_inventory_new_purchase_stock_preview.sql:49 against admitting cancelled subscriptions with due terms.
      [cancelledSubscriptionSku, "cancelled", source, null],
      // Pins the renewal-terms source match: active demand belongs to another source.
      [foreignTermsSku, "active", otherSource, null],
      // Pins the paid exclusion: this cycle's live hold must not credit its due terms.
      [paidSku, "active", source, "paid"],
      // Pins the skipped exclusion: this cycle's live hold must not credit its due terms.
      [skippedSku, "active", source, "skipped"],
      // Pins the cancelled exclusion: this cycle's live hold must not credit its due terms.
      [cancelledSku, "active", source, "cancelled"],
    ] as const) {
      const subscription = randomUUID();
      await client.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status)
        SELECT $1,id,28,$2::timestamptz,$3 FROM public.clients WHERE email='policy@example.invalid'`,
      [subscription, asOf, subscriptionStatus]);
      await client.query(`INSERT INTO public.subscription_renewal_terms
        (subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
        VALUES ($1,'XXX',$2,'fixture',$3,'fixture')`, [subscription, termsSource, asOf]);
      await client.query(`INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
        VALUES ($1,1,$2,11,100)`, [subscription, item]);
      if (cycleStatus === null) continue;
      const operation = randomUUID();
      await client.query(`INSERT INTO public.subscription_renewal_operations
        (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,
         claim_token,claimed_by,claimed_at,lease_expires_at)
        VALUES ($1::uuid,$2,$3,1,'policy-parity:' || $1::uuid::text,repeat('c',64),'{}',gen_random_uuid(),'fixture',$3,$3::timestamptz + interval '5 minutes')`,
      [operation, subscription, asOf]);
      await client.query(`INSERT INTO public.subscription_cycles
        (subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
        VALUES ($1,$2,$3,$4,repeat('c',64))`, [subscription, asOf, cycleStatus, operation]);
      const reservation = randomUUID();
      await client.query(`INSERT INTO public.fulfillment_inventory_reservations
        (id,renewal_operation_id,operation_fingerprint,source_key,status,expires_at,created_at)
        VALUES ($1,$2,repeat('c',64),$3,'held',$4::timestamptz + interval '1 day',$4)`, [reservation, operation, source, asOf]);
      await client.query(`INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity)
        VALUES ($1,repeat('c',64),$2,4)`, [reservation, item]);
    }
    // Pins exposure's p_source_key and requested.sku arguments in 20261123152000_inventory_new_purchase_stock_preview.sql:55.
    await client.query(`CREATE OR REPLACE FUNCTION public.inventory_channel_exposure_quantity(p_source_key text, p_sku text)
      RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
        SELECT to_jsonb((CASE WHEN p_source_key = '${otherSource}' THEN 10 ELSE 0 END)
                       + (CASE WHEN p_sku = '${sourceSku}' THEN 5 ELSE 3 END));
      $$`);
    // Pins request-SKU de-duplication: the repeated SKU must still produce one result row.
    const { rows } = await client.query(`SELECT
      public.inventory_new_purchase_stock_read(source_key,$2,$3) AS installed,
      public.inventory_new_purchase_stock_preview(source_key,$2,$3,to_jsonb(public.inventory_renewal_protection_days())) AS proposed
      FROM (VALUES (1,$1::text), (2,$4::text)) sources(ordinal,source_key) ORDER BY ordinal`,
    [source, JSON.stringify([...fixtureSkus, sku]), asOf, otherSource]);
    const [primary, other] = rows;
    expect(primary.installed).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: sourceSku, providerForSale: 100, activeHolds: 0, channelExposure: 5, availableForNewPurchases: 95 }),
      ...[packagingSku, nullClassSku].map(item => expect.objectContaining({ sku: item, providerForSale: 100, availableForNewPurchases: 0 })),
      ...[pausedSku, cancelledSubscriptionSku, foreignTermsSku].map(item => expect.objectContaining({
        sku: item, renewalDemand: 0, channelExposure: 3, availableForNewPurchases: 97,
      })),
      ...[paidSku, skippedSku, cancelledSku].map(item => expect.objectContaining({
        sku: item, activeHolds: 4, renewalDemand: 11, availableForNewPurchases: 82,
      })),
    ]));
    expect(other.installed).toContainEqual(expect.objectContaining({
      sku: sourceSku, providerForSale: 37, activeHolds: 12, channelExposure: 15, availableForNewPurchases: 10,
    }));
    for (const { installed, proposed } of rows) {
      expect(installed).toHaveLength(fixtureSkus.length);
      expect(proposed).toEqual(installed);
    }
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); }
  }
});

it("keeps an estimate null for provider stock outside the catalogue and skips estimate queries for empty and invalid requests", async () => {
  const key = "inventory_renewal_protection";
  const value = { revision: "fixture-21", renewalProtectionDays: 21 };
  const uncataloguedSku = `${sku}-UNCATALOGUED`;
  const calls: string[] = [];
  const preview = (skus: string[], proposed = value) => previewSetting({
    key, proposed, skus, asOf: new Date(asOf).toISOString(),
  }, {
    [key]: (candidate, input) => previewRenewalStockProtection(key, candidate, {
      ...input, sourceKey: source,
      db: { async connect() {
        const client = await db.connect();
        return {
          query(statement, params) { calls.push(statement); return client.query(statement, params); },
          release: error => client.release(error),
        };
      } },
    }),
  });
  await db.query(`INSERT INTO public.fulfillment_stock_current
    (source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,
     last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES ($1,$2,17,17,0,'sellable',$3,$3::timestamptz + interval '1 day','fixture','uncatalogued',repeat('a',64))`,
  [source, uncataloguedSku, asOf]);
  try {
    expect(await preview([uncataloguedSku])).toMatchObject({
      validation: { state: "valid" },
      effect: { skus: [{ sku: uncataloguedSku, source: "provider", stale: false,
        currentAvailableForNewPurchases: 17, proposedAvailableForNewPurchases: null }] },
    });
    expect(calls.splice(0)).toContainEqual(expect.stringContaining("SELECT public.inventory_new_purchase_stock_preview("));
    expect(await preview([])).toMatchObject({ validation: { state: "valid" }, effect: { skus: [] } });
    expect(calls.splice(0)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      expect.stringContaining("SELECT value_text FROM public.commerce_settings"),
      expect.stringContaining("SELECT public.inventory_renewal_protection_validate("),
      "ROLLBACK",
    ]);
    expect(await preview([sku], { ...value, renewalProtectionDays: 0 })).toMatchObject({
      validation: { state: "invalid" },
      effect: { skus: [{ sku, currentAvailableForNewPurchases: 61, proposedAvailableForNewPurchases: null }] },
    });
    expect(calls).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      expect.stringContaining("SELECT value_text FROM public.commerce_settings"),
      expect.stringContaining("SELECT public.inventory_new_purchase_stock_read("),
      expect.stringContaining("SELECT public.inventory_renewal_protection_validate("),
      "ROLLBACK",
    ]);
  } finally {
    await db.query("DELETE FROM public.fulfillment_stock_current WHERE source_key=$1 AND sku=$2", [source, uncataloguedSku]);
  }
});

it("the running starter editor sees the installer change from 14 to 21 via readInstalled", async () => {
  const config = structuredClone(selectConfiguration());
  config.inventory.renewalProtection = { revision: "editor-14", renewalProtectionDays: 14 };
  config.purchase.stock.collectedAt = new Date(asOf).toISOString();
  config.purchase.stock.staleAfter = (await db.query("SELECT ($1::timestamptz + interval '1 day') AS instant", [asOf]))
    .rows[0]?.instant.toISOString();
  // The existing installer admits only a database explicitly marked as a disposable demonstration.
  await db.query("COMMENT ON DATABASE postgres IS 'openlup-neutral-store-demo-v1'");
  const installer = await db.connect();
  const demonstration = {
    connection: installer, installRole: "postgres", runtimeRole: "starter_runtime",
    close: async () => installer.release(),
  };
  try {
    await applyDemoSeed(config, demonstration);
    const editorSku = Object.entries(config.purchase.stock.quantities).find(([, quantity]) => quantity > 4)![0];
    const sourceKey = `starter-demo:${config.id}`;
    const subscription = randomUUID();
    const { rows: [saved] } = await installer.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at)
      SELECT $1,id,28,$2::timestamptz + interval '15 days' FROM public.clients WHERE email='policy@example.invalid'
      RETURNING client_id,next_cycle_at`, [subscription, asOf]);
    await installer.query(`INSERT INTO public.subscription_renewal_terms
      (subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
      VALUES ($1,'XXX',$2,'fixture',$3,'fixture')`, [subscription, sourceKey, asOf]);
    await installer.query(`INSERT INTO public.subscription_renewal_term_lines
      (subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES ($1,1,$2,4,100)`, [subscription, editorSku]);

    const url = new URL(resource!.connectionString);
    url.username = "starter_runtime"; url.password = "synthetic-runtime";
    const runtime = new Pool({ connectionString: url.toString() });
    try {
      const now = () => asOf;
      const editor = sizedHostPorts(config, now, runtime);
      const context: Parameters<typeof editor.readCatalog>[1] = {
        subscriptionId: subscription, clientId: saved!.client_id, binding: "sized.v1", templateVersion: 1,
        cadenceDays: 28, compositionConstraint: null, nextCycleAt: saved!.next_cycle_at.toISOString(),
        paidCycleCount: 0, marker: null, lines: [], graduationLines: [],
      };
      const availability = async () => (await editor.readCatalog(runtime, context)).find(fact => fact.sku === editorSku)?.sellableNow;
      const before = config.purchase.stock.quantities[editorSku]!;
      expect(await availability()).toBe(before);
      await installRenewalStockProtectionPolicy(installer, { revision: "editor-21", renewalProtectionDays: 21 });
      expect(await availability()).toBe(before - 4);
      await expect(createPostgresStockAvailability(runtime, { sourceKey, now }).readPort.read({
        skus: [editorSku], horizonDays: 14, excludeOrderId: null,
      })).rejects.toThrow("native_stock_read_options_unsupported");
    } finally {
      await runtime.end();
    }
  } finally {
    await demonstration.close();
  }
});

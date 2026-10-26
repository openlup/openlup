import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertManagedCommerceForward, batchedFunctionDefinitions, readReviewedForwardRegistry, sqlSha256, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { reviewedBatchPaths } from "../../scripts/reviewed-batch-rail.js";
import { imageIo, pullWithRetry, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const commerce = registry.managedCommerceForwards!;
const ninth = commerce.at(-1)!;
const forward = readFileSync(ninth.path, "utf8");
expect(forward).toBe(readFileSync(`scripts/fixtures/reviewed-m11/${ninth.path}`, "utf8"));
const original = new Map<string, string>();
let container: PostgresContainer | undefined;
let pool: Pool;
let db: PoolClient;

beforeAll(async () => {
  readManagedMigrationChain(process.cwd());
  const image = await pullWithRetry(readCiImage("managed-batch-postgres"), imageIo);
  container = await runPostgresContainer({ name: `starter-cadence-${process.pid}`, password: "synthetic-conformance", image });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
  db = await pool.connect();
  await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
  for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
  }
  await db.query("SET ROLE postgres");
  const managedM10 = registry.batchedForwards!.filter(pin => pin.path.startsWith("supabase/"));
  const sources = reviewedBatchPaths(process.cwd(), "supabase/migrations", [...managedM10, ...commerce])
    .filter(path => path < ninth.path).map(path => {
      const pin = commerce.find(pin => pin.path === path);
      const bytes = readFileSync(path);
      if (pin) expect(bytes, path).toEqual(readFileSync(`scripts/fixtures/reviewed-m11/${path}`));
      return { path, bytes };
    });
  expect(sqlSha256(sources[0]!.bytes)).toBe(registry.baselineSha256);
  for (const pin of managedM10) {
    const matching = sources.filter(source => source.path === pin.path);
    expect(matching).toHaveLength(1);
    expect(sqlSha256(matching[0]!.bytes)).toBe(pin.sha256);
  }
  const prior: typeof sources = [];
  for (const source of sources) {
    const pin = commerce.find(pin => pin.path === source.path);
    if (pin === commerce[0]) await db.query("SET check_function_bodies=on; SET search_path=public,extensions");
    if (pin) assertManagedCommerceForward(registry, pin.path, source.bytes, prior);
    for (const statement of sqlStatements(source.bytes.toString(), true)) {
      for (const fn of ninth.functions) if (batchedFunctionDefinitions(Buffer.from(statement), new Set([fn.signature.split("(")[0]!])).has(fn.signature)) original.set(fn.signature, statement);
    }
    await db.query(source.bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    prior.push(source);
  }
  assertManagedCommerceForward(registry, ninth.path, Buffer.from(forward), prior);
  await db.query(forward);
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

async function scoped(action: () => Promise<void>, install = true) {
  await db.query("BEGIN");
  try {
    if (!install) for (const definition of original.values()) await db.query(definition.replace(/^CREATE FUNCTION /u, "CREATE OR REPLACE FUNCTION "));
    await action();
  } finally { await db.query("ROLLBACK"); }
}
const marker = (cadence: unknown, sku: string) => ({
  schemaVersion: "1", starterIntervalDays: 17, basisTemplateVersion: 1,
  delivery2: { discountBps: 1000, discountMinor: 100, basisSubtotalMinor: 1000 },
  graduation: { cadenceDays: cadence, sizeConstraint: { kind: "unit_count", value: 2 }, lines: [
    { sku, qty: 2, sortOrder: 0, isAddon: false, quoteLine: { sku, quantity: 2,
      unitPriceGross: { amountMinor: 500, currency: "XXX" }, lineSubtotalGross: { amountMinor: 1000, currency: "XXX" } } },
  ] },
});
async function fixture() {
  const principal = randomUUID(), sku = randomUUID(), order = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1::uuid,$1::text,'Cadence fixture','active')", [sku]);
  await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
    VALUES($1::uuid,$1::uuid,$1::text,'Cadence fixture','other','active',100,100)`, [sku]);
  await db.query(`INSERT INTO public.commerce_orders(id,client_id,currency,region_code,size_constraint,status)
    VALUES($1,$2,'XXX','ZZ','{"kind":"unit_count","value":1}','draft')`, [order, principal]);
  await db.query(`INSERT INTO public.commerce_order_items(order_id,sku_id,quantity,unit_price_cents,total_cents,
    discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,allocation_ordinal,product_snapshot)
    VALUES($1,$2,1,500,500,0,500,500,0,1,$3)`, [order, sku, JSON.stringify({ sku })]);
  return { principal, sku, order };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function provisional(f: Fixture, cadence: unknown, starter = true) {
  const context = { cadenceDays: 28, ...(starter ? { starterPack: marker(cadence, f.sku) } : {}) };
  return (await db.query("SELECT public.subscription_create_provisional_for_checkout($1,$2,NULL,NULL,$3) AS result",
    [f.order, f.principal, JSON.stringify({ quote: { context } })])).rows[0].result as { subscriptionId: string; subscriptionCycleId: string };
}
async function graduation(f: Fixture, cadence: unknown, mode: string) {
  const subscription = (await db.query(`INSERT INTO public.subscriptions(client_id,cadence_days,currency,region_code,status,
    template_version,starter_pack) VALUES($1,17,'XXX','ZZ','active',1,$2) RETURNING id`, [f.principal, JSON.stringify(marker(cadence, f.sku))])).rows[0].id;
  await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,qty,sort_order,is_addon,template_version)
    VALUES($1,$2,1,0,false,1)`, [subscription, f.sku]);
  return { subscription, apply: async () => (await db.query("SELECT public.subscription_apply_starter_graduation($1,$2,$3) AS result",
    [subscription, `cadence-${subscription}`, mode])).rows[0].result.starterGraduation };
}
async function rejected(action: () => Promise<unknown>, message: string, code = "22023") {
  await db.query("SAVEPOINT expected_refusal");
  try { await expect(action()).rejects.toMatchObject({ code, message }); }
  finally { await db.query("ROLLBACK TO expected_refusal; RELEASE SAVEPOINT expected_refusal"); }
}
async function rows(subscription?: string) {
  return (await db.query(`SELECT s.cadence_days,s.template_version,s.starter_pack,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.subscription_lines l WHERE l.subscription_id=s.id) AS lines,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.subscription_price_agreements a WHERE a.subscription_id=s.id) AS agreements,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.subscription_events e WHERE e.subscription_id=s.id) AS events
    FROM public.subscriptions s WHERE ($1::uuid IS NULL OR s.id=$1) ORDER BY s.id`, [subscription ?? null])).rows;
}

it("refuses 21 before the forward in creation and both application modes", async () => scoped(async () => {
  const f = await fixture();
  await rejected(() => provisional(f, 21), "subscription_starter_pack_invalid_graduation_cadence");
  expect(await rows()).toEqual([]);
  for (const mode of ["full", "cadence_only"]) {
    const g = await graduation(f, 21, mode), before = await rows(g.subscription);
    await rejected(g.apply, "subscription_starter_graduation_invalid_cadence");
    expect(await rows(g.subscription)).toEqual(before);
  }
}, false));

it("preserves every code token except the reviewed cadence predicates and timezone DEFAULT", async () => {
  const statements = sqlStatements(forward);
  const normalize = (sql: string) => sql.replace(/^CREATE OR REPLACE /u, "CREATE ")
    .replace(/^[ \t]*--[^\n]*(?:\n|$)/gmu, "").replace(/\s+/gu, " ").trim();
  for (const fn of ninth.functions) {
    const old = original.get(fn.signature)!;
    expect(sqlSha256(old)).toBe(fn.beforeSha256);
    const expected = old.replaceAll("NOT IN (14, 28)", "NOT IN (14, 21, 28)")
      .replace(/NULL, v_starter_template_version, '[^']+', v_starter_marker/u, "NULL, v_starter_template_version, DEFAULT, v_starter_marker");
    const restated = statements.find(sql => batchedFunctionDefinitions(Buffer.from(sql)).has(fn.signature))!;
    expect(normalize(restated)).toBe(normalize(expected));
    expect(sqlSha256(restated)).toBe(fn.afterSha256);
  }
});

it.each([14, 21, 28])("admits %i in provisional creation with the column timezone default", async cadence => scoped(async () => {
  const f = await fixture();
  const defaultZone = (await db.query("INSERT INTO public.subscriptions(client_id,cadence_days,currency,region_code) VALUES($1,28,'XXX','ZZ') RETURNING timezone", [f.principal])).rows[0].timezone;
  const result = await provisional(f, cadence);
  expect((await db.query("SELECT cadence_days,starter_pack,timezone FROM public.subscriptions WHERE id=$1", [result.subscriptionId])).rows[0])
    .toMatchObject({ cadence_days: 17, starter_pack: marker(cadence, f.sku), timezone: defaultZone });
  expect((await db.query("SELECT status,template_snapshot FROM public.subscription_cycles WHERE id=$1", [result.subscriptionCycleId])).rows[0])
    .toMatchObject({ status: "payment_pending", template_snapshot: { cadence_days: 17 } });
}));

it("uses a changed installation default and preserves ordinary acquisition", async () => scoped(async () => {
  await db.query("ALTER TABLE public.subscriptions ALTER COLUMN timezone SET DEFAULT 'UTC'");
  const f = await fixture(), result = await provisional(f, undefined, false);
  expect((await db.query("SELECT timezone,starter_pack,cadence_days FROM public.subscriptions WHERE id=$1", [result.subscriptionId])).rows)
    .toEqual([{ timezone: "UTC", starter_pack: null, cadence_days: 28 }]);
}));

it.each([7, 30, null, "invalid"])("keeps provisional refusal atomic for %s", async cadence => scoped(async () => {
  const f = await fixture();
  await rejected(() => provisional(f, cadence), "subscription_starter_pack_invalid_graduation_cadence");
  expect(await rows()).toEqual([]);
}));

it.each(["full", "cadence_only"])("admits 14/21/28 in %s with unchanged effects and replay", async mode => scoped(async () => {
  const f = await fixture();
  for (const cadence of [14, 21, 28]) {
    const g = await graduation(f, cadence, mode), before = (await rows(g.subscription))[0];
    expect(await g.apply()).toMatchObject({ applied: true, cadenceDays: cadence, templateVersion: 2,
      reason: mode === "full" ? "graduated" : "cadence_normalized" });
    const after = (await rows(g.subscription))[0];
    expect(after).toMatchObject({ cadence_days: cadence, template_version: 2, starter_pack: before.starter_pack });
    expect(after.lines).toHaveLength(1);
    if (mode === "full") {
      expect(after.lines[0]).toMatchObject({ qty: 2, template_version: 2 });
      expect(after.agreements).toHaveLength(1);
      expect(after.agreements[0]).toMatchObject({ unit_price_gross_minor: 500, template_version: 2 });
      expect(after.events).toHaveLength(1);
      expect(after.agreements[0].event_id).toBe(after.events[0].id);
    } else {
      expect(after.lines).toEqual(before.lines);
      expect(after.agreements).toBeNull();
    }
    expect(after.events).toHaveLength(1);
    expect(await g.apply()).toMatchObject({ applied: false,
      reason: mode === "full" ? "template_version_moved" : "cadence_already_normal" });
    expect(await rows(g.subscription)).toEqual([after]);
  }
}));

it.each(["full", "cadence_only"])("keeps NULL/7/30/non-numeric stored markers refused in %s", async mode => scoped(async () => {
  const f = await fixture();
  for (const cadence of [7, 30, null, "invalid"]) {
    const g = await graduation(f, cadence, mode), before = await rows(g.subscription);
    await rejected(g.apply, cadence === "invalid" ? 'invalid input syntax for type integer: "invalid"' : "subscription_starter_graduation_invalid_cadence", cadence === "invalid" ? "22P02" : "22023");
    expect(await rows(g.subscription)).toEqual(before);
  }
}));

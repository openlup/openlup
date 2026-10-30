import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Client, Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { createManagedCommerceRuntimeOrderPort, createSupabaseCommerceReturnsPort } from "@openlup/platform/commerce/server";
import { CommerceRuntimeConflictError, type CommerceReturnsPort, type FinalizedCheckoutOrder } from "@openlup/platform/commerce";
import { createPostgresCommerceReturnsPort } from "../../server/adapters/postgres/returnsControl.js";
import { assertManagedCommerceForward, readReviewedForwardRegistry, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";

import { assertManagedAcquisition } from "./reviewedBatchCatalog.js";

const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const pins = registry.managedCommerceForwards!;
const probes = ["commerce_returns_core_test.sql", "commerce_returns_outbox_test.sql",
  "commerce_new_purchase_stock_test.sql", "commerce_starter_cadence_test.sql",
  "configurator_intent_default_shipping_address_test.sql", "subscription_finalize_provisional_test.sql",
  "subscription_starter_pack_marker_test.sql"];
let container: PostgresContainer | undefined;
let pool: Pool;
let db: PoolClient;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `commerce-managed-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: 120_000 });
  db = await pool.connect();
  await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
  for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
  }
  await db.query("SET ROLE postgres");
  const prior: { path: string; bytes: Buffer }[] = [];
  for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
    const path = `supabase/migrations/${name}`, bytes = readFileSync(path);
    const pin = pins.find(pin => pin.path === path);
    if (pin) {
      expect(bytes, path).toEqual(readFileSync(`scripts/fixtures/reviewed-m11/${path}`));
      assertManagedCommerceForward(registry, path, bytes, prior);
    }
    await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    prior.push({ path, bytes });
  }
  expect(prior.filter(source => pins.some(pin => pin.path === source.path))).toHaveLength(pins.length);
  await db.query(`RESET ROLE; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
    DO $$ DECLARE fn regprocedure; BEGIN
      FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
        JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass
        JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgtap' AND d.deptype='e'
      LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC',fn); END LOOP;
    END $$; SET ROLE postgres; SET search_path=public,extensions; SET statement_timeout='30s'; SET lock_timeout='5s'`);
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
function tapLines(result: QueryResult | QueryResult[]) {
  return (Array.isArray(result) ? result : [result]).flatMap(part => part.rows.flatMap(row => Object.values(row)))
    .filter((value): value is string => typeof value === "string" && /^(?:ok |not ok |1\.\.|#)/u.test(value));
}
async function reset() { await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres; SET search_path=public,extensions"); }
it.each(probes)("managed commerce behavior: %s", async file => {
  try {
    const tap = tapLines(await db.query(readFileSync(`supabase/tests/${file}`, "utf8")));
    expect(tap.filter(line => /^not ok |^# (?:Looks like|Failed)/u.test(line)), tap.join("\n")).toEqual([]);
    const count = tap.filter(line => /^ok /u.test(line)).length;
    expect(count).toBeGreaterThan(0);
    expect(tap).toContain(`1..${count}`);
    process.stdout.write(`${file}: ${count} pgTAP assertions PASS\n`);
  } finally { await reset(); }
}, 120_000);

async function headerWitness() {
  for (const pin of pins) for (const fn of pin.functions) {
    const sql = sqlStatements(readFileSync(pin.path, "utf8")).find(sql => /^CREATE (?:OR REPLACE )?FUNCTION /u.test(sql)
      && sql.includes(`${fn.signature.split("(")[0]}(`))!;
    const header = sql.slice(0, sql.search(/\bAS \$/u));
    const row = (await db.query(`SELECT prosecdef,proconfig,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) a
        WHERE grantee=0 AND privilege_type='EXECUTE') public_execute
      FROM pg_proc WHERE oid=$1::regprocedure`, [fn.signature])).rows[0];
    expect(row.prosecdef, fn.signature).toBe(/SECURITY DEFINER/u.test(header));
    const path = /SET search_path\s*(?:=|TO)\s*([\s\S]*)/u.exec(header)![1].trim()
      .split(",").map(value => value.trim().replaceAll("'", "")).join(", ");
    expect(row.proconfig, fn.signature).toEqual([`search_path=${path}`]);
    expect(row.public_execute, fn.signature).toBe(false);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, fn.signature])).rows[0].allowed)
        .toBe(role === "service_role" && !fn.signature.startsWith("private."));
    }
  }
  await db.query("BEGIN");
  try {
    for (const pin of pins) for (const fn of pin.functions) for (const role of ["anon", "authenticated"]) {
      const [name, args] = fn.signature.slice(0, -1).split("(");
      await db.query("SAVEPOINT acl_refusal");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await expect(db.query(`SELECT ${name}(${args.split(",").map(type => `NULL::${type}`).join(",")})`))
          .rejects.toMatchObject({ code: "42501" });
      } finally { await db.query("ROLLBACK TO acl_refusal; RELEASE SAVEPOINT acl_refusal"); }
    }
  } finally { await reset(); }
}
it("binds every commerce header and denies browser/PUBLIC execution", headerWitness, 120_000);
it.each([
  ["service-only ACL", "GRANT EXECUTE ON FUNCTION public.inventory_new_purchase_stock_read(jsonb,timestamptz) TO anon"],
  ["definer header", "ALTER FUNCTION public.commerce_return_request_create(text,uuid,jsonb,text,text,uuid) SECURITY INVOKER"],
])("header/ACL witness rejects removal of %s", async (_name, mutation) => {
  await db.query("BEGIN");
  try {
    await db.query(mutation);
    await expect(headerWitness()).rejects.toMatchObject({ name: "AssertionError" });
  } finally { await reset(); }
}, 120_000);
it("executes acquisition finalize under both policy states, locking, atomic refusal, replay and one-time", async () => {
  await db.query("BEGIN");
  try { await assertManagedAcquisition(db, container!.connectionString); }
  finally { await reset(); }
}, 120_000);

type ReturnFixture = { principal: string; foreign: string; order: string; foreignOrder: string; item: string };
async function returnFixture(): Promise<ReturnFixture> {
  const principal = randomUUID(), foreign = randomUUID(), client = randomUUID(), other = randomUUID(), order = randomUUID(), foreignOrder = randomUUID(), item = randomUUID();
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [principal, foreign]);
  await db.query("INSERT INTO public.clients(id,email,auth_user_id) VALUES($1,$2,$3),($4,$5,$6)",
    [client, `${client}@example.invalid`, principal, other, `${other}@example.invalid`, foreign]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency,region_code,metadata) VALUES($1,$2,'paid','XXX','ZZ','{}'),($3,$4,'paid','XXX','ZZ','{}')", [order, client, foreignOrder, other]);
  await db.query(`INSERT INTO public.commerce_order_items(id,order_id,quantity,unit_price_cents,total_cents,
    discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,product_snapshot)
    VALUES($1,$2,3,100,300,0,300,300,0,'{"sku":"SYNTHETIC-RETURN"}')`, [item, order]);
  return { principal, foreign, order, foreignOrder, item };
}
const command = (db: Pick<Client, "query">, f: ReturnFixture, key: string, principal = f.principal, order = f.order, quantity = 1) =>
  db.query("SELECT public.commerce_return_request_create($1,$2,$3,'damaged',NULL,$4) result",
    [key, order, JSON.stringify([{ orderItemId: f.item, quantity }]), principal]).then(result => result.rows[0].result);
async function effects() {
  const result: Record<string, unknown> = {};
  for (const { tablename } of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const name = String(tablename).replaceAll('"', '""');
    result[tablename] = (await db.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),
      'xmin',t.xmin::text,'ctid',t.ctid::text) ORDER BY to_jsonb(t)::text,t.ctid),'[]'::jsonb) rows FROM public."${name}" t`)).rows[0];
  }
  return result;
}
async function serviceCommand(f: ReturnFixture, key: string, principal = f.principal, order = f.order, quantity = 1) {
  await db.query("SET LOCAL ROLE service_role");
  return command(db, f, key, principal, order, quantity);
}
async function refused(f: ReturnFixture, key: string, principal: string, order = f.order, quantity = 1) {
  const before = await effects();
  await db.query("SAVEPOINT return_refusal");
  try { await expect(serviceCommand(f, key, principal, order, quantity)).rejects.toMatchObject({ code: "22023", message: "commerce_return_request_order_not_found" }); }
  finally { await db.query("ROLLBACK TO return_refusal; RELEASE SAVEPOINT return_refusal; SET LOCAL ROLE postgres"); }
  expect(await effects()).toEqual(before);
}
async function ownershipWitness() {
  const f = await returnFixture();
  await refused(f, "return-fresh-foreign", f.foreign);
  const original = await serviceCommand(f, "return-owner-key");
  await db.query("SET LOCAL ROLE postgres");
  expect(original.replayed).toBe(false);
  const before = await effects();
  expect(await serviceCommand(f, "return-owner-key")).toEqual({ ...original, replayed: true });
  await db.query("SET LOCAL ROLE postgres");
  expect(await effects()).toEqual(before);
  await refused(f, "return-owner-key", f.foreign);
  await refused(f, "return-owner-key", f.foreign, f.foreignOrder);
  await refused(f, "return-owner-key", f.principal, f.order, 2);
}
it("refuses foreign fresh/replayed commands and changed replay with full row snapshots", async () => {
  await db.query("BEGIN");
  try { await ownershipWitness(); } finally { await reset(); }
}, 120_000);

it("serializes concurrent service calls to one durable request/line/operation", async () => {
  const f = await returnFixture(), key = randomUUID();
  const clients = Array.from({ length: 2 }, () => new Client({ connectionString: container!.connectionString,
    connectionTimeoutMillis: 5_000, query_timeout: 10_000 }));
  try {
    await Promise.all(clients.map(async client => { await client.connect(); await client.query("SET ROLE service_role; SET statement_timeout='8s'; SET lock_timeout='5s'"); }));
    const pids = await Promise.all(clients.map(async client => (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid));
    await Promise.all(clients.map(client => client.query("BEGIN")));
    const first = await command(clients[0], f, key);
    const duplicate = command(clients[1], f, key).then(value => ({ value }), error => ({ error }));
    const deadline = performance.now() + 4_000;
    let blocked = false;
    while (performance.now() < deadline) {
      blocked = (await db.query("SELECT $1::int=ANY(pg_blocking_pids($2)) blocked", pids)).rows[0].blocked;
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(blocked, "duplicate call waits on the first transaction's real lock").toBe(true);
    await clients[0].query("COMMIT");
    const second = await duplicate;
    if ("error" in second) throw second.error;
    await clients[1].query("COMMIT");
    const results = [first, second.value];
    expect(results.map(result => result.replayed)).toEqual([false, true]);
    expect(results[0].returnRequestId).toBe(results[1].returnRequestId);
    expect((await db.query(`SELECT (SELECT count(*)::int FROM public.commerce_return_requests WHERE idempotency_key=$1) requests,
      (SELECT count(*)::int FROM public.commerce_return_lines WHERE return_request_id=$2) lines,
      (SELECT count(*)::int FROM public.commerce_return_operations WHERE return_request_id=$2) operations`, [key, results[0].returnRequestId])).rows)
      .toEqual([{ requests: 1, lines: 1, operations: 1 }]);
  } finally {
    await closePostgres(undefined, undefined, clients.map(client => async () => {
      try { await client.query("ROLLBACK"); } finally { await client.end(); }
    }));
  }
}, 120_000);

it.each([
  ["fresh owner binding", "AND client_id = v_client_id FOR UPDATE", "FOR UPDATE"],
  ["command fingerprint", "IF v_prior_fingerprint IS DISTINCT FROM v_fingerprint THEN", "IF false THEN"],
])("return behavior rejects removal of %s", async (_name, from, to) => {
  await db.query("BEGIN");
  try {
    const original = (await db.query("SELECT pg_get_functiondef('public.commerce_return_request_create(text,uuid,jsonb,text,text,uuid)'::regprocedure) body")).rows[0].body;
    expect(original).toContain(from);
    await db.query(original.replace(from, to));
    await expect(ownershipWitness()).rejects.toMatchObject({ name: "AssertionError" });
  } finally { await reset(); }
}, 120_000);

it.each([
  { name: "new-purchase renewal protection", signature: "public.inventory_new_purchase_stock_read(jsonb,timestamptz)",
    from: "(sku.id,p_as_of,false)", to: "(sku.id,p_as_of,true)", file: "commerce_new_purchase_stock_test.sql", assertion: "stock seam subtracts" },
  { name: "starter initial cadence", signature: "public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)",
    from: "p_client_id, p_pet_id, v_cadence_days,", to: "p_client_id, p_pet_id, 28,", file: "commerce_starter_cadence_test.sql", assertion: "starter provisional creation" },
  { name: "starter graduation cadence", signature: "public.subscription_apply_starter_graduation(uuid,text,text)",
    from: "cadence_days = v_cadence_days", to: "cadence_days = 14", file: "commerce_starter_cadence_test.sql", assertion: "graduation preserves" },
])("behavioral assertions reject removal of $name", async mutant => {
  await db.query("BEGIN");
  try {
    const original = (await db.query("SELECT pg_get_functiondef($1::regprocedure) body", [mutant.signature])).rows[0].body;
    expect(original).toContain(mutant.from);
    await db.query(original.replaceAll(mutant.from, mutant.to));
    const sql = readFileSync(`supabase/tests/${mutant.file}`, "utf8").replace(/^BEGIN;$/mu, "").replace(/^ROLLBACK;$/mu, "");
    const tap = tapLines(await db.query(sql));
    expect(tap.find(line => /^not ok /u.test(line) && line.includes(mutant.assertion)), tap.join("\n")).toBeDefined();
  } finally { await reset(); }
}, 120_000);

// SQL transport only: package adapters own argument translation, parsing and errors.
async function serviceQuery(text: string, values?: unknown[]) {
  await db.query("SAVEPOINT managed_port_call; SET LOCAL ROLE service_role");
  try {
    expect((await db.query("SELECT current_user AS caller")).rows[0].caller).toBe("service_role");
    const result = await db.query(text, values);
    await db.query("SET LOCAL ROLE postgres; RELEASE SAVEPOINT managed_port_call");
    return result;
  } catch (error) {
    await db.query("ROLLBACK TO managed_port_call; RELEASE SAVEPOINT managed_port_call");
    throw error;
  }
}
const rpc = { async rpc(name: string, args: Record<string, unknown>) {
  expect(["commerce_return_request_create", "commerce_finalize_order_for_checkout"]).toContain(name);
  const keys = Object.keys(args);
  const placeholders = keys.map((key, index) => `"${key}" => $${index + 1}`).join(",");
  try {
    const result = await serviceQuery(`SELECT public.${name}(${placeholders}) AS response`,
      keys.map(key => typeof args[key] === "object" && args[key] !== null ? JSON.stringify(args[key]) : args[key]));
    return { data: result.rows[0].response, error: null };
  } catch (error) {
    return { data: null, error: error as { code: string; message: string } };
  }
} };
const returnsPorts = {
  managed: createSupabaseCommerceReturnsPort(rpc),
  postgres: createPostgresCommerceReturnsPort({ query: serviceQuery }),
};
async function returnPortWitness(kind: keyof typeof returnsPorts) {
  const port: CommerceReturnsPort = returnsPorts[kind];
  const f = await returnFixture();
  const input = { idempotencyKey: randomUUID(), orderId: f.order, requestedBy: f.principal,
    reasonCode: "damaged" as const, lines: [{ orderItemId: f.item, quantity: 1 }] };
  const refuse = async (command: typeof input) => {
    const before = await effects();
    const action = port.createRequest(command);
    if (kind === "managed") await expect(action).rejects.toThrow("commerce_return_request_create_failed:22023");
    else await expect(action).rejects.toMatchObject({ code: "22023", message: "commerce_return_request_order_not_found" });
    expect(await effects()).toEqual(before);
  };
  await refuse({ ...input, requestedBy: f.foreign });
  const original = await port.createRequest(input);
  expect(original).toEqual({ returnRequestId: expect.any(String), status: "requested", replayed: false });
  const before = await effects();
  expect(await port.createRequest(input)).toEqual({ ...original, replayed: true });
  expect(await effects()).toEqual(before);
  await refuse({ ...input, requestedBy: f.foreign });
  await refuse({ ...input, requestedBy: f.foreign, orderId: f.foreignOrder });
  await refuse({ ...input, lines: [{ ...input.lines[0], quantity: 2 }] });
  expect((await db.query("SELECT count(*)::int n FROM public.commerce_return_requests WHERE idempotency_key=$1", [input.idempotencyKey])).rows[0].n).toBe(1);
}
it.each(["managed", "postgres"] as const)("%s returns port preserves ownership, replay and refusal errors", async kind => {
  await db.query("BEGIN");
  try { await returnPortWitness(kind); } finally { await reset(); }
}, 120_000);

it.each([
  ["owner binding", "AND client_id = v_client_id FOR UPDATE", "FOR UPDATE"],
  ["command fingerprint", "IF v_prior_fingerprint IS DISTINCT FROM v_fingerprint THEN", "IF false THEN"],
])("the returns port witness rejects removal of %s", async (_name, from, to) => {
  await db.query("BEGIN");
  try {
    const original = (await db.query("SELECT pg_get_functiondef('public.commerce_return_request_create(text,uuid,jsonb,text,text,uuid)'::regprocedure) body")).rows[0].body as string;
    expect(original).toContain(from);
    await db.query(original.replace(from, to));
    for (const kind of ["managed", "postgres"] as const) {
      await db.query("SAVEPOINT returns_port_mutant");
      try { await expect(returnPortWitness(kind)).rejects.toMatchObject({ name: "AssertionError" }); }
      finally { await db.query("ROLLBACK TO returns_port_mutant; RELEASE SAVEPOINT returns_port_mutant"); }
    }
  } finally { await reset(); }
}, 120_000);

const finalizePort = createManagedCommerceRuntimeOrderPort<Record<string, unknown>, FinalizedCheckoutOrder<string>>(rpc, {
  finalizeArgs: request => request,
  responseEnvelopeSchema: z.object({ contractVersion: z.literal("commerce.v0") }).passthrough(),
});
async function checkoutFixture() {
  const client = randomUUID(), address = randomUUID(), sku = randomUUID();
  await db.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES ('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text`);
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query(`INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country)
    VALUES($1,$2,'shipping','Synthetic 1','Synthetic','00000','ZZ')`, [address, client]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Synthetic','active')", [sku, sku]);
  await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,net_weight_g,kcal_per_unit,status)
    VALUES($1,$1,$2,'Synthetic','other',1,1,'active')`, [sku, sku]);
  const request = async (extra: Record<string, unknown> = {}) => {
    const quote = { quote: { context: { mode: "subscription", cadenceDays: 28, ...extra }, lines: [], discounts: [] } };
    const draft = { items: [{ sku, quantity: 1 }] };
    const order = (await db.query(`INSERT INTO public.commerce_orders(client_id,currency,region_code,status,subtotal_cents,total_cents,metadata)
      VALUES($1,'XXX','ZZ','draft',1000,1000,jsonb_build_object('quoteSnapshot',$2::jsonb,'orderDraftSnapshot',$3::jsonb)) RETURNING id`, [client, quote, draft])).rows[0].id;
    await db.query(`INSERT INTO public.commerce_order_items(order_id,quantity,unit_price_cents,total_cents,
      discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,allocation_ordinal,product_snapshot)
      VALUES($1,1,1000,1000,0,1000,1000,0,1,$2)`, [order, { sku }]);
    return { p_idempotency_key: randomUUID(), p_order_id: order, p_mode: "subscription_cycle", p_client_id: client,
      p_shipping_address_id: address, p_pet_id: null, p_quote_snapshot: quote, p_order_draft_snapshot: draft,
      p_metadata: { checkoutCommandVersion: "commerce.checkout_command.v1" } };
  };
  return { sku, request };
}
async function finalizePortWitness() {
  const f = await checkoutFixture();
  const assertCreated = async (request: Awaited<ReturnType<typeof f.request>>) => {
    const result = await finalizePort.finalizeOrderForCheckout(request);
    expect(result).toMatchObject({ orderId: request.p_order_id, mode: "subscription_cycle", replayed: false,
      subscriptionId: expect.any(String), subscriptionCycleId: expect.any(String), items: [{ sku: f.sku, quantity: 1 }] });
    expect((await db.query("SELECT status,cadence_days FROM public.subscriptions WHERE id=$1", [result.subscriptionId])).rows)
      .toEqual([{ status: "pending_activation", cadence_days: 28 }]);
    const before = await effects();
    expect(await finalizePort.finalizeOrderForCheckout(request)).toEqual({ ...result, replayed: true });
    expect(await effects()).toEqual(before);
    return result;
  };
  await assertCreated(await f.request());
  await db.query(`INSERT INTO public.promotions(name,trigger_type,discount_type,discount_value,applies_to_kind,
    applies_to_payload,stacking_rule,eligibility,valid_from,redemption_limit_per_customer,region_availability,
    status,promotion_engine_version,benefit_lane,benefit_kind,benefit_value_bps)
    VALUES('Synthetic acquisition','automatic','percentage',37,'order_total',
      '{"cart_mode":"subscription","acquisitionTerms":{"schemaVersion":"subscription-acquisition.v1","revision":"synthetic-port","delivery2DiscountBps":1700}}',
      'exclusive','{"first_subscription_purchase":true}','2000-01-01T00:00:00Z',1,ARRAY['ZZ'],
      'active','promotion-engine.v2','product','target_percentage',3700)`);
  const selected = (await db.query("SELECT public.commerce_subscription_acquisition_terms(now()) terms")).rows[0].terms;
  const terms = Object.fromEntries(Object.entries(selected).filter(([key]) => !["kind", "legacyPairCount", "standaloneCount", "nextBoundaryAt"].includes(key)));
  const refuse = async (extra: Record<string, unknown>) => {
    const request = await f.request(extra), before = await effects();
    await expect(finalizePort.finalizeOrderForCheckout(request)).rejects.toBeInstanceOf(CommerceRuntimeConflictError);
    await expect(finalizePort.finalizeOrderForCheckout(request)).rejects.toMatchObject({
      details: { code: "55000", reason: "acquisition_terms_changed" },
    });
    expect(await effects()).toEqual(before);
  };
  await refuse({});
  const pricingPolicy = { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" };
  await refuse({ acquisitionTerms: { ...terms, revision: "stale" }, pricingPolicy });
  const request = await f.request({ acquisitionTerms: terms, pricingPolicy });
  const created = await assertCreated(request);
  await db.query("UPDATE public.promotions SET applies_to_payload=jsonb_set(applies_to_payload,'{acquisitionTerms,revision}','\"revised-port\"') WHERE name='Synthetic acquisition'");
  const before = await effects();
  expect(await finalizePort.finalizeOrderForCheckout(request)).toEqual({ ...created, replayed: true });
  expect(await effects()).toEqual(before);
  await refuse({ acquisitionTerms: terms, pricingPolicy });
}
it("managed finalize port admits both policy states and maps atomic acquisition conflicts", async () => {
  await db.query("BEGIN");
  try { await finalizePortWitness(); } finally { await reset(); }
}, 120_000);

async function starterPortWitness() {
  const f = await checkoutFixture();
  const starterPack = { schemaVersion: "1", starterIntervalDays: 21, basisTemplateVersion: 1,
    delivery2: { discountBps: 1000, discountMinor: 100, basisSubtotalMinor: 1000 },
    graduation: { cadenceDays: 21, sizeConstraint: { kind: "unit_count", value: 2 }, lines: [
      { sku: f.sku, qty: 2, sortOrder: 0, isAddon: false, quoteLine: { sku: f.sku, quantity: 2,
        unitPriceGross: { amountMinor: 500, currency: "XXX" }, lineSubtotalGross: { amountMinor: 1000, currency: "XXX" } } },
    ] } };
  const request = await f.request({ starterPack });
  const result = await finalizePort.finalizeOrderForCheckout(request);
  expect((await db.query("SELECT cadence_days,starter_pack FROM public.subscriptions WHERE id=$1", [result.subscriptionId])).rows)
    .toEqual([{ cadence_days: 21, starter_pack: starterPack }]);
  expect((await db.query("SELECT template_snapshot->>'cadence_days' cadence FROM public.subscription_cycles WHERE id=$1", [result.subscriptionCycleId])).rows)
    .toEqual([{ cadence: "21" }]);
  const before = await effects();
  expect(await finalizePort.finalizeOrderForCheckout(request)).toEqual({ ...result, replayed: true });
  expect(await effects()).toEqual(before);
}
it("managed finalize port creates a provisional subscription with the retained 21-day starter", async () => {
  await db.query("BEGIN");
  try { await starterPortWitness(); } finally { await reset(); }
}, 120_000);
it.each([
  { name: "acquisition admission", signature: "private.commerce_assert_acquisition_admission(jsonb,uuid)",
    from: /AS (\$[a-z_0-9]*\$)[\s\S]*\1/u, to: "AS $$ BEGIN RETURN; END; $$", witness: finalizePortWitness },
  { name: "starter cadence", signature: "public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)",
    from: "p_client_id, p_pet_id, v_cadence_days,", to: "p_client_id, p_pet_id, 28,", witness: starterPortWitness },
])("the finalize port witness rejects removal of $name", async mutant => {
  await db.query("BEGIN");
  try {
    const original = (await db.query("SELECT pg_get_functiondef($1::regprocedure) body", [mutant.signature])).rows[0].body as string;
    const changed = original.replace(mutant.from, () => mutant.to);
    expect(changed).not.toBe(original);
    await db.query(changed);
    await expect(mutant.witness()).rejects.toMatchObject({ name: "AssertionError" });
  } finally { await reset(); }
}, 120_000);

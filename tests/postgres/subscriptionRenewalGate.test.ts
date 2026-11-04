import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import { AT, call, later, renewal } from "./subscriptionNativeFixture.js";

const pairs = [
  ["fulfillment_reserve_subscription_renewal", "uuid,uuid,integer,timestamptz", "'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',900,now()"],
  ["fulfillment_release_subscription_renewal", "uuid,uuid,text,timestamptz", "'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','synthetic',now()"],
  ["fulfillment_expire_subscription_renewals", "timestamptz,integer", "now(),100"],
  ["subscription_stock_wait_admit", "jsonb,jsonb,timestamptz", "'{}'::jsonb,'{}'::jsonb,now()"],
  ["subscription_stock_wait_recover_refusal", "uuid,text,text,timestamptz", "NULL,'synthetic','synthetic',now()"],
  ["subscription_stock_wait_deficits", "jsonb,uuid,timestamptz", "'{\"lines\":[{\"sku\":\"synthetic\",\"quantity\":1}],\"stockSourceKey\":\"synthetic\"}'::jsonb,NULL,now()"],
] as const;
const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "renewal_gate_runtime", restoreLogin: "renewal_gate_restore" } as const;
const forward = readFileSync("db/platform/migrations/20261101230000_subscription_renewal_terminal_replay.sql", "utf8");
let container: PostgresContainer | undefined, owner: Pool, migration: Pool, runtime: Pool;
let beforeAcl: Record<string, unknown>[], priorRuntime: Record<string, unknown>[];
async function acl(db: { query(text: string, values?: unknown[]): Promise<QueryResult> }) {
  return (await db.query(`SELECT p.oid::regprocedure::text AS signature,p.proowner::regrole::text AS owner,
    ARRAY(SELECT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)||':'||a.privilege_type||':'||a.is_grantable
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a ORDER BY 1) AS privileges
    FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY signature`, [pairs.map(([name, args]) => `public.${name}(${args})`)])).rows;
}
beforeAll(async () => {
  container = await runPostgresContainer({ name: `renewal-gate-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  owner = new Pool({ connectionString: container.connectionString });
  for (const role of [installation.runtimeLogin, installation.restoreLogin]) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  migration.on("connect", (db: PoolClient) => {
    const query = db.query.bind(db);
    db.query = (async (text: string, values?: unknown[]) => {
      if (text === forward && !beforeAcl) {
        beforeAcl = await acl({ query });
        priorRuntime = (await query("SELECT signature,has_function_privilege('service_role',signature,'EXECUTE') AS allowed FROM unnest($1::text[]) signature", [pairs.map(([name, args]) => `public.${name}(${args})`)])).rows;
      }
      return query(text, values);
    }) as typeof db.query;
  });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migration }).apply();
  const url = new URL(container.connectionString); url.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: url.toString(), options: "-c role=service_role" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [owner, migration, runtime]); }, postgresTeardownTimeoutMs);

it("preserves all original ACLs and invoker headers without adding a runtime helper grant", async () => {
  expect((await runtime.query("SELECT current_user,session_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows)
    .toEqual([{ current_user: "service_role", session_user: installation.runtimeLogin, elevated: false }]);
  expect(priorRuntime).toHaveLength(6);
  expect(priorRuntime.every(row => row.allowed)).toBe(true);
  expect(await acl(owner)).toEqual(beforeAcl);
  for (const [name, args] of pairs) {
    expect((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [`public.${name}(${args})`])).rows).toEqual([{ allowed: true }]);
    expect((await owner.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [`public.${name}(${args})`])).rows)
      .toEqual([{ prosecdef: false, proconfig: ["search_path=pg_catalog"] }]);
    expect((await owner.query("SELECT to_regprocedure($1) AS wrapper", [`public.${name}_gated(${args})`])).rows).toEqual([{ wrapper: null }]);
  }
});
it("keeps each inline admission block text-identical to the characterized helper", () => {
  const helper = readFileSync("db/platform/migrations/20261101224000_new_purchase_inventory_reservations.sql", "utf8");
  const block = /DECLARE prior_ms integer;\nBEGIN\n[\s\S]*?\nEND;/.exec(helper)![0];
  const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
  for (const [name] of pairs) {
    const start = forward.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const statement = forward.slice(start, forward.indexOf("$$;", start));
    const blocks = statement.match(/DECLARE prior_ms integer;\nBEGIN\n[\s\S]*?\nEND;/g);
    expect(blocks).toHaveLength(1);
    // A nested variable scope is the only adaptation; every declaration and statement is copied.
    expect(normalized(blocks![0])).toBe(normalized(block));
    expect(statement).not.toContain("PERFORM public.inventory_admission_try_enter()");
  }
});
it.each(["anon", "authenticated"])("keeps %s denied the shared helper", async role => {
  expect((await owner.query("SELECT has_function_privilege($1,'public.inventory_admission_try_enter()','EXECUTE') AS allowed", [role])).rows).toEqual([{ allowed: false }]);
});
it("keeps the admission helper owner-only", async () => {
  await expect(runtime.query("SELECT public.inventory_admission_try_enter()")) .rejects.toMatchObject({ code: "42501" });
});
it("records the residual PUBLIC EXECUTE on the original reserve, release and expiry routines", async () => {
  for (const [name, args] of pairs.slice(0, 3)) {
    expect((await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`, [`public.${name}(${args})`])).rows).toEqual([{ allowed: true }]);
  }
});
it.each(pairs)("fences %s before every stock write while admission is busy", async (name, _args, values) => {
  const db = await owner.connect(), before = await allPublicRows(owner);
  try {
    await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(846832106,1)");
    await expect(runtime.query(`SELECT public.${name}(${values})`)).rejects.toMatchObject({ code: "55P03", message: "inventory_admission_busy" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await allPublicRows(owner)).toEqual(before);
});
it.each(pairs)("refuses unsupported isolation in %s before every delegated write", async (name, _args, values) => {
  const db = await runtime.connect(), before = await allPublicRows(owner);
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await expect(db.query(`SELECT public.${name}(${values})`)).rejects.toMatchObject({ code: "22023", message: "inventory_admission_isolation_unsupported" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await allPublicRows(owner)).toEqual(before);
});

// The transaction overlap is deterministic; existing two-session gate cases run below one second.
it.each(["purchase", "renewal"] as const)("retries the sole busy side after concurrent %s admission without duplicate stock effects", async winner => {
  const f = await renewal(owner), sku = f.snapshot.lines[0].sku;
  const skuId = (await owner.query("SELECT id FROM public.catalog_skus WHERE sku=$1", [sku])).rows[0].id;
  const orderId = randomUUID(), itemId = randomUUID();
  await owner.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',0)", [orderId, f.client]);
  await owner.query("INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,$3,1,8,0,0)", [itemId, orderId, skuId]);
  const purchaseArgs = [randomUUID(), orderId, f.source, JSON.stringify([{ orderItemId: itemId, skuId, quantity: 8 }]), "created", later(1), "{}", AT];
  const reserve = (db: Pool | PoolClient, kind: "purchase" | "renewal") => kind === "purchase"
    ? call(db, "fulfillment_reserve_purchase_order_items", purchaseArgs)
    : call(db, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  const loser = winner === "purchase" ? "renewal" : "purchase", a = await runtime.connect();
  try {
    await a.query("BEGIN");
    const accepted = await reserve(a, winner);
    expect(accepted).toMatchObject(winner === "purchase" ? { status: "reserved" } : { reserved: true });
    expect((await a.query("SELECT count(*)::integer AS held FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=846832106 AND objid=1 AND granted")).rows).toEqual([{ held: 1 }]);
    const before = await allPublicRows(owner);
    const busy = await reserve(runtime, loser).then(() => null, (error: unknown) => error);
    expect(busy).toMatchObject({ code: "55P03", message: "inventory_admission_busy" });
    expect([accepted, busy].filter(value => value?.code === "55P03")).toHaveLength(1);
    expect(await allPublicRows(owner)).toEqual(before);
    await a.query("COMMIT");
    expect(await reserve(runtime, loser)).toMatchObject(loser === "purchase" ? { status: "reserved" } : { reserved: true });
    expect(await call(runtime, "inventory_available_to_promise", [f.source, sku, AT, true]))
      .toMatchObject({ hard_hold_quantity: 10, available_quantity: 0 });
    expect((await runtime.query("SELECT sum(l.quantity)::integer AS units FROM public.fulfillment_inventory_reservations r JOIN public.fulfillment_inventory_reservation_lines l ON l.reservation_id=r.id WHERE r.source_key=$1 AND r.status='held'", [f.source])).rows).toEqual([{ units: 10 }]);
  } finally { await a.query("ROLLBACK"); a.release(); }
}, 30_000);

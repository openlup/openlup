import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
beforeAll(async () => {
 container = await runManagedCompatPostgres({ name: `g3-donor-${process.pid}`, password: "synthetic-conformance" });
 expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
 pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
 db = await pool.connect();
 await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
 for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
 }
 await db.query("SET ROLE postgres");
 await db.query(readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql", "utf8").replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
 await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
it.each([["operator_change_shipping_address_test.sql",39],["subscription_change_shipping_address_test.sql",17]] as const)("executes the explicit managed witness %s", async (file, count) => {
 const response = await db.query(readFileSync(`supabase/tests/${file}`, "utf8"));
 const results = Array.isArray(response) ? response : [response];
 const lines: string[] = results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) => Object.values(row).filter((v): v is string => typeof v === "string")));
 expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
 expect(lines.filter(line => /^(?:ok|not ok) \d+/u.test(line))).toHaveLength(count);
});
it("characterizes the address exemption during dunning, cycle-lock precedence, and donor event-only replay", async () => {
 const fixture = readFileSync("supabase/tests/operator_change_shipping_address_test.sql", "utf8").split("CREATE TEMP TABLE _saved AS")[0]!.replace("SELECT plan(39);", "");
 await db.query(fixture);
 try {
  const sub = "07200000-0000-4000-8000-000000000001", client = "07100000-0000-4000-8000-000000000001";
  const order = "07700000-0000-4000-8000-000000000001", cycle = "07600000-0000-4000-8000-000000000001";
  const payment = randomUUID(), intent = randomUUID();
  await db.query("INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency) VALUES($1,$2,'synthetic','failed',100,'XTS')", [payment, order]);
  await db.query("INSERT INTO public.commerce_payment_intents(id,target_kind,order_id,subscription_id,subscription_cycle_id,payment_id,status,amount_cents,currency) VALUES($1,'subscription_cycle',$2,$3,$4,$5,'failed',100,'XTS')", [intent, order, sub, cycle, payment]);
  await db.query("INSERT INTO public.subscription_dunning_cases(subscription_id,cycle_id,order_id,payment_intent_id,client_id,retry_attempt) VALUES($1,$2,$3,$4,$5,1)", [sub, cycle, order, intent, client]);
  await db.query("UPDATE public.subscriptions SET payment_method_ref=NULL,payment_method_kind=NULL WHERE id=$1", [sub]);
  const before = (await db.query("SELECT cadence_days,next_cycle_at,template_version FROM public.subscriptions WHERE id=$1", [sub])).rows;
  const actor = "07000000-0000-4000-8000-000000000001", key = `donor-${randomUUID()}`;
  const invoke = (k: string, address: string) => db.query("SELECT public.customer_self_service_apply_subscription_action($1,$2,$3,'change_shipping_address',jsonb_build_object('shippingAddressId',$4::text),'2026-09-01') result", [actor, k, sub, address]);
  const address = "07300000-0000-4000-8000-000000000002";
  await invoke(key, address);
  // Managed replay is event/key-only, even with changed payload; native deliberately compares it.
  await invoke(key, "07300000-0000-4000-8000-000000000001");
  expect((await db.query("SELECT shipping_address_id FROM public.subscriptions WHERE id=$1", [sub])).rows[0].shipping_address_id).toBe(address);
  expect((await db.query("SELECT cadence_days,next_cycle_at,template_version FROM public.subscriptions WHERE id=$1", [sub])).rows).toEqual(before);
  expect((await db.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.address_changed'", [sub])).rows).toEqual([{ n: 1 }]);
  await db.query("INSERT INTO public.subscription_cycles(subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key) VALUES($1,2,'2026-09-15','paid','donor-locked-cycle')", [sub]);
  await db.query("SAVEPOINT refusal");
  await expect(invoke(`locked-${randomUUID()}`, address)).rejects.toMatchObject({ message: "customer_self_service_payment_blocked" });
  await db.query("ROLLBACK TO SAVEPOINT refusal");
 } finally { await db.query("ROLLBACK"); }
});

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { AT, call, failure, later, prepareOriginal, renewal } from "./subscriptionNativeFixture.js";

export const lifecycleForward = "db/platform/migrations/20261106100000_subscription_lifecycle_closure.sql";
export const lifecycleProfiles = ["legacy", "qualified-v2", "qualified-admin"] as const;
// Fixtures use explicit UTC; individual cases select their own named database zones.
export const lifecycleTimeZone = "UTC";
export type LifecycleProfile = typeof lifecycleProfiles[number];
const priorInventories = {
  "legacy": "835f39ab94ae1340e90f95353e7f3c854466bc666b95efb01439b28f4ce2fda5",
  "qualified-v2": "110468fa4e15f48e27a8bf2f22ccc4021d03ec0986f9cbb677643a322ae870ae",
  "qualified-admin": "67f5e319f3724f45e1136ad939b11150a07e64d79bfacf746e05c9e28de46fdf"
} as const;
export async function lifecycleInstallation(profile: LifecycleProfile) {
  const container = await runPostgresContainer({ name: `lifecycle-closure-${profile}-${process.pid}`, password: "synthetic-conformance" });
  const root = mkdtempSync(join(tmpdir(), `lifecycle-prefix-${profile}-`));
  const pools: Pool[] = [];
  const pool = (connectionString: string, options?: string) => { const p = new Pool({ connectionString, options: `${options ?? ""} -c timezone=${lifecycleTimeZone}` }); pools.push(p); return p; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Lifecycle PostgreSQL unavailable");
    const owner = pool(container.connectionString), password = randomUUID();
    const m = "lifecycle_m", r = "lifecycle_r", s = "lifecycle_s";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (profile === "qualified-admin") {
      await owner.query(`CREATE ROLE ${m} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    }
    if (profile !== "legacy") for (const name of [r, s]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === "legacy" ? { generation: "legacy" }
      : { generation: profile, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: profile === "qualified-admin" ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const url = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const migration = pool(url, installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation)
      : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    const prefix = structuredClone(manifest);
    prefix.objectInventorySha256 = priorInventories.legacy;
    prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = priorInventories["qualified-v2"];
    prefix.qualifiedAdmin.objectInventorySha256.installerManaged = priorInventories["qualified-admin"];
    for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
      // The frozen prefix ends before this forward; later appended forwards are not part of it.
      const end = plan.forward.findIndex((entry: { file: string }) => entry.file === lifecycleForward);
      if (end < 0) throw new Error("lifecycle forward missing from the manifest plan");
      plan.forward = plan.forward.slice(0, end);
      for (const entry of [plan.baseline, ...plan.forward]) {
        const target = resolve(root, entry.file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(entry.file));
      }
    }
    mkdirSync(resolve(root, "config"), { recursive: true }); writeFileSync(resolve(root, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
    const runner = (sourceRoot = process.cwd()) => createPostgresMigrationRunner({ connectionString: url }, { root: sourceRoot, installation, poolFactory: () => migration });
    await runner(root).apply();
    const catalog = async () => (await owner.query(`SELECT oid::regprocedure::text AS signature,proowner,proacl::text,prosecdef,proconfig,provolatile,proparallel
      FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid`, [[
      "public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
      "public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz)",
      "public.customer_subscription_pause_as_actor(uuid,text,text,text)"]])).rows;
    const guard = async () => ({
      function: (await owner.query("SELECT pg_get_functiondef('public.commerce_order_assert_line_sum()'::regprocedure) AS definition")).rows,
      triggers: (await owner.query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgname IN ('trg_commerce_orders_line_sum','trg_commerce_order_items_line_sum') ORDER BY tgname`)).rows,
    });
    const bodies = async () => (await owner.query(`SELECT oid::regprocedure::text AS signature,prosrc AS body,
      encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS body_sha256,pg_get_functiondef(oid) AS installed_definition
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY oid::regprocedure::text`, [[
      "subscription_command_apply", "subscription_apply_lifecycle_action", "customer_subscription_pause_as_actor",
      "subscription_pause_close_recovery", "subscription_terminalize_unpaid_artifacts"]])).rows;
    const before = await catalog(), guardBefore = await guard(), bodiesBefore = await bodies();
    await runner().apply();
    const after = await catalog(), guardAfter = await guard(), bodiesAfter = await bodies();
    const runtime = profile === "legacy" ? owner : pool(login(r), "-c role=service_role");
    return { owner, migration, runtime, before, after, guardBefore, guardAfter, bodiesBefore, bodiesAfter, runner: runner(), profile,
      close: async () => { try { await closePostgres(container, pools); } finally { rmSync(root, { recursive: true, force: true }); } },
      async actor<T>(principal: string, work: (client: PoolClient) => Promise<T>) {
        // Owner is fixture setup only until SET ROLE; the operation has exactly actor privileges.
        const db = await owner.connect();
        try { await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated");
          await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
          const value = await work(db); await db.query("COMMIT"); return value;
        } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
      } };
  } catch (error) { try { await closePostgres(container, pools); } finally { rmSync(root, { recursive: true, force: true }); } throw error; }
}
export type LifecycleInstallation = Awaited<ReturnType<typeof lifecycleInstallation>>;
export async function lifecycleSubject(owner: Pool) {
  const f = await renewal(owner);
  await owner.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
  const actor = randomUUID();
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [actor, `${actor}@example.invalid`]);
  await owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, actor]);
  await owner.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01T00:00:00Z' WHERE id=$1", [f.subscription, later(240)]);
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  return { ...f, actor };
}
export async function lifecycleDeclined(owner: Pool) {
  const f = await renewal(owner), original = await prepareOriginal(owner, f);
  await owner.query("UPDATE public.subscriptions SET started_at='2026-01-01T00:00:00Z' WHERE id=$1", [f.subscription]);
  await call(owner, "subscription_retry_apply_failure", [f.operation, `failure:${f.operation}`, failure()]);
  const advanced = await call(owner, "subscription_retry_open_case", [f.operation, "failed", "/recover"]);
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  const caseId = String(advanced.caseId), tokenHash = randomUUID().replaceAll("-", "").repeat(2);
  const expiresAt = (await owner.query("SELECT now()+interval '30 days' AS at")).rows[0].at.toISOString();
  await call(owner, "dunning_lifecycle_issue_recovery_token", [caseId, tokenHash, expiresAt]);
  const token = (await owner.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [tokenHash])).rows[0].id;
  return { ...f, original, caseId, token, actor: randomUUID() };
}
export async function lifecycleRows(owner: Pool, omitReceipt = false) {
  const output: Record<string, unknown> = {};
  const tables = ["subscriptions", "subscription_cycles", "commerce_orders", "commerce_order_items", "commerce_settlement_intents", "subscription_retry_obligations",
    "subscription_retry_receipts", "subscription_retry_recovery_authorizations", "subscription_dunning_cases", "subscription_dunning_notifications", "commerce_checkout_recovery_tokens",
    "subscription_pause_windows", "subscription_events", "fulfillment_inventory_reservations", "subscription_renewal_operations", "payment_truth_events"];
  if (!omitReceipt) tables.push("subscription_command_receipts");
  for (const table of tables) output[table] = (await owner.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return output;
}
export { AT, call, later };

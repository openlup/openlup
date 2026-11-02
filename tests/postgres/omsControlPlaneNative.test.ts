import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresCommerceOmsControlPlane } from "../../server/adapters/postgres/omsControlPlane.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "oms_owner", bootstrapLogin: "postgres", runtimeLogin: "oms_runtime", restoreLogin: "oms_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
const units = [selected.baseline, ...selected.forward];
let container: PostgresContainer | undefined;
const pools: Pool[] = [];
let owner: Pool, runtime: Pool;
let port: ReturnType<typeof createPostgresCommerceOmsControlPlane>;
const visible: string[] = [], hidden: string[] = [];
const markers: Record<string, string>[] = [
  { supersededByStableJourneyKey: "synthetic-successor" },
  { checkoutAbandoned: "checkout_journey_consumed" },
];
type Fact = "none" | "created" | "settled" | "captured" | "indeterminate" | "refused";

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Native OMS proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `m19-g12p-${process.pid}`, password: "synthetic-oms" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native OMS PostgreSQL unavailable");
  const pool = (connectionString: string) => { const result = new Pool({ connectionString }); pools.push(result); return result; };
  const bootstrap = pool(container.connectionString);
  await bootstrap.query(`CREATE ROLE oms_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-oms';
    ALTER DATABASE postgres OWNER TO oms_owner;
    CREATE ROLE oms_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-oms';
    CREATE ROLE oms_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-oms'`);
  const url = (login: string, startup = false) => {
    const value = new URL(container!.connectionString); value.username = login;
    if (startup) value.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    return value.toString();
  };
  owner = pool(url(selection.migrationLogin, true));
  const runner = createPostgresMigrationRunner({ connectionString: url(selection.migrationLogin) }, { installation: selection, poolFactory: () => owner });
  expect((await runner.apply()).applied).toEqual(units.map(unit => unit.file));
  expect((await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual(units.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
  expect((await runner.apply()).applied).toEqual([]);
  runtime = pool(url(selection.runtimeLogin));
  expect((await runtime.query(`SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows)
    .toEqual([{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
  for (const table of ["commerce_settlement_intents", "payment_truth_events"]) {
    expect((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS readable", [`public.${table}`])).rows)
      .toEqual([{ readable: true }]);
  }
  expect((await owner.query("SELECT to_regclass('public.commerce_payments') AS relation")).rows).toEqual([{ relation: null }]);
  // Column-level read through the actual restricted login; no fixture grants.
  await runtime.query("SELECT renewal_operation_id FROM public.commerce_orders LIMIT 0");
  port = createPostgresCommerceOmsControlPlane(runtime);
  for (const marker of markers) {
    for (const fact of ["none", "created", "settled", "captured", "indeterminate", "refused"] as const) {
      const id = await order(marker);
      if (fact !== "none") await moneyFact(id, fact);
      (["settled", "captured", "indeterminate"].includes(fact) ? visible : hidden).push(id);
    }
  }
  for (const marker of markers) visible.push(await order(marker, "cancelled", await preparedRenewal()));
  // Missing and non-matching marker metadata must not become SQL-NULL exclusions.
  visible.push(await order({}), await order({ checkoutAbandoned: "other" }));
  visible.push(await order(markers[0], "pending_payment"), await order(markers[1], "pending_payment"));
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, pools), postgresTeardownTimeoutMs);

async function order(metadata: Record<string, string>, status = "cancelled", renewal: string | null = null): Promise<string> {
  const id = randomUUID();
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor,metadata,renewal_operation_id,renewal_operation_fingerprint)
      VALUES($1,$2,'XTS',1000,$3::jsonb,$4,$5)`, [id, status, JSON.stringify(metadata), renewal, renewal ? "b".repeat(64) : null]);
    await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      VALUES($1,1,1,1000,1000)`, [id]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  return id;
}

async function preparedRenewal(): Promise<string> {
  const client = randomUUID(), subscription = randomUUID(), operation = randomUUID();
  await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-12-01')", [subscription, client]);
  await owner.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,
    identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,attempt_prepared_at)
    VALUES($1,$2,'2026-12-01',1,$3,$4,'{}','attempt_prepared',$5,'synthetic-oms',now(),now()+interval '1 hour',now())`,
  [operation, subscription, `subscription:${subscription}:cycle:2026-12-01T00:00:00.000Z`, "b".repeat(64), randomUUID()]);
  return operation;
}

async function moneyFact(orderId: string, fact: Exclude<Fact, "none">): Promise<void> {
  const intent = randomUUID();
  await owner.query(`INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at)
    VALUES($1,$2,'synthetic-oms',$3,1000,'XTS',$4,CASE WHEN $3='settled' THEN now() ELSE NULL END)`,
  [intent, orderId, fact === "settled" ? "settled" : "created", `synthetic-oms:${intent}`]);
  if (fact === "settled" || fact === "created") return;
  await owner.query(`INSERT INTO public.payment_truth_events(source_event_id,event_fingerprint,ingest_idempotency_key,
    settlement_intent_id,outcome,amount_minor,currency_code,failure_class,source_evidence,occurred_at)
    VALUES($1,$2,$1,$3,$4,1000,'XTS',$5,'{}',now())`,
  [randomUUID(), "a".repeat(64), intent, fact, fact === "refused" ? "authorization_refused" : null]);
}

it("keeps native settled or possibly captured money visible for both markers with exact list/count and repeat reads", async () => {
  const request = { view: "control_plane_v1" as const, page: 1, pageSize: 50 };
  const result = await port.listOrders(request);
  expect(result.orders.map(row => row.orderId).sort()).toEqual([...visible].sort());
  expect(result.totalCount).toBe(visible.length);
  expect(result.totalCount).toBe(result.orders.length);
  expect(await port.listOrders(request)).toEqual(result);
  const cancelled = await port.listOrders({ ...request, status: "cancelled" });
  expect(cancelled.totalCount).toBe(visible.length - 2);
  expect(cancelled.totalCount).toBe(cancelled.orders.length);
  const pages: string[] = [];
  for (let page = 1; page <= Math.ceil(visible.length / 3); page++) {
    const chunk = await port.listOrders({ ...request, page, pageSize: 3 });
    expect(chunk.totalCount).toBe(visible.length);
    pages.push(...chunk.orders.map(row => row.orderId));
  }
  expect(pages).toEqual(result.orders.map(row => row.orderId));
});

it("reads reduced native detail by id including a hidden marker and returns null for a missing order", async () => {
  const result = await port.getOrderDetail({ view: "control_plane_v1", orderId: hidden[0] });
  expect(result).toMatchObject({ contractVersion: "commerce.oms_control_plane.v1",
    order: { orderId: hidden[0], status: "cancelled", money: { amountMinor: 1000, currency: "XTS" }, activeHoldCount: 0 },
    holds: [], operations: [] });
  expect(await port.getOrderDetail({ view: "control_plane_v1", orderId: randomUUID() })).toBeNull();
});

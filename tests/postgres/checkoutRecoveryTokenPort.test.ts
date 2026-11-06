// Characterization of order-scoped recovery using the installed native rail.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createPostgresRoleFreeTransactionLane, type PgQueryExecutor,
} from "@openlup/platform/data";
import {
  createPostgresCheckoutRecoveryTokenPort, generateCheckoutRecoveryToken,
  hashCheckoutRecoveryToken, classifyCheckoutRecoveryTokenState,
} from "@openlup/platform/commerce/server";
import { qualifiedPostgresStartupOptions } from "@openlup/platform/migrations";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const exec = promisify(execFile);
const volume = `m19-st-rec-${process.pid}-${randomUUID()}`;
let volumeCreated = false;
let container: PostgresContainer | undefined;
let admin: Pool;
let migration: Pool;
let runtime: Pool;
let lane: ReturnType<typeof createPostgresRoleFreeTransactionLane>;
let port: ReturnType<typeof createPostgresCheckoutRecoveryTokenPort>;
const queries: Array<{ sql: string; values?: unknown[] }> = [];
const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "postgres", runtimeLogin: "recovery_runtime", restoreLogin: "recovery_restore" } as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Recovery token proof requires Docker PostgreSQL");
  await exec("docker", ["volume", "create", volume]);
  volumeCreated = true;
  container = await runPostgresContainer({ name: `m19-st-rec-${process.pid}`, password: "synthetic-conformance",
    runOptions: ["--mount", `type=volume,source=${volume},target=/var/lib/postgresql/recovery-data`,
      "-e", "PGDATA=/var/lib/postgresql/recovery-data/data"],
  });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Recovery PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query(`CREATE ROLE recovery_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only';
    CREATE ROLE recovery_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, {
    installation: selection, poolFactory: () => migration,
  });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString);
  url.username = "recovery_runtime"; url.password = "synthetic-only";
  runtime = new Pool({ connectionString: url.toString() });
  lane = createPostgresRoleFreeTransactionLane({ connectionString: url.toString() }, { poolFactory: () => runtime });
  port = createPostgresCheckoutRecoveryTokenPort({
    run: work => lane.run(gateway => work({ query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return (gateway as PgQueryExecutor).query(sql, values);
    } })),
  });
}, postgresSetupTimeoutMs);

afterAll(async () => {
  try { await closePostgres(container, [admin, migration, runtime]); }
  finally {
    if (volumeCreated) {
      await exec("docker", ["volume", "rm", volume]);
      await expect(exec("docker", ["volume", "inspect", volume])).rejects.toMatchObject({ code: 1 });
    }
  }
}, postgresTeardownTimeoutMs);

async function order(options: { clientless?: boolean; principal?: string; status?: string; old?: boolean; subscription?: boolean } = {}) {
  const clientId = options.clientless ? null : randomUUID();
  const orderId = randomUUID();
  if (clientId) await admin.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",
    [clientId, `${clientId}@example.invalid`, options.principal ?? null]);
  const context = { mode: options.subscription ? "subscription" : "one_time", cadenceDays: options.subscription ? 35 : null };
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,created_at,currency_code,total_amount_minor,metadata)
      VALUES($1,$2,$3,clock_timestamp() - $4::interval,'USD',1000,$5::jsonb)`,
    [orderId, clientId, options.status ?? "pending_payment", options.old ? "25 hours" : "1 minute",
      JSON.stringify({ orderDraftSnapshot: { context }, quoteSnapshot: { quote: { context } } })]);
    await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      VALUES($1,1,1,1000,1000)`, [orderId]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  if (options.subscription) await runtime.query("SELECT public.subscription_declare_provisional_activation($1,$2,35)", [`declare-${orderId}`, orderId]);
  return { orderId, clientId };
}
const issue = (orderId: string, rawToken = generateCheckoutRecoveryToken()) =>
  port.issue({ orderId, rawToken, expiresAt: "2099-01-01T00:00:00Z" });
async function actor<T>(principal: string, work: (db: PoolClient) => Promise<T>) {
  const db = await runtime.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
    return await work(db);
  } finally { await db.query("ROLLBACK"); db.release(); }
}

it("issues for an unlinked contact with only a hash and the exact database deadline", async () => {
  const o = await order(); const raw = generateCheckoutRecoveryToken();
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  try {
    const id = await issue(o.orderId, raw);
    const result = (await admin.query(`SELECT token.*, token.expires_at = orders.created_at + interval '24 hours' AS exact,
        client.principal_id FROM public.commerce_checkout_recovery_tokens token
        JOIN public.commerce_orders orders ON orders.id=token.order_id
        JOIN public.clients client ON client.id=token.client_id WHERE token.id=$1`, [id])).rows[0];
    expect(result).toMatchObject({ id, order_id: o.orderId, client_id: o.clientId,
      principal_id: null, token_hash: hashCheckoutRecoveryToken(raw), revoked_at: null, exact: true });
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(JSON.stringify(queries)).not.toContain(raw);
    expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toContain(raw);
    expect(id).not.toContain(raw);
    expect(await port.validate(raw)).toMatchObject({ orderId: o.orderId, mode: "one_time_order" });
  } finally { logs.forEach(log => log.mockRestore()); }
  await actor(randomUUID(), async db => {
    expect((await db.query("SELECT public.customer_checkout_recovery_find_as_actor($1) AS found", [o.orderId])).rows[0].found).toBeNull();
    await expect(db.query("SELECT public.customer_checkout_recovery_token_issue_as_actor($1,$2,now()+interval '1 hour')",
      [o.orderId, hashCheckoutRecoveryToken(generateCheckoutRecoveryToken())])).rejects.toMatchObject({ code: "22023" });
  });
});

it("replays without rotation, rejects cross-order reuse and rotates only a fresh hash", async () => {
  const a = await order(); const b = await order(); const raw = generateCheckoutRecoveryToken();
  const id = await issue(a.orderId, raw);
  expect(await issue(a.orderId, raw)).toBe(id);
  await expect(issue(b.orderId, raw)).rejects.toThrow("checkout_recovery_hash_conflict");
  expect((await admin.query("SELECT count(*)::int AS count FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [a.orderId])).rows[0].count).toBe(1);
  const fresh = generateCheckoutRecoveryToken(); const next = await issue(a.orderId, fresh);
  expect(next).not.toBe(id);
  expect(await port.inspect(raw)).toMatchObject({ tokenState: "revoked" });
  expect(await port.validate(raw)).toBeNull();
  expect(await issue(a.orderId, raw)).toBe(id);
  expect(await port.validate(fresh)).toMatchObject({ tokenId: next });
  const replays = await Promise.all(Array.from({ length: 8 }, () => issue(a.orderId, fresh)));
  expect(new Set(replays)).toEqual(new Set([next]));
});

it.each([{ clientless: true }, { status: "paid" }, { status: "cancelled" }, { old: true }])(
  "refuses unrecoverable order %j without inserting", async options => {
    const o = await order(options);
    await expect(issue(o.orderId)).rejects.toThrow("checkout_recovery_order_not_recoverable");
    expect((await admin.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [o.orderId])).rows).toEqual([]);
  },
);

it("preserves native state priority, refuses unknown hashes and presents paid links without payment authority", async () => {
  const o = await order(); const raw = generateCheckoutRecoveryToken(); const id = await issue(o.orderId, raw);
  expect(await port.inspect("missing")).toBeNull();
  expect(await port.validate("missing")).toBeNull();
  expect(await port.inspect(raw)).toMatchObject({ tokenState: "active" });
  await admin.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1", [o.orderId]);
  const paid = await port.inspect(raw);
  expect(paid).toMatchObject({ tokenState: "order_not_recoverable", status: "paid", orderId: o.orderId });
  expect(classifyCheckoutRecoveryTokenState(paid!.tokenState)).toBe("continuation");
  expect(await port.validate(raw)).toBeNull();
  expect(await port.inspect(raw, new Date("2100-01-01T00:00:00Z"))).toMatchObject({ tokenState: "expired" });
  await admin.query("UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=clock_timestamp() WHERE id=$1", [id]);
  expect(await port.inspect(raw, new Date("2100-01-01T00:00:00Z"))).toMatchObject({ tokenState: "revoked" });
  expect(queries.some(q => /customer_checkout_recovery_settle|issue_as_actor|find_as_actor/.test(q.sql))).toBe(false);
});

it("retains initial subscription mode and cadence before paid activation and across a new port", async () => {
  const o = await order({ subscription: true }); const raw = generateCheckoutRecoveryToken(); await issue(o.orderId, raw);
  expect((await admin.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [o.orderId])).rows[0].subscription_cycle_id).toBeNull();
  expect((await runtime.query("SELECT public.customer_checkout_recovery_token_inspect($1) AS value", [hashCheckoutRecoveryToken(raw)])).rows[0].value.mode).toBe("one_time_order");
  const restarted = createPostgresCheckoutRecoveryTokenPort(lane);
  expect(await restarted.inspect(raw)).toMatchObject({ mode: "subscription_cycle", cadenceDays: 35, subscriptionId: null, tokenState: "active" });
  expect(await restarted.validate(raw)).toMatchObject({ mode: "subscription_cycle" });
  await admin.query("UPDATE public.commerce_orders SET metadata='{}' WHERE id=$1", [o.orderId]);
  expect(await restarted.inspect(raw)).toMatchObject({ mode: "subscription_cycle", cadenceDays: 35 });
  const quoted = await order(); const quoteRaw = generateCheckoutRecoveryToken();
  await admin.query("UPDATE public.commerce_orders SET metadata=$2::jsonb WHERE id=$1", [quoted.orderId,
    JSON.stringify({ quoteSnapshot: { quote: { context: { mode: "subscription", cadenceDays: 35 } } } })]);
  await issue(quoted.orderId, quoteRaw);
  expect(await restarted.inspect(quoteRaw)).toMatchObject({ mode: "subscription_cycle", cadenceDays: 35 });
});

it.each(["paid", "cancelled"])("waits for the canonical order lock and refuses after concurrent %s", async status => {
  const o = await order(); const db = await runtime.connect();
  let mint: Promise<string> | undefined;
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [o.orderId]);
    mint = issue(o.orderId);
    // Handle rejection immediately while preserving it for the later assertion.
    mint.catch(() => {});
    // Observe an actual blocked row-lock waiter, not an arbitrary sleep.
    let blocked = false;
    for (let tries = 0; tries < 100 && !blocked; tries++) {
      blocked = (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='recovery_runtime'
        AND wait_event_type='Lock' AND query LIKE '%FROM public.commerce_orders WHERE id =%') AS blocked`)).rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    if (status === "paid") {
      const intent = randomUUID();
      await db.query(`INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
        VALUES($1,$2,'sandbox',1000,'USD',$3)`, [intent, o.orderId, `intent-${intent}`]);
      await db.query("SELECT public.commerce_record_settlement($1,$2,'succeeded')", [`settle-${intent}`, intent]);
    } else await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [o.orderId]);
    await db.query("COMMIT");
    await expect(mint).rejects.toThrow("checkout_recovery_order_not_recoverable");
    expect((await admin.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [o.orderId])).rows).toEqual([]);
  } finally { await db.query("ROLLBACK"); db.release(); await mint?.catch(() => {}); }
});

it("uses effective installer-managed grants and refuses both browser roles at the adapter and table", async () => {
  const grants = (await runtime.query(`SELECT current_user, pg_has_role(current_user,'service_role','USAGE') AS service,
    has_table_privilege(current_user,'public.commerce_checkout_recovery_tokens','SELECT,INSERT,UPDATE') AS tokens,
    has_table_privilege(current_user,'public.subscription_activations','SELECT') AS declarations`)).rows[0];
  expect(grants).toMatchObject({ current_user: "recovery_runtime", service: true, tokens: true, declarations: true });
  const o = await order();
  for (const role of ["anon", "authenticated"]) {
    const browser = createPostgresCheckoutRecoveryTokenPort({ run: work => lane.run(async gateway => {
      const db = gateway as PgQueryExecutor;
      await db.query(`SET LOCAL ROLE ${role}`);
      return work(db);
    }) });
    await expect(browser.issue({ orderId: o.orderId, rawToken: generateCheckoutRecoveryToken(), expiresAt: "2099-01-01" })).rejects.toThrow("checkout_recovery_service_required");
    await expect(browser.inspect("missing")).rejects.toThrow("checkout_recovery_service_required");
    const db = await runtime.connect();
    try {
      await db.query("BEGIN"); await db.query(`SET LOCAL ROLE ${role}`);
      expect((await db.query("SELECT has_table_privilege(current_user,'public.commerce_checkout_recovery_tokens','INSERT') AS allowed")).rows[0].allowed).toBe(false);
      await expect(db.query("SELECT public.customer_checkout_recovery_token_inspect($1)", [hashCheckoutRecoveryToken("missing")])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("ROLLBACK"); db.release(); }
  }
});

it("characterizes unchanged actor rotation and case-bound dunning refusals", async () => {
  const principal = randomUUID(); const o = await order({ principal });
  await actor(principal, async db => {
    expect((await db.query("SELECT public.customer_checkout_recovery_find_as_actor($1) AS found", [o.orderId])).rows[0].found.orderId).toBe(o.orderId);
    for (const value of ["actor-first", "actor-second"]) await db.query(
      "SELECT public.customer_checkout_recovery_token_issue_as_actor($1,$2,now()+interval '1 hour')",
      [o.orderId, hashCheckoutRecoveryToken(value)]);
    expect((await db.query("SELECT public.customer_checkout_recovery_find_as_actor($1) AS found", [o.orderId])).rows[0].found.orderId).toBe(o.orderId);
  });
  // Actor work above rolled back; test its committed rotation in one owned transaction.
  const db = await runtime.connect();
  try {
    await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal })]);
    for (const value of ["actor-first", "actor-second"]) await db.query(
      "SELECT public.customer_checkout_recovery_token_issue_as_actor($1,$2,now()+interval '1 hour')", [o.orderId, hashCheckoutRecoveryToken(value)]);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await port.inspect("actor-first")).toMatchObject({ tokenState: "revoked" });
  expect(await port.inspect("actor-second")).toMatchObject({ tokenState: "active" });
  await expect(runtime.query("SELECT public.dunning_lifecycle_issue_recovery_token($1,$2,now()+interval '1 hour')",
    [randomUUID(), hashCheckoutRecoveryToken("dunning-missing")])).rejects.toThrow("subscription_dunning_case_not_found");
});

it("keeps the existing dunning issuer case-bound and rotating", async () => {
  const o = await order(); const subscription = randomUUID(); const cycle = randomUUID(); const caseId = randomUUID();
  await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days) VALUES($1,$2,35)", [subscription, o.clientId]);
  await admin.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,clock_timestamp(),'planned')", [cycle, subscription]);
  await admin.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [o.orderId, cycle]);
  await admin.query(`INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,idempotency_key)
    VALUES($1,$2,$3,$4,$5)`, [caseId, subscription, cycle, o.clientId, `case-${caseId}`]);
  for (const raw of ["dunning-first", "dunning-second"]) {
    expect((await runtime.query("SELECT public.dunning_lifecycle_issue_recovery_token($1,$2,now()+interval '1 hour') AS value",
      [caseId, hashCheckoutRecoveryToken(raw)])).rows[0].value).toMatchObject({ issued: true, orderId: o.orderId });
  }
  const states = (await runtime.query(`SELECT token_hash,revoked_at IS NOT NULL AS revoked
    FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1`, [o.orderId])).rows;
  expect(states).toEqual(expect.arrayContaining([
    { token_hash: hashCheckoutRecoveryToken("dunning-first"), revoked: true },
    { token_hash: hashCheckoutRecoveryToken("dunning-second"), revoked: false },
  ]));
});

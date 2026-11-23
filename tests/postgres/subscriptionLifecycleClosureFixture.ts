import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import {
  createNativeRenewalCodec, createPostgresRenewalSettlementPort, createSandboxRenewalPolicy,
  type SubscriptionQueryExecutor,
} from "@openlup/platform/subscriptions";
import type { RenewalPaymentEvidence, RenewalPaymentRail } from "@openlup/platform/subscriptions/contracts";
import { createRenewalJob } from "../../examples/neutral-store/host/renewal-job.ts";
import { demoRenewalConfig } from "../../examples/neutral-store/owned/renewal.config.ts";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { fixture } from "../helpers/fulfillmentNative.js";
import { AT, call, failure, later, prepareOriginal, sandboxRenewal as renewal } from "./subscriptionNativeFixture.js";

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
async function prepareLifecycleCluster(profile: LifecycleProfile) {
  const container = await runPostgresContainer({ name: `lifecycle-closure-${profile}-${process.pid}`, password: "synthetic-conformance" });
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
    const runner = (sourceRoot = process.cwd()) => createPostgresMigrationRunner({ connectionString: url }, { root: sourceRoot, installation, poolFactory: () => migration });
    const makeHandle = (cleanupExtra?: () => void) => {
      const runtime = profile === "legacy" ? owner : pool(login(r), "-c role=service_role");
      return {
        owner, migration, runtime, runner: runner(), profile,
        close: async () => { try { await closePostgres(container, pools); } finally { cleanupExtra?.(); } },
        async actor<T>(principal: string, work: (client: PoolClient) => Promise<T>) {
          // Owner is fixture setup only until SET ROLE; the operation has exactly actor privileges.
          const db = await owner.connect();
          try { await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated");
            await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
            const value = await work(db); await db.query("COMMIT"); return value;
          } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
        },
      };
    };
    return { container, pools, owner, runner, makeHandle };
  } catch (error) { await closePostgres(container, pools); throw error; }
}

/** Direct current-manifest installation for tests that do not witness the prefix-to-current upgrade diff. */
export async function lifecycleInstallation(profile: LifecycleProfile) {
  const cluster = await prepareLifecycleCluster(profile);
  try {
    await cluster.runner().apply();
    return cluster.makeHandle();
  } catch (error) { await closePostgres(cluster.container, cluster.pools); throw error; }
}

/** Prefix-to-current upgrade installation witnessing before/after catalog, guard and function bodies. */
export async function lifecycleUpgradeInstallation(profile: LifecycleProfile) {
  const cluster = await prepareLifecycleCluster(profile);
  const root = mkdtempSync(join(tmpdir(), `lifecycle-prefix-${profile}-`));
  try {
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
    await cluster.runner(root).apply();
    const catalog = async () => (await cluster.owner.query(`SELECT oid::regprocedure::text AS signature,proowner,proacl::text,prosecdef,proconfig,provolatile,proparallel
      FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid`, [[
      "public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
      "public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz)",
      "public.customer_subscription_pause_as_actor(uuid,text,text,text)"]])).rows;
    const guard = async () => ({
      function: (await cluster.owner.query<{ definition: string; body: string }>(`SELECT pg_get_functiondef(oid) AS definition, prosrc AS body
        FROM pg_catalog.pg_proc WHERE oid='public.commerce_order_assert_line_sum()'::regprocedure`)).rows,
      triggers: (await cluster.owner.query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgname IN ('trg_commerce_orders_line_sum','trg_commerce_order_items_line_sum') ORDER BY tgname`)).rows,
    });
    const bodies = async () => (await cluster.owner.query(`SELECT oid::regprocedure::text AS signature,prosrc AS body,
      encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS body_sha256,pg_get_functiondef(oid) AS installed_definition
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY oid::regprocedure::text`, [[
      "subscription_command_apply", "subscription_apply_lifecycle_action", "customer_subscription_pause_as_actor",
      "subscription_pause_close_recovery", "subscription_terminalize_unpaid_artifacts"]])).rows;
    const before = await catalog(), guardBefore = await guard(), bodiesBefore = await bodies();
    await cluster.runner().apply();
    const after = await catalog(), guardAfter = await guard(), bodiesAfter = await bodies();
    return {
      ...cluster.makeHandle(() => rmSync(root, { recursive: true, force: true })),
      before, after, guardBefore, guardAfter, bodiesBefore, bodiesAfter,
    };
  } catch (error) { try { await closePostgres(cluster.container, cluster.pools); } finally { rmSync(root, { recursive: true, force: true }); } throw error; }
}
export type LifecycleInstallation = Awaited<ReturnType<typeof lifecycleInstallation>>;
export type LifecycleUpgradeInstallation = Awaited<ReturnType<typeof lifecycleUpgradeInstallation>>;
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

export const witnessTimeout = postgresSetupTimeoutMs + postgresTeardownTimeoutMs;
export const codec = createNativeRenewalCodec();
export const truth = { dunningTemplateSlug: 'failed', recoveryUrlPath: '/recover', recoveryTemplateSlug: 'recovered' };
type LockRow = readonly [select: string, id: string];

async function rollback(db: PoolClient | undefined) {
  if (!db) return;
  try { await db.query('ROLLBACK'); }
  catch (error) { db.release(true); throw error; }
  db.release();
}

export function abortAtSecondLock(h: LifecycleInstallation, rpc: string, first: LockRow, second: LockRow) {
  const cancelled: string[] = [];
  const executor: SubscriptionQueryExecutor = {
    async query(sql, values) {
      if (!sql.includes(`${rpc}(`)) return h.runtime.query(sql, values);
      const blocker = await h.owner.connect();
      let victim: PoolClient | undefined, pending: Promise<unknown> | undefined;
      try {
        victim = await h.runtime.connect();
        for (const db of [blocker, victim]) {
          await db.query('BEGIN');
          await db.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'");
        }
        expect((await blocker.query(`${second[0]} FOR UPDATE`, [second[1]])).rowCount).toBe(1);
        const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let finished = false, blocked = false;
        pending = victim.query(sql, values).then(() => null, (error: unknown) => error)
          .finally(() => { finished = true; });
        for (let probe = 0; probe < 1_000 && !finished && !blocked; probe++) {
          blocked = (await blocker.query('SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked', [pid])).rows[0].blocked;
        }
        expect(blocked, `${rpc} waits on the opposing row`).toBe(true);
        await blocker.query('SAVEPOINT check_first_lock');
        await expect(blocker.query(`${first[0]} FOR UPDATE NOWAIT`, [first[1]])).rejects.toMatchObject({ code: '55P03' });
        await blocker.query('ROLLBACK TO SAVEPOINT check_first_lock');
        expect((await blocker.query('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0].cancelled).toBe(true);
        const error = await pending;
        expect(error).toMatchObject({ code: '57014' });
        cancelled.push(rpc);
        throw error;
      } finally {
        // Release the barrier before draining, then roll back even if the RPC completed.
        try { await rollback(blocker); }
        finally { try { await pending; } finally { await rollback(victim); } }
      }
    },
  };
  return { executor, cancelled };
}

export async function dueSubject(h: LifecycleInstallation, channel: string) {
  const { owner, runtime } = h;
  const { slot } = (await owner.query<{ slot: Date }>(`SELECT
    (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '5 years 12 hours') AT TIME ZONE 'UTC' AS slot`)).rows[0];
  const at = (hours: number) => new Date(slot.getTime() + hours * 3_600_000).toISOString();
  const f = await fixture(owner, 1, true, true);
  const sku = randomUUID();
  await owner.query('UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1', [f.subscription, at(0)]);
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')", [sku, sku]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Fixture')", [sku, sku]);
  await owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,stock_source_key,
    settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,1,'XXX',$2,$3,$4,'fixture')`,
  [f.subscription, sku, channel, at(-24)]);
  await owner.query('INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,900)', [f.subscription, sku]);
  await owner.query(`INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at)
    VALUES($1,$2,'{"templateId":"fixture","shippingAmountMinor":0}',$3)
    ON CONFLICT (order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts,completed_at=excluded.completed_at`, [f.order, f.subscription, at(-24)]);
  await owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
    inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES($1,$1,10,10,0,'sellable',$2,$3,'fixture',$1,$4)`, [sku, at(0), at(24 * 365), 'a'.repeat(64)]);
  await createPostgresDestinationPort(runtime).registerOrder({
    idempotencyKey: `destination:${f.order}`, orderId: f.order, now: at(-24),
    address: { recipientName: 'Fixture', line1: '1 Example Street', city: 'Example', postalCode: '00000', country: 'ZZ' },
  });
  return { ...f, at };
}

export function scheduledRenewal(h: LifecycleInstallation, executor: SubscriptionQueryExecutor, now: () => string,
  method: string, execute: RenewalPaymentRail['execute'], population: string) {
  const readOutcome = async (): Promise<RenewalPaymentEvidence> => ({
    status: 'pending', disposition: 'ambiguous', operationId: '', eventKey: '', requestFingerprint: '', verifiedEvidenceRef: '',
    externalAttemptRef: null, occurredAt: null, observedAt: now(), firstRecordedAt: now(), reason: null, amountMinor: null, currency: null,
  });
  return createRenewalJob({
    config: { ...demoRenewalConfig(population), enabled: true },
    beforeRun: async () => {}, afterRun: async () => {},
    async withSession(work) {
      const db = await h.runtime.connect();
      try { return await work(db); } finally { db.release(); }
    },
    native: {
      executor, codec, now, workerId: population,
      async withTransaction(work) {
        const db = await h.runtime.connect();
        try {
          await db.query('BEGIN');
          const result = await work(db);
          await db.query('COMMIT');
          return result;
        } finally { await rollback(db); }
      },
      settlement: db => createPostgresRenewalSettlementPort(db, codec),
      inventory: createPostgresRenewalReservationPort(executor),
      paymentRails: { resolve: () => ({ execute, readOutcome, findExternalAttempt: async () => null }) },
      policy: createSandboxRenewalPolicy(method),
      retry: {
        readFrozenMandate: async snapshot => ({ authorized: true, authorizationRef: snapshot.authorizationRef, paymentMethodRef: method }),
        retryInput: (snapshot, row) => ({
          cycleIdempotencyKey: row.identityKey, executionIdempotencyKey: `${row.identityKey}:retry:${row.retryAttempt}`,
          externalIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}`, requestFingerprint: row.requestFingerprint,
          paymentIntentId: row.settlementIntentId, orderRef: row.orderId, orderId: row.orderId,
          amountMinor: snapshot.pricingSnapshot.totalAmountMinor, currency: snapshot.pricingSnapshot.currency,
          mode: 'subscription', flow: 'off_session', clientId: snapshot.clientId, customerRef: snapshot.payerAccountRef,
          paymentMethodRef: method, recurringModel: 'sandbox', payer: null,
        }),
        payments: { execute, readOutcome }, recoveredTemplate: truth.recoveryTemplateSlug,
      },
      failureTemplate: truth.dunningTemplateSlug, recoveryPath: truth.recoveryUrlPath,
      catalogue: { version: 'fixture', migration: 'fixture' },
      readiness: async () => ({ state: 'ready', candidate: { artifact: 'fixture', configuration: 'fixture',
        environment: 'disposable', database: 'fixture', schema: 'fixture' }, loadedPackages: [], issues: [] }),
    },
  }).services.run;
}

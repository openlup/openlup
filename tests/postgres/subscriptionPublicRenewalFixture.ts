import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { installSubscriptionConsumer } from "../helpers/installSubscriptionConsumer.js";
import { execFile, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { selectPlatformMigrationManifest, evaluateSelectedPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresStartupOptions, assertQualifiedPostgresSession, qualifiedPostgresCatalogPayload, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { tryLeaseTemplateDatabase, type PgTemplateLease } from "../helpers/pgTemplateBroker.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import type { NativeRenewalPurchaseFacts, SubscriptionQueryExecutor, AutomaticRenewalRunDeps } from "@openlup/platform/subscriptions";
import type { RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";

const exec = promisify(execFile);
let scratch: string;
export let at: string, now: string, later: string;
export const days = (stamp: string, count: number) => new Date(Date.parse(stamp) + count * 86_400_000).toISOString();
export let api: typeof import("@openlup/platform/subscriptions");
export let payments: typeof import("@openlup/platform/payments");
export let identity: typeof import("@openlup/platform/identity");
export let inventory: typeof import("@openlup/platform/inventory");
export let checkout: typeof import("@openlup/platform/commerce/server/native-checkout");
export let destinations: typeof import("@openlup/platform/commerce/server/destinations");
export let composition: typeof import("@openlup/platform/composition");
export let fulfillment: typeof import("@openlup/platform/fulfillment");
let migrationsApi: typeof import("@openlup/platform/migrations");
let container: PostgresContainer | undefined;
let brokerLease: PgTemplateLease | null = null;
let isolatedRenewalContainer = false;
/** Suites that restart the fixture PostgreSQL container via `restartDatabase()` require an isolated container. */
export function requireIsolatedRenewalContainer(): void {
  isolatedRenewalContainer = true;
}
export let admin: Pool, migration: Pool, runtime: Pool;
export let runtimeUrl: string;
let selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "postgres", runtimeLogin: "g7_runtime", restoreLogin: "g7_restore" };
export function runtimeLogin(): string { return selection.runtimeLogin; }
const lock = "openlup:public-platform-migrations:v1";
const secret = "synthetic-conformance";
export const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: "sandbox", authorizationRef: "sandbox:authorization",
  unattendedChargeAuthorizedAt: "", payerAccountRef: "sandbox:customer", methodRef: "sandbox:method", methodEvidenceRef: "sandbox:method-evidence",
  stockSourceKey: "g7-stock", templateId: "g7-refill", cadenceDays: 28, currency: "XXX",
  lines: [{ lineOrdinal: 1, sku: "G7-REFILL", quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0, acquisitionRef: null };
export const executor: SubscriptionQueryExecutor = { query: (sql, values) => runtime.query(sql, values) };
export async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = [], db: SubscriptionQueryExecutor = executor): Promise<T> {
  return (await db.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS result`, values)).rows[0].result as T;
}
beforeAll(async () => {
  scratch = resolve(".context/scratch/g7", randomUUID(), "installed");
  const require = await installSubscriptionConsumer(scratch);
  const load = (key: string) => import(pathToFileURL(require.resolve(key)).href);
  api = await load("@openlup/platform/subscriptions"); payments = await load("@openlup/platform/payments");
  identity = await load("@openlup/platform/identity"); fulfillment = await load("@openlup/platform/fulfillment");
  composition = await load("@openlup/platform/composition");
  checkout = await load("@openlup/platform/commerce/server/native-checkout");
  destinations = await load("@openlup/platform/commerce/server/destinations");
  inventory = await load("@openlup/platform/inventory");
  migrationsApi = await load("@openlup/platform/migrations");
  brokerLease = isolatedRenewalContainer ? null : await tryLeaseTemplateDatabase("qualified-v2", "g7-renewal");
  if (brokerLease) {
    selection = {
      generation: "qualified-v2",
      roleMode: "installer-managed",
      bootstrapLogin: "postgres",
      migrationLogin: brokerLease.migrationLogin,
      runtimeLogin: brokerLease.runtimeLogin,
      restoreLogin: brokerLease.restoreLogin,
    };
    admin = new Pool({ connectionString: brokerLease.ownerUrl });
    migration = new Pool({ connectionString: brokerLease.migrationUrl, options: qualifiedPostgresStartupOptions(selection) });
    const url = new URL(brokerLease.runtimeUrl);
    // The selected installation's existing runtime group, never a migration/owner role.
    url.searchParams.set("options", "-c role=service_role");
    runtimeUrl = url.toString();
    runtime = new Pool({ connectionString: runtimeUrl });
  } else {
    container = await runPostgresContainer({ name: `g7-renewal-${process.pid}`, password: secret, runOptions: ["-e", "PGDATA=/var/lib/postgresql/g7-data"] });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Renewal PostgreSQL unavailable");
    admin = new Pool({ connectionString: container.connectionString });
    for (const role of [selection.runtimeLogin, selection.restoreLogin!]) await admin.query(`CREATE ROLE ${role}
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`);
    migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
    const runner = renewalFixtureRunner(container.connectionString, migration, selection);
    await runner.apply();
    expect((await runner.status()).pending).toEqual([]); expect(await runner.apply()).toEqual({ applied: [] });
    const url = new URL(container.connectionString); url.username = selection.runtimeLogin; url.password = secret;
    // The selected installation's existing runtime group, never a migration/owner role.
    url.searchParams.set("options", "-c role=service_role"); runtimeUrl = url.toString();
    runtime = new Pool({ connectionString: runtimeUrl });
  }
  expect((await runtime.query(`SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`)).rows)
    .toEqual([{ current_user: "service_role", elevated: false }]);
  at = days((await admin.query("SELECT now() AS at")).rows[0].at.toISOString(), -150);
  now = days(at, 28 + 1 / 1440); later = days(at, 28 + 8 / 1440);
  facts.unattendedChargeAuthorizedAt = at;
  await seedRenewalDatabase(admin, executor);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try {
    const activePools = [admin, migration, runtime].filter(Boolean);
    for (const activePool of activePools) activePool.on("error", () => {});
    try {
      await closePostgres(container, activePools);
    } finally {
      if (brokerLease) {
        const lease = brokerLease;
        brokerLease = null;
        await lease.release();
      }
    }
  } finally { if (scratch) await rm(resolve(scratch, ".."), { recursive: true, force: true }); }
});

function renewalCatalogue() {
  return selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2",
    { migrationIsBootstrap: true, hasRestore: true });
}

function renewalFixtureRunner(connectionString: string, pool: Pool, binding: QualifiedPostgresInstallation,
  manifest = renewalCatalogue(), measured?: (hash: string) => void) {
  const migrations = [manifest.baseline, ...manifest.forward].map(({ file }) => ({ file, content: readFileSync(file, "utf8") }));
  return migrationsApi.createPostgresMigrationRunner({ connectionString }, {
    lockName: lock, root: process.cwd(), poolFactory: () => pool,
    source: { readMigrations: () => ({ migrations, errors: [] }), readManifest: () => manifest,
      evaluate: (input: Parameters<typeof evaluateSelectedPlatformMigrationManifest>[0]) => evaluateSelectedPlatformMigrationManifest(input, "qualified-v2"),
      assertSession: (client: Parameters<typeof assertQualifiedPostgresSession>[0], applied: Parameters<typeof assertQualifiedPostgresSession>[1]) => assertQualifiedPostgresSession(client, applied, binding, lock) },
    catalogProjectionPayload: async (client: Parameters<typeof qualifiedPostgresCatalogPayload>[0]) => {
      const payload = await qualifiedPostgresCatalogPayload(client, binding, lock);
      measured?.(createHash("sha256").update(payload).digest("hex"));
      return payload;
    },
  });
}

async function seedRenewalDatabase(owner: Pool, db: SubscriptionQueryExecutor) {
  // Installation-owned synthetic routing selection, before any journey writer.
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('g7-parcels','3pl',true)");
  await owner.query(`INSERT INTO public.catalog_products(id,slug,name) VALUES('11111111-1111-4111-8111-111111111111','g7-refill','Refill');
    INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','G7-REFILL','Refill',true);
    INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES('33333333-3333-4333-8333-333333333333','Sandbox prices','AA','XXX','2026-01-01');
    INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','any',100,'2026-01-01');`);
  const stock = fulfillment.createPostgresFulfillmentStockSyncPort(db, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] });
  await stock.recordProviderStockCurrent({ requestKey: "fixture-stock", snapshot: {
    providerRef: "sandbox-stock", collectedAt: at, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: "G7-REFILL", totalQuantity: 1000, forSaleQuantity: 1000, reservedOrUnavailableQuantity: 0, syncRunId: "g7-sync" },
    inventoryClass: "sellable", lastSyncedAt: at, staleAfter: "2027-01-01T00:00:00.000Z" });
}

async function withFreshRenewalDatabase<T>(name: string, work: (target: {
  owner: Pool; migrator: Pool; connectionString: string; db: Pool; runtimeConnection: string;
}) => Promise<T>) {
  const isolated = await runPostgresContainer({ name: `${name}-${process.pid}`, password: secret });
  const pools: Pool[] = [];
  try {
    const { connectionString } = isolated;
    expect(await waitForPostgresTcpReady(connectionString)).toBe(true);
    const owner = new Pool({ connectionString });
    pools.push(owner);
    for (const role of [selection.runtimeLogin, selection.restoreLogin!]) await owner.query(
      `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`);
    const migrator = new Pool({ connectionString, options: qualifiedPostgresStartupOptions(selection) });
    const runtimeConnection = loginConnection(connectionString, selection.runtimeLogin);
    const db = new Pool({ connectionString: runtimeConnection });
    pools.push(migrator, db);
    return await work({ owner, migrator, connectionString, db, runtimeConnection });
  } finally { await closePostgres(isolated, pools); }
}

export function loginConnection(connectionString: string, login: string) {
  const url = new URL(connectionString);
  url.username = login; url.password = secret;
  url.searchParams.delete("options");
  return url.toString();
}

type CaptureInstrumentation = { key: number; onError?: (error: unknown) => void };

async function applyWithCaptureBarrier(pool: Pool, apply: () => Promise<{ applied: string[] }>,
  barrier: CaptureInstrumentation) {
  const insert = "INSERT INTO public.subscription_renewal_upgrade_cohort ";
  const afterCapture = "CREATE OR REPLACE FUNCTION public.subscription_claim_due_renewal(";
  // Decorate only the execution of the installed unit. The runner still validates and
  // records the canonical bytes, and catalogue verification sees no fixture objects.
  let restore: (() => void) | undefined;
  const decorate = (client: PoolClient) => {
    const original = client.query;
    restore = () => { client.query = original; };
    client.query = new Proxy(original, {
      apply(query, receiver, args) {
        if (typeof args[0] !== "string" || !args[0].includes(insert)) return Reflect.apply(query, receiver, args);
        expect(args[0].split(insert)).toHaveLength(2);
        expect(args[0].split(afterCapture)).toHaveLength(2);
        args[0] = args[0].replace(insert, `CREATE FUNCTION public.fixture_hold_renewal_capture()
          RETURNS trigger LANGUAGE plpgsql AS $fixture$
          BEGIN
            PERFORM pg_advisory_xact_lock(${barrier.key});
            RETURN NULL;
          END $fixture$;
          CREATE TRIGGER fixture_hold_renewal_capture AFTER INSERT ON public.subscription_renewal_upgrade_cohort
            FOR EACH STATEMENT EXECUTE FUNCTION public.fixture_hold_renewal_capture();
          ${insert}`).replace(afterCapture, `DROP TRIGGER fixture_hold_renewal_capture ON public.subscription_renewal_upgrade_cohort;
          DROP FUNCTION public.fixture_hold_renewal_capture();
          ${afterCapture}`);
        return Promise.resolve(Reflect.apply(query, receiver, args)).catch((error: unknown) => {
          barrier.onError?.(error);
          throw error;
        });
      },
    });
  };
  pool.once("acquire", decorate);
  try { return await apply(); }
  finally { pool.off("acquire", decorate); restore?.(); }
}

export async function withOccupiedRenewalPrefix(work: (target: {
  owner: Pool; db: Pool; connectionString: string; applyForward: (barrier?: CaptureInstrumentation) => Promise<{ applied: string[] }>;
}) => Promise<void>, isForward: (file: string) => boolean = file => file === generationForward) {
  const full = renewalCatalogue(), boundary = full.forward.findIndex(unit => isForward(unit.file));
  expect(boundary).toBeGreaterThan(0);
  const plans = [boundary, boundary + 1].map(end => ({ ...full, forward: full.forward.slice(0, end) }));
  // Measure both bounded catalogues on a disposable installation before testing the occupied one.
  await withFreshRenewalDatabase("renewal-catalogue", async ({ connectionString, migrator }) => {
    for (const plan of plans) {
      plan.objectInventorySha256 = "0".repeat(64);
      let hash: string | undefined;
      const runner = renewalFixtureRunner(connectionString, migrator, selection, plan, value => { hash = value; });
      await expect(runner.apply()).rejects.toThrow("object inventory SHA-256 mismatch");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      plan.objectInventorySha256 = hash!;
      expect(await runner.apply()).toEqual({ applied: [] });
    }
  });
  await withFreshRenewalDatabase("renewal-predecessor", async ({ owner, migrator, db, connectionString, runtimeConnection }) => {
    const preceding = renewalFixtureRunner(connectionString, migrator, selection, plans[0]!);
    expect((await preceding.apply()).applied).toEqual([plans[0]!.baseline, ...plans[0]!.forward].map(unit => unit.file));
    await seedRenewalDatabase(owner, db);
    const through = renewalFixtureRunner(connectionString, migrator, selection, plans[1]!);
    await work({ owner, db, connectionString: runtimeConnection, applyForward: barrier => barrier ? applyWithCaptureBarrier(migrator, () => through.apply(), barrier) : through.apply() });
  });
}

export async function purchase(captured = true, declared = true, paidAt = at, target = { connectionString: runtimeUrl, db: runtime }) {
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: target.connectionString });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: `${randomUUID()}@example.invalid`, principalId: randomUUID(), acquisitionSource: "fixture", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  const key = randomUUID(), money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const made = await checkout.createPostgresNativeCheckoutPersistence(target.db).createOrderDraft({ idempotencyKey: key,
    quoteSnapshot: { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true,
      lines: [{ sku: "G7-REFILL", productSlug: "g7-refill", quantity: 2, unitPriceGross: money(100), lineSubtotalGross: money(200),
        tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic test tax",
          netAmount: money(200), vatAmount: money(0), grossAmount: money(200) } }],
      discounts: [], context: { mode: "subscription", cadenceDays: 28, promoCodes: [] },
      subtotalGross: money(200), discountTotalGross: money(0), shippingGross: money(0), shippingDiscountGross: money(0),
      totalGross: money(200), netTotal: money(200), taxTotal: money(0) } } }, { clientId });
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", 200, "XXX", "{}", at], target.db);
  if (captured) expect(await captureSandboxPurchase(payments.createPostgresSandboxPaymentSimulator(target.db, {
    dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: intent.settlement.id, key, at: paidAt })).toMatchObject({ status: 200 });
  await destinations.createPostgresDestinationPort(target.db).registerOrder({ idempotencyKey: `destination:${key}`, orderId,
    address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: at });
  if (declared) await rpc("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, at], target.db);
  const settled = (await target.db.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  return { orderId, clientId, capturedReference: settled.external_ref ?? settled.id, idempotencyKey: `activate:${key}` };
}
export async function active() {
  const p = await purchase(); const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts });
  expect(result.renewalAttachment).toBe("complete");
  return { ...p, subscriptionId: String(result.activation.subscriptionId) };
}
export function settlement(codec: ReturnType<typeof api.createNativeRenewalCodec>, db: SubscriptionQueryExecutor = executor): RenewalSettlementPort {
  return api.createPostgresRenewalSettlementPort(db, codec);
}
export async function transaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>, pool = runtime): Promise<T> {
  const db = await pool.connect();
  try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function retire() {
  const rows = (await runtime.query("SELECT id,client_id FROM public.subscriptions WHERE status='active'")).rows;
  for (const row of rows) await rpc("subscription_apply_lifecycle_action", [row.client_id, `fixture-cancel:${row.id}`, row.id, "cancel", "{}", new Date().toISOString()]);
}
export async function stock(quantity: number, key = randomUUID(), db = executor, sku = "G7-REFILL") {
  return fulfillment.createPostgresFulfillmentStockSyncPort(db, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] })
    .recordProviderStockCurrent({ requestKey: key, snapshot: { providerRef: "sandbox-stock", collectedAt: days(at, 1), sourceRevision: null,
      revisionSource: "collection", quantityKind: "snapshot", skuRef: sku, totalQuantity: quantity, forSaleQuantity: quantity,
      reservedOrUnavailableQuantity: 0, syncRunId: key }, inventoryClass: "sellable", lastSyncedAt: days(at, 1), staleAfter: days(at, 500) });
}
export async function deps(subscriptionId: string, scenario: "succeeded" | "declined" | "ambiguous", asOf = now, target = runtime) {
  const transact: typeof transaction = work => transaction(work, target);
  const codec = api.createNativeRenewalCodec(), store = api.createPostgresRenewalStore(target, codec, transact);
  const rail = api.createPostgresSandboxRenewalRail(target, { scenario, now: () => asOf });
  const execute = vi.spyOn(rail, "execute");
  const lifecycle = api.createPostgresRetryLifecycleBinding({ executor: target, withTransaction: transact,
    settlement: db => settlement(codec, db), correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
  const input: AutomaticRenewalRunDeps = { store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
    inventory: inventory.createPostgresRenewalReservationPort(target),
    paymentRails: { resolve: channel => channel === "sandbox" ? rail : null }, workerId: "g7-worker", policy: api.createSandboxRenewalPolicy(facts.methodRef) };
  const due = (await store.listDue(500, asOf)).find(row => row.subscriptionId === subscriptionId)!;
  expect(due).toBeDefined();
  return { input, due, codec, rail, execute };
}


export async function restartDatabase() {
  await runtime.end(); await admin.end(); await migration.end();
  await exec("docker", ["restart", `g7-renewal-${process.pid}`]);
  const { stdout } = await exec("docker", ["inspect", "--format", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', `g7-renewal-${process.pid}`]);
  const endpoint = new URL(container!.connectionString); endpoint.port = stdout.trim(); container!.connectionString = endpoint.toString();
  const runtimeEndpoint = new URL(runtimeUrl); runtimeEndpoint.port = stdout.trim(); runtimeUrl = runtimeEndpoint.toString();
  expect(await waitForPostgresTcpReady(container!.connectionString)).toBe(true);
  admin = new Pool({ connectionString: container!.connectionString }); runtime = new Pool({ connectionString: runtimeUrl });
  migration = new Pool({ connectionString: container!.connectionString, options: qualifiedPostgresStartupOptions(selection) });
}

export async function freshRetryReadback(operationId: string, when: string) {
  const child = `import {argv} from 'node:process';import {createNativeRenewalCodec,createNativeRetryDriver} from '@openlup/platform/subscriptions';import pg from 'pg';
    const p=new pg.Pool({connectionString:argv[1]});let executions=0,reads=0;
    const c=createNativeRenewalCodec();const forbidden=()=>{throw Error('prepared_retry_must_only_read');};
    const withTransaction=async work=>{const db=await p.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
    const driver=createNativeRetryDriver({executor:p,withTransaction,decode:c.decode,readFrozenMandate:forbidden,retryInput:forbidden,validateInput:forbidden,
      payments:{execute:async()=>{executions++;throw Error('redispatch');},readOutcome:async(prepared,snapshot)=>{
        reads++;if(prepared.execute!==false||prepared.replayed!==true||prepared.identityKey!==c.identity(snapshot))throw Error('binding');
        return {status:'unknown',disposition:'ambiguous',operationId:argv[2],requestFingerprint:prepared.operationFingerprint};}},
      failureTemplate:'failed',recoveredTemplate:'recovered',recoveryPath:'/recover',classifyFailure:()=> 'temporary'});
    const results=await driver.run(argv[3],500);console.log(JSON.stringify({results,executions,reads}));await p.end();`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", child, runtimeUrl, operationId, when], { cwd: scratch });
  return JSON.parse(stdout);
}

export const normalRenewalWorkerPopulation = "g7-normal-process";

async function normalRenewalWorkerDeadline<T>(work: Promise<T>, action: string, milliseconds: number): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`normal renewal worker did not ${action}`)), milliseconds);
    })]);
  } finally { clearTimeout(deadline); }
}

export async function withNormalRenewalWorker<T>(
  input: { when: string; workerId: string; stopAfterDispatch?: "SIGKILL" | "disconnect" },
  inspect: (message: unknown, pid: number | undefined) => Promise<T>,
): Promise<T> {
  const entry = resolve(scratch, "normal-renewal-worker.mjs");
  copyFileSync(new URL("./subscriptionPublicRenewal.worker.mjs", import.meta.url), entry);
  const child = fork(entry, [], { cwd: scratch, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  // Node can report exit without emitting close after the parent disconnects IPC.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const report = new Promise<unknown>((resolve, reject) => {
      child.once("message", message => {
        if (message && typeof message === "object" && "error" in message) reject(new Error(String(message.error)));
        else resolve(message);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => reject(new Error(`normal renewal worker exited before reporting (${code ?? signal})`)));
      child.send({ when: input.when, workerId: input.workerId, holdAfterDispatch: input.stopAfterDispatch !== undefined,
        runtimeUrl, methodRef: facts.methodRef, population: normalRenewalWorkerPopulation }, error => { if (error) reject(error); });
    });
    const message = await normalRenewalWorkerDeadline(report, "report", 8_000);
    // Receiving the ACK ends its deadline. The inspection can run a second worker
    // through its own report and exit deadlines while this worker still holds the lease.
    const value = await normalRenewalWorkerDeadline(inspect(message, child.pid), "complete inspection", 20_000);
    if (input.stopAfterDispatch === "SIGKILL") expect(child.kill("SIGKILL")).toBe(true);
    if (input.stopAfterDispatch === "disconnect") {
      expect(child.connected).toBe(true);
      child.disconnect();
    }
    const exit = await normalRenewalWorkerDeadline(exited, "exit", 4_000);
    if (input.stopAfterDispatch === "SIGKILL") expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    else expect(exit).toEqual({ code: input.stopAfterDispatch === "disconnect" ? 1 : 0, signal: null });
    return value;
  } finally {
    if (child.pid !== undefined) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await normalRenewalWorkerDeadline(exited, "exit during cleanup", 4_000);
    }
  }
}

export async function captureStore(db: Pool, sourceId: string, limits = { maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 }) {
  const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: true, hasRestore: true });
  return captureConnectedNativeStore({ sourceId, catalogueId: manifest.objectInventorySha256, ...limits,
    source: { async withSnapshot(work) {
      const client = await db.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, args) => client.query(sql, args ? [...args] : undefined) });
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    } } });
}
export async function withRestoredStore(packet: ConnectedNativeStoreCapture, work: (target: {
  owner: Pool; runtime: Pool; transaction: typeof transaction;
}) => Promise<void>) {
  const leased = await tryLeaseTemplateDatabase("qualified-v2", "g7-restored");
  const target = leased ? undefined : await runPostgresContainer({ name: `g7-restored-${process.pid}`, password: secret });
  const pools: Pool[] = [];
  try {
    let owner: Pool;
    let migration: Pool;
    let runtime: Pool;
    let targetSelection: QualifiedPostgresInstallation = selection;
    if (leased) {
      targetSelection = {
        generation: "qualified-v2",
        roleMode: "installer-managed",
        bootstrapLogin: "postgres",
        migrationLogin: leased.migrationLogin,
        runtimeLogin: leased.runtimeLogin,
        restoreLogin: leased.restoreLogin,
      };
      owner = new Pool({ connectionString: leased.ownerUrl }); pools.push(owner);
      migration = new Pool({ connectionString: leased.migrationUrl, options: qualifiedPostgresStartupOptions(targetSelection) }); pools.push(migration);
      runtime = new Pool({ connectionString: leased.runtimeUrl, options: "-c role=service_role" }); pools.push(runtime);
    } else {
      expect(await waitForPostgresTcpReady(target!.connectionString)).toBe(true);
      owner = new Pool({ connectionString: target!.connectionString }); pools.push(owner);
      for (const role of [targetSelection.runtimeLogin, targetSelection.restoreLogin!]) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`);
      migration = new Pool({ connectionString: target!.connectionString, options: qualifiedPostgresStartupOptions(targetSelection) }); pools.push(migration);
      const runner = migrationsApi.createPlatformPostgresMigrationRunner({ connectionString: target!.connectionString }, { installation: targetSelection, poolFactory: () => migration });
      await runner.apply();
      const url = new URL(target!.connectionString); url.username = targetSelection.runtimeLogin;
      runtime = new Pool({ connectionString: url.toString(), options: "-c role=service_role" }); pools.push(runtime);
    }
    const freshTarget = await captureStore(migration, "public-renewal-pristine");
    expect(await restoreConnectedNativeStore({ owner: migration, installation: targetSelection, packet, freshTarget })).toMatchObject({ replayed: false, captureSha256: packet.sha256 });
    expect(await restoreConnectedNativeStore({ owner: migration, installation: targetSelection, packet, freshTarget })).toMatchObject({ replayed: true });
    async function transaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T> {
      const client = await runtime.connect();
      try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    await work({ owner, runtime, transaction });
  } finally {
    for (const activePool of pools) activePool.on("error", () => {});
    try {
      await closePostgres(target, pools);
    } finally {
      if (leased) await leased.release();
    }
  }
}

export const frozenGenerationSignature = "public.subscription_read_frozen_renewal_generation(uuid,uuid)";
export const frozenGenerationSql = "SELECT public.subscription_read_frozen_renewal_generation($1::uuid,$2::uuid)";
export const generationForward = "db/platform/migrations/20261129120000_subscription_renewal_generation_seam.sql";

const amountName = /(?:amount|minor|subtotal|total|fee|payable)|(?:price|tax|discount|shipping)(?:[._-]?(?:gross|net|value|rate|charge|cost|cents|bps|percent))?$/i;
const numericPaths = ["lines[].unitAmountMinor", "shippingTerms.flatMinor", "shippingTerms.freeThresholdMinor"];
const binding = "lineKey? skuId skuCode mode role source skuRevisionId?";
const keys: Record<string, string> = {
  "": "operationId commercialGenerationId subscriptionId scheduledAt cycleNumber logicalCycle clientId template operationFingerprint lines currency catalogAcceptance linePricing discountTerms shippingTerms shippingAddressRef stockSourceKey settlementChannelKey authorizationRef payerAccountRef unattendedChargeAuthorizedAt",
  logicalCycle: "activationCycleId evidenceRef",
  template: "id",
  "lines[]": "sku unitAmountMinor",
  catalogAcceptance: "lines admission?",
  "catalogAcceptance.lines[]": "skuId skuCode skuRevisionId publicationHead typeRef definitionDigest optionDigest netContent demandPolicyRef?",
  "catalogAcceptance.lines[].publicationHead": "publicationId documentDigest",
  "catalogAcceptance.lines[].typeRef": "key",
  "catalogAcceptance.lines[].netContent": "dimension unscaled unit",
  "catalogAcceptance.admission": "quoteRef? quoteDigest moneyVersion priceEvidenceRef policyEvidenceRef acceptanceTokenDigest? consultedHeads offer? lineBindings legacyReviewEvidence? destinationRef? destinationDigest? graduation?",
  "catalogAcceptance.admission.consultedHeads[]": "productId publicationId documentDigest",
  "catalogAcceptance.admission.offer": "ref version",
  "catalogAcceptance.admission.lineBindings[]": binding,
  "catalogAcceptance.admission.legacyReviewEvidence": "identityComparison priceEvidenceRef policyEvidenceRef priorPriceEvidenceRef? priorPolicyEvidenceRef?",
  "catalogAcceptance.admission.graduation": "phaseDigest lineBindings",
  "catalogAcceptance.admission.graduation.lineBindings[]": binding,
  "linePricing[]": "sku quoteLine",
  "linePricing[].quoteLine": "catalogFacts",
  "linePricing[].quoteLine.catalogFacts": "provenance basePriceEntryId? basePriceListId? resolvedPriceEntryId? policyRevisionId? policyDigest? documentRevisionId? documentDigest? skuId? mode? currency? atTime?",
  discountTerms: "reasonCode acquisitionRef?",
  shippingTerms: "version currency flatMinor freeThresholdMinor",
};
const arrayPaths = ["lines", "linePricing", "catalogAcceptance.lines", "catalogAcceptance.admission.consultedHeads",
  "catalogAcceptance.admission.lineBindings", "catalogAcceptance.admission.graduation.lineBindings"];

export function expectFrozenGenerationShape(projection: unknown) {
  const numbers = new Set<string>();
  function walk(node: unknown, path: string) {
    if (node === null) return;
    if (arrayPaths.includes(path)) {
      expect(Array.isArray(node), path).toBe(true);
      for (const entry of node as unknown[]) walk(entry, `${path}[]`);
    } else if (keys[path] !== undefined) {
      expect(node && typeof node === "object" && !Array.isArray(node), path).toBe(true);
      const schema = keys[path].split(" ");
      const actual = Object.keys(node as object);
      expect(actual.filter(key => !schema.includes(key) && !schema.includes(`${key}?`)), path).toEqual([]);
      expect(actual, path).toEqual(expect.arrayContaining(schema.filter(key => !key.endsWith("?"))));
      for (const [key, value] of Object.entries(node as object)) {
        const child = path ? `${path}.${key}` : key;
        if (amountName.test(key)) expect(numericPaths, child).toContain(child);
        walk(value, child);
      }
    } else if (numericPaths.includes(path)) {
      expect(typeof node, path).toBe("number");
      numbers.add(path);
    } else {
      expect(typeof node, path).toBe("string");
    }
  }
  walk(projection, "");
  return [...numbers].sort();
}

/** Seed excluded fields at every actual object boundary of a private fixture. */
export function plantExcludedFrozenFields(node: unknown, path: string[] = []): void {
  if (Array.isArray(node)) {
    node.forEach((member, index) => plantExcludedFrozenFields(member, [...path, String(index)]));
  } else if (node && typeof node === "object") {
    const object = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(object)) plantExcludedFrozenFields(value, [...path, key]);
    object.excluded = { payload: [{ Total: "opaque", subtotal: 18 }] };
    object["tax-net"] = "18";
    object.PayableValue = 19;
    if (path.join(".") !== "pricingSnapshot.shippingTerms") {
      object.flatMinor = 301;
      object.freeThresholdMinor = 302;
    }
  }
}

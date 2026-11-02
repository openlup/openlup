import { installSubscriptionConsumer } from "../helpers/installSubscriptionConsumer.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { selectPlatformMigrationManifest, evaluateSelectedPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresStartupOptions, assertQualifiedPostgresSession, qualifiedPostgresCatalogPayload } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import type { NativeRenewalPurchaseFacts, SubscriptionQueryExecutor, AutomaticRenewalRunDeps } from "@openlup/platform/subscriptions";
import type { RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";

const exec = promisify(execFile);
const scratch = resolve(".context/scratch/g7/installed");
export let at: string, now: string, later: string;
export const days = (stamp: string, count: number) => new Date(Date.parse(stamp) + count * 86_400_000).toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export let api: typeof import("@openlup/platform/subscriptions");
export let payments: typeof import("@openlup/platform/payments");
export let identity: typeof import("@openlup/platform/identity");
export let inventory: typeof import("@openlup/platform/inventory");
export let composition: typeof import("@openlup/platform/composition");
export let fulfillment: typeof import("@openlup/platform/fulfillment");
let container: PostgresContainer | undefined;
export let admin: Pool, migration: Pool, runtime: Pool;
export let runtimeUrl: string;
const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "postgres", runtimeLogin: "g7_runtime", restoreLogin: "g7_restore" } as const;
const lock = "openlup:public-platform-migrations:v1";
const secret = "synthetic-conformance";
export const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: "sandbox", authorizationRef: "sandbox-authorization",
  unattendedChargeAuthorizedAt: "", payerAccountRef: "sandbox-customer", methodRef: "sandbox-method", methodEvidenceRef: "sandbox-method-evidence",
  stockSourceKey: "g7-stock", templateId: "g7-refill", cadenceDays: 28, currency: "XXX",
  lines: [{ lineOrdinal: 1, sku: "G7-REFILL", quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0, acquisitionRef: null };
export const executor: SubscriptionQueryExecutor = { query: (sql, values) => runtime.query(sql, values) };
export async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []): Promise<T> {
  return (await executor.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS result`, values)).rows[0].result as T;
}
beforeAll(async () => {
  const require = await installSubscriptionConsumer(scratch);
  const load = (key: string) => import(pathToFileURL(require.resolve(key)).href);
  api = await load("@openlup/platform/subscriptions"); payments = await load("@openlup/platform/payments");
  identity = await load("@openlup/platform/identity"); fulfillment = await load("@openlup/platform/fulfillment");
  composition = await load("@openlup/platform/composition");
  inventory = await load("@openlup/platform/inventory");
  const migrationsApi = await load("@openlup/platform/migrations");
  container = await runPostgresContainer({ name: `g7-renewal-${process.pid}`, password: secret, runOptions: ["-e", "PGDATA=/var/lib/postgresql/g7-data"] });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Renewal PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  for (const role of [selection.runtimeLogin, selection.restoreLogin]) await admin.query(`CREATE ROLE ${role}
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`);
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2",
    { migrationIsBootstrap: true, hasRestore: true });
  const migrations = [manifest.baseline, ...manifest.forward].map(({ file }) => ({ file, content: readFileSync(file, "utf8") }));
  const runner = migrationsApi.createPostgresMigrationRunner({ connectionString: container.connectionString }, {
    lockName: lock, root: process.cwd(), poolFactory: () => migration,
    source: { readMigrations: () => ({ migrations, errors: [] }), readManifest: () => manifest,
      evaluate: (input: Parameters<typeof evaluateSelectedPlatformMigrationManifest>[0]) => evaluateSelectedPlatformMigrationManifest(input, "qualified-v2"),
      assertSession: (client: Parameters<typeof assertQualifiedPostgresSession>[0], applied: Parameters<typeof assertQualifiedPostgresSession>[1]) => assertQualifiedPostgresSession(client, applied, selection, lock) },
    catalogProjectionPayload: (client: Parameters<typeof qualifiedPostgresCatalogPayload>[0]) => qualifiedPostgresCatalogPayload(client, selection, lock),
  });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]); expect(await runner.apply()).toEqual({ applied: [] });
  const url = new URL(container.connectionString); url.username = selection.runtimeLogin; url.password = secret;
  // The selected installation's existing runtime group, never a migration/owner role.
  url.searchParams.set("options", "-c role=service_role"); runtimeUrl = url.toString();
  runtime = new Pool({ connectionString: runtimeUrl });
  expect((await runtime.query(`SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`)).rows)
    .toEqual([{ current_user: "service_role", elevated: false }]);
  at = days((await admin.query("SELECT now() AS at")).rows[0].at.toISOString(), -150);
  now = days(at, 28 + 1 / 1440); later = days(at, 28 + 8 / 1440);
  facts.unattendedChargeAuthorizedAt = at;
  // Installation-owned synthetic routing selection, before any journey writer.
  await admin.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('g7-parcels','3pl',true)");
  await admin.query(`INSERT INTO public.catalog_products(id,slug,name) VALUES('11111111-1111-4111-8111-111111111111','g7-refill','Refill');
    INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','G7-REFILL','Refill',true);
    INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES('33333333-3333-4333-8333-333333333333','Sandbox prices','AA','XXX','2026-01-01');
    INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','any',100,'2026-01-01');`);
  const stock = fulfillment.createPostgresFulfillmentStockSyncPort(executor, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] });
  await stock.recordProviderStockCurrent({ requestKey: "fixture-stock", snapshot: {
    providerRef: "sandbox-stock", collectedAt: at, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: "G7-REFILL", totalQuantity: 1000, forSaleQuantity: 1000, reservedOrUnavailableQuantity: 0, syncRunId: "g7-sync" },
    inventoryClass: "sellable", lastSyncedAt: at, staleAfter: "2027-01-01T00:00:00.000Z" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [admin, migration, runtime].filter(Boolean)); });

export async function purchase(captured = true, declared = true) {
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: runtimeUrl });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: `${randomUUID()}@example.invalid`, principalId: randomUUID(), acquisitionSource: "fixture", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  // Purchase quote/draft remains an explicit fixture until joined proof. No
  // direct client, stock, settings, activation, terms, lines or method row writes.
  const quote = { context: { mode: "subscription", cadenceDays: 28 }, lines: [
    { sku: "G7-REFILL", quantity: 2, unitPriceGross: { amountMinor: 100, currency: "XXX" }, lineSubtotalGross: { amountMinor: 200, currency: "XXX" } }], totalGross: { amountMinor: 200, currency: "XXX" } };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", context: quote.context, lines: quote.lines, totals: { totalGross: { amountMinor: 200, currency: "XXX" } } };
  const key = randomUUID();
  const made = await rpc<{ orderDraft: { orderId: string } }>("commerce_create_order_draft_with_outbox", [key, JSON.stringify({ quote }), JSON.stringify(draft), clientId]);
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", 200, "XXX", "{}", at]);
  const truth = payments.createPostgresPaymentTruthPort(executor, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  if (captured) await truth.ingestEvent({ sourceEventId: `purchase:${key}`, idempotencyKey: `truth:${key}`, settlementIntentId: intent.settlement.id,
    outcome: "captured", amountMinor: 200, currency: "XXX", occurredAt: at, failure: null,
    evidence: { sourceKind: "accepted_event", sourceReference: `sandbox:${key}`, observedStatus: "captured", observedAt: at, payloadFingerprint: hash(key) } });
  if (declared) await rpc("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, at]);
  const settled = (await runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
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
export async function transaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T> {
  const db = await runtime.connect();
  try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export async function retire() {
  const rows = (await runtime.query("SELECT id,client_id FROM public.subscriptions WHERE status='active'")).rows;
  for (const row of rows) await rpc("subscription_apply_lifecycle_action", [row.client_id, `fixture-cancel:${row.id}`, row.id, "cancel", "{}", new Date().toISOString()]);
}
export async function stock(quantity: number, key = randomUUID()) {
  return fulfillment.createPostgresFulfillmentStockSyncPort(executor, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] })
    .recordProviderStockCurrent({ requestKey: key, snapshot: { providerRef: "sandbox-stock", collectedAt: days(at, 1), sourceRevision: null,
      revisionSource: "collection", quantityKind: "snapshot", skuRef: "G7-REFILL", totalQuantity: quantity, forSaleQuantity: quantity,
      reservedOrUnavailableQuantity: 0, syncRunId: key }, inventoryClass: "sellable", lastSyncedAt: days(at, 1), staleAfter: days(at, 500) });
}
export async function deps(subscriptionId: string, scenario: "succeeded" | "declined" | "ambiguous", asOf = now) {
  const codec = api.createNativeRenewalCodec(), store = api.createPostgresRenewalStore(executor, codec);
  const rail = api.createPostgresSandboxRenewalRail(executor, { scenario, now: () => asOf });
  const execute = vi.spyOn(rail, "execute");
  const lifecycle = api.createPostgresRetryLifecycleBinding({ executor, async withTransaction(work) {
    const db = await runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }, settlement: db => settlement(codec, db), correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
  const input: AutomaticRenewalRunDeps = { store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
    inventory: inventory.createPostgresRenewalReservationPort(executor),
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

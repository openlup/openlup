import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { installSubscriptionConsumer } from "../helpers/installSubscriptionConsumer.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { selectPlatformMigrationManifest, evaluateSelectedPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresStartupOptions, assertQualifiedPostgresSession, qualifiedPostgresCatalogPayload } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import type { NativeRenewalPurchaseFacts, SubscriptionQueryExecutor, AutomaticRenewalRunDeps } from "@openlup/platform/subscriptions";
import type { RenewalSettlementPort, RenewalPreparedSettlement, RenewalReservationResult } from "@openlup/platform/subscriptions/contracts";

const scratch = resolve(".context/scratch/g2/method-health-installed");
const at = "2026-09-01T12:00:00.000Z";
const now = "2026-09-29T12:01:00.000Z";
let api: typeof import("@openlup/platform/subscriptions");
let payments: typeof import("@openlup/platform/payments");
let identity: typeof import("@openlup/platform/identity");
let fulfillment: typeof import("@openlup/platform/fulfillment");
let container: PostgresContainer | undefined, admin: Pool, migration: Pool, runtime: Pool;
let runtimeUrl: string;
const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "postgres", runtimeLogin: "g2_runtime", restoreLogin: "g2_restore" } as const;
const lock = "openlup:public-platform-migrations:v1";
const secret = "synthetic-conformance";
const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: "sandbox", authorizationRef: "sandbox-authorization",
  unattendedChargeAuthorizedAt: at, payerAccountRef: "sandbox-customer", methodRef: "sandbox-method", methodEvidenceRef: "sandbox-method-evidence",
  stockSourceKey: "g2-stock", templateId: "g2-refill", cadenceDays: 28, currency: "XXX",
  lines: [{ lineOrdinal: 1, sku: "G2-REFILL", quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0, acquisitionRef: null };
const executor: SubscriptionQueryExecutor = { query: (sql, values) => runtime.query(sql, values) };
async function rpc<T = Record<string, unknown>>(name: string, values: unknown[] = []): Promise<T> {
  return (await executor.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS result`, values)).rows[0].result as T;
}
beforeAll(async () => {
  const require = await installSubscriptionConsumer(scratch);
  const load = (key: string) => import(pathToFileURL(require.resolve(key)).href);
  api = await load("@openlup/platform/subscriptions"); payments = await load("@openlup/platform/payments");
  identity = await load("@openlup/platform/identity"); fulfillment = await load("@openlup/platform/fulfillment");
  const migrationsApi = await load("@openlup/platform/migrations");
  container = await runPostgresContainer({ name: `g2-health-${process.pid}`, password: secret, runOptions: ["-e", "PGDATA=/var/lib/postgresql/g2-data"] });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("G2 PostgreSQL unavailable");
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
  await admin.query(`INSERT INTO public.catalog_products(id,slug,name) VALUES('11111111-1111-4111-8111-111111111111','g2-refill','Refill');
    INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','G2-REFILL','Refill',true);
    INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES('33333333-3333-4333-8333-333333333333','Sandbox prices','AA','XXX','2026-01-01');
    INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','any',100,'2026-01-01');`);
  const stock = fulfillment.createPostgresFulfillmentStockSyncPort(executor, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] });
  await stock.recordProviderStockCurrent({ requestKey: "fixture-stock", snapshot: {
    providerRef: "sandbox-stock", collectedAt: at, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: "G2-REFILL", totalQuantity: 1000, forSaleQuantity: 1000, reservedOrUnavailableQuantity: 0, syncRunId: "g2-sync" },
    inventoryClass: "sellable", lastSyncedAt: at, staleAfter: "2027-01-01T00:00:00.000Z" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [admin, migration, runtime].filter(Boolean)); });

async function purchase(captured = true, declared = true) {
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: runtimeUrl });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: `${randomUUID()}@example.invalid`, principalId: randomUUID(), acquisitionSource: "fixture", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  // Purchase quote/draft remains an explicit fixture until joined proof. No
  // direct client, stock, settings, activation, terms, lines or method row writes.
  const quote = { context: { mode: "subscription", cadenceDays: 28 }, lines: [
    { sku: "G2-REFILL", quantity: 2, unitPriceGross: { amountMinor: 100, currency: "XXX" }, lineSubtotalGross: { amountMinor: 200, currency: "XXX" } }], totalGross: { amountMinor: 200, currency: "XXX" } };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", context: quote.context, lines: quote.lines, totals: { totalGross: { amountMinor: 200, currency: "XXX" } } };
  const key = randomUUID();
  const made = await rpc<{ orderDraft: { orderId: string } }>("commerce_create_order_draft_with_outbox", [key, JSON.stringify({ quote }), JSON.stringify(draft), clientId]);
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", 200, "XXX", "{}", at]);
  if (captured) await captureSandboxPurchase(payments.createPostgresSandboxPaymentSimulator(executor,
    { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
  { settlementIntentId: intent.settlement.id, key, at });
  if (declared) await rpc("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, at]);
  const settled = (await runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  return { orderId, clientId, capturedReference: settled.external_ref ?? settled.id, idempotencyKey: `activate:${key}` };
}
async function active() {
  const p = await purchase(); const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts });
  expect(result.renewalAttachment).toBe("complete");
  return { ...p, subscriptionId: String(result.activation.subscriptionId) };
}
function settlement(codec: ReturnType<typeof api.createNativeRenewalCodec>, db: SubscriptionQueryExecutor = executor): RenewalSettlementPort {
  const call = async <T = Record<string, unknown>>(name: string, values: unknown[]): Promise<T> => (await db.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS result`, values)).rows[0].result as T;
  return { prepareRenewal: i => call<RenewalPreparedSettlement>("commerce_prepare_subscription_renewal", [i.operationId, i.claimToken, i.now]),
    acknowledgeExternalAttempt: async i => codec.readback(await call("commerce_acknowledge_subscription_renewal_attempt", [i.operationId, i.operationFingerprint, i.externalAttemptRef, i.acknowledgedAt])),
    recordTerminalOutcome: async i => codec.readback(await call("commerce_record_subscription_renewal_outcome", [i.operationId, i.eventKey, i.operationFingerprint, i.outcome, i.externalRef ?? null, i.reason ?? null, i.occurredAt])) };
}
async function deps(subscriptionId: string, scenario: "succeeded" | "declined" | "ambiguous", asOf = now) {
  const codec = api.createNativeRenewalCodec(), store = api.createPostgresRenewalStore(executor, codec);
  const rail = api.createPostgresSandboxRenewalRail(executor, { scenario, now: () => now });
  const execute = vi.spyOn(rail, "execute");
  const lifecycle = api.createPostgresRetryLifecycleBinding({ executor, async withTransaction(work) {
    const db = await runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }, settlement: db => settlement(codec, db), correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
  const input: AutomaticRenewalRunDeps = { store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
    inventory: { expireReservations: async () => 0, reserve: i => rpc<RenewalReservationResult>("fulfillment_reserve_subscription_renewal", [i.operationId, i.claimToken, 900, i.now]) },
    paymentRails: { resolve: channel => channel === "sandbox" ? rail : null }, workerId: "g2-worker", policy: api.createSandboxRenewalPolicy(facts.methodRef) };
  const due = (await store.listDue(500, asOf)).find(row => row.subscriptionId === subscriptionId)!;
  expect(due).toBeDefined();
  return { input, due, codec, rail, execute };
}

// The existing composition suite remains unchanged and proves legacy terms
// without a method-state row still renew. This separate fixture exercises the
// opposite boundary through the purchase writer and real restricted-role RPCs.
it.each(["method_missing", "mandate_not_chargeable_unattended", "pending_activation"] as const)(
  "refuses a purchased subscription with explicit %s health before provider execution", async healthState => {
    const f = await active(), writer = api.createPostgresPurchaseRenewalWriter(executor);
    expect((await runtime.query(`SELECT count(*)::integer AS paired
      FROM public.subscription_renewal_terms t JOIN public.subscription_method_states m
      ON m.subscription_id=t.subscription_id WHERE t.subscription_id=$1 AND m.health_state='healthy'`,
    [f.subscriptionId])).rows).toEqual([{ paired: 1 }]);
    const ready = await deps(f.subscriptionId, "succeeded");
    expect(await ready.input.store.readMandateEvidence(ready.due)).toMatchObject({ authorized: true });
    await writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: `health:${f.subscriptionId}`,
      expectedState: "healthy", healthState, methodRef: facts.methodRef, evidenceRef: `sandbox-${healthState}` });
    expect(await ready.input.store.readMandateEvidence(ready.due)).toMatchObject({ authorized: false });
    expect(await api.runOneAutomaticSubscriptionRenewal(ready.input, ready.due, now))
      .toMatchObject({ status: "refused", reason: "authorization_evidence_mismatch" });
    expect(ready.execute).not.toHaveBeenCalled();
    expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows)
      .toEqual([{ status: "active" }]);
  });

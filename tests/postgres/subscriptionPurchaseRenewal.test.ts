import { installSubscriptionConsumer } from "../helpers/installSubscriptionConsumer.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { resolveSubscriptionActivationBinding } from "../../server/runtime/customers/subscriptionActivationBinding.js";
import { selectPlatformMigrationManifest, evaluateSelectedPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresStartupOptions, assertQualifiedPostgresSession, qualifiedPostgresCatalogPayload } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import type { NativeRenewalPurchaseFacts, SubscriptionQueryExecutor, AutomaticRenewalRunDeps } from "@openlup/platform/subscriptions";
import type { RenewalSettlementPort, RenewalPreparedSettlement, RenewalReservationResult } from "@openlup/platform/subscriptions/contracts";

const exec = promisify(execFile);
const scratch = resolve(".context/scratch/g2/installed");
const at = "2026-09-01T12:00:00.000Z";
const now = "2026-09-29T12:01:00.000Z", later = "2026-09-29T12:08:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
  container = await runPostgresContainer({ name: `g2-purchase-${process.pid}`, password: secret, runOptions: ["-e", "PGDATA=/var/lib/postgresql/g2-data"] });
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
  // G5 purchase quote/draft remains an explicit fixture until joined proof. No
  // direct client, stock, settings, activation, terms, lines or method row writes.
  const quote = { context: { mode: "subscription", cadenceDays: 28 }, lines: [
    { sku: "G2-REFILL", quantity: 2, unitPriceGross: { amountMinor: 100, currency: "XXX" }, lineSubtotalGross: { amountMinor: 200, currency: "XXX" } }], totalGross: { amountMinor: 200, currency: "XXX" } };
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

it("repairs a real paid activation gap through the production binding's unswitched runtime login", async () => {
  // The direct cron resolves this binding over DATABASE_URL; it does not use
  // DataGateway.asService or SET ROLE. Test that exact composition, not an owner.
  const directUrl = new URL(runtimeUrl); directUrl.searchParams.delete("options");
  const direct = new Pool({ connectionString: directUrl.toString() });
  try {
    expect((await direct.query(`SELECT current_user,session_user,rolsuper,rolbypassrls,
      pg_has_role(current_user,'service_role','USAGE') AS inherits_service
      FROM pg_roles WHERE rolname=current_user`)).rows).toEqual([{
      current_user: selection.runtimeLogin, session_user: selection.runtimeLogin,
      rolsuper: false, rolbypassrls: false, inherits_service: true,
    }]);
    const p = await purchase(), writer = api.createPostgresPurchaseRenewalWriter(direct);
    expect((await direct.query("SELECT public.subscription_paid_activation_gap_open($1::uuid) AS gap", [p.orderId])).rows[0].gap).toBe(true);
    await writer.register(p.orderId, facts);
    const binding = resolveSubscriptionActivationBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: directUrl.toString() });
    expect(binding).not.toBeNull();
    expect(await binding!.run(activation => activation.reconcilePaidActivationGaps(1))).toEqual({ repaired: 1, overdue: 0 });
    const activation = (await direct.query("SELECT state,repaired,subscription_id FROM public.subscription_activations WHERE order_id=$1", [p.orderId])).rows[0];
    expect(activation).toMatchObject({ state: "active", repaired: true });
    expect(typeof activation.subscription_id).toBe("string");
    expect(await writer.pending()).toContainEqual({ orderId: p.orderId, subscriptionId: activation.subscription_id, hasPurchaseFacts: true });
    expect(await writer.complete(p.orderId)).toMatchObject({ subscriptionId: activation.subscription_id, replayed: false });
    expect(await writer.complete(p.orderId)).toMatchObject({ replayed: true });
    expect(await writer.readMethod(activation.subscription_id)).toMatchObject({ healthState: "healthy", methodRef: facts.methodRef });
    expect((await direct.query(`SELECT s.status,(SELECT count(*)::integer FROM public.subscription_renewal_terms t WHERE t.subscription_id=s.id) AS terms,
      (SELECT count(*)::integer FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=s.id) AS lines
      FROM public.subscriptions s WHERE s.id=$1`, [activation.subscription_id])).rows).toEqual([{ status: "active", terms: 1, lines: 1 }]);
    expect(await binding!.run(adapter => adapter.reconcilePaidActivationGaps(1))).toEqual({ repaired: 0, overdue: 0 });
  } finally { await direct.end(); }
});

it("completes a purchase through bounded runtime writers; replay, changed facts and actual health transitions are durable", async () => {
  const f = await active(), writer = api.createPostgresPurchaseRenewalWriter(executor);
  expect(await rpc("subscription_renewal_purchase_facts", [f.subscriptionId])).toEqual({
    templateId: facts.templateId, shippingAmountMinor: 0, acquisitionRef: null,
  });
  expect(await rpc("subscription_renewal_purchase_facts", [randomUUID()])).toBeNull();
  expect(await writer.register(f.orderId, facts)).toMatchObject({ replayed: true });
  await expect(writer.register(f.orderId, { ...facts, authorizationRef: "changed" })).rejects.toThrow("purchase_conflict");
  await expect(api.activateNativePurchaseWithRenewal(executor, { ...f, facts: { ...facts, authorizationRef: "changed" } })).rejects.toThrow("purchase_conflict");
  const completed = await Promise.all([writer.complete(f.orderId), writer.complete(f.orderId)]);
  expect(completed.every(row => row.replayed === true)).toBe(true);
  expect(await writer.readMethod(f.subscriptionId)).toMatchObject({ healthState: "healthy", methodRef: facts.methodRef });
  const change = { subscriptionId: f.subscriptionId, eventKey: `missing:${f.subscriptionId}`, expectedState: "healthy" as const,
    healthState: "method_missing" as const, methodRef: facts.methodRef, evidenceRef: "sandbox-method-missing" };
  expect(await writer.transitionMethod(change)).toMatchObject({ healthState: "method_missing", replayed: false });
  expect(await writer.transitionMethod(change)).toMatchObject({ replayed: true });
  await writer.complete(f.orderId);
  expect(await writer.readMethod(f.subscriptionId)).toMatchObject({ healthState: "method_missing" });
  await expect(writer.transitionMethod({ ...change, evidenceRef: "changed" })).rejects.toThrow("method_conflict");
  await expect(writer.transitionMethod({ ...change, eventKey: `stale:${f.subscriptionId}` })).rejects.toThrow("method_stale");
  const ready = await deps(f.subscriptionId, "succeeded");
  expect(await ready.input.store.readMandateEvidence(ready.due)).toMatchObject({ authorized: false });
  await writer.transitionMethod({ ...change, eventKey: `repair:${f.subscriptionId}`, expectedState: "method_missing", healthState: "healthy", evidenceRef: "sandbox-repaired" });
  await writer.transitionMethod(change);
  expect(await writer.readMethod(f.subscriptionId)).toMatchObject({ healthState: "healthy", evidenceRef: "sandbox-repaired" });
  expect(await ready.input.store.readMandateEvidence(ready.due)).toMatchObject({ authorized: true });
  for (const table of ["subscription_renewal_terms", "subscription_method_states", "subscription_renewal_attachments"]) {
    await expect(runtime.query(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: "42501" });
  }
});

it("keeps both new tables inaccessible to the restricted runtime and authenticated role", async () => {
  const foreignKeys = (await admin.query(`SELECT confdeltype,condeferrable FROM pg_constraint
    WHERE contype='f' AND conrelid IN ('public.subscription_renewal_attachments'::regclass,
      'public.subscription_method_state_events'::regclass)`)).rows;
  expect(foreignKeys).toHaveLength(3);
  expect(foreignKeys.every(row => row.confdeltype === "a" && row.condeferrable === false)).toBe(true);
  const url = new URL(runtimeUrl); url.searchParams.set("options", "-c role=authenticated");
  const browser = new Pool({ connectionString: url.toString() });
  try {
    for (const [db, role] of [[runtime, "service_role"], [browser, "authenticated"]] as const) {
      expect((await db.query("SELECT current_user")).rows[0].current_user).toBe(role);
      for (const table of ["subscription_renewal_attachments", "subscription_method_state_events"]) {
        const privileges = (await db.query(`SELECT privilege,has_table_privilege(current_user,$1,privilege) AS allowed
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege`, [`public.${table}`])).rows;
        expect(privileges.every(row => row.allowed === false)).toBe(true);
        for (const sql of [`SELECT * FROM public.${table}`, `INSERT INTO public.${table} DEFAULT VALUES`,
          `UPDATE public.${table} SET created_at=now() WHERE false`, `DELETE FROM public.${table} WHERE false`]) {
          await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
        }
      }
    }
    await expect(browser.query("SELECT public.subscription_pending_renewal_attachments(1)")).rejects.toMatchObject({ code: "42501" });
    await expect(browser.query("SELECT public.subscription_renewal_purchase_facts($1::uuid)", [randomUUID()])).rejects.toMatchObject({ code: "42501" });
  } finally { await browser.end(); }
});

it("narrows installer default table grants to PUBLIC and all three named roles", async () => {
  // Isolated ACL fixture: no defaults or grants change on the money-proof database.
  // Apply the slot's exact narrowing statements to newly default-granted names.
  await admin.query("CREATE DATABASE g2_default_grants");
  const url = new URL(container!.connectionString); url.pathname = "/g2_default_grants";
  const owner = new Pool({ connectionString: url.toString() });
  const tables = ["subscription_renewal_attachments", "subscription_method_state_events"];
  try {
    await owner.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role");
    for (const table of tables) await owner.query(`CREATE TABLE public.${table}(id integer)`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of tables) expect((await owner.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed", [role, `public.${table}`])).rows[0].allowed).toBe(true);
    }
    const sql = readFileSync("db/platform/migrations/20261101223000_subscription_purchase_renewal.sql", "utf8");
    const narrowing = sql.slice(sql.indexOf("REVOKE ALL ON TABLE"));
    await owner.query(narrowing);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of tables) {
        const privileges = (await owner.query(`SELECT has_table_privilege($1,$2,privilege) AS allowed
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege`, [role, `public.${table}`])).rows;
        expect(privileges.every(row => row.allowed === false)).toBe(true);
      }
      const login = new URL(runtimeUrl); login.pathname = "/g2_default_grants"; login.searchParams.set("options", `-c role=${role}`);
      const restricted = new Pool({ connectionString: login.toString() });
      try {
        for (const table of tables) await expect(restricted.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
      } finally { await restricted.end(); }
    }
  } finally {
    await owner.end();
    await admin.query("DROP DATABASE g2_default_grants");
  }
});

it("refuses malformed facts, unsupported real rails, unavailable declarations and browser execution", async () => {
  const p = await purchase(), writer = api.createPostgresPurchaseRenewalWriter(executor);
  for (const delta of [{ settlementChannelKey: "real-provider" }, { currency: "usd" }, { cadenceDays: 27 }, { templateVersion: 0 },
    { shippingAmountMinor: 1 }, { authorizationRef: " " }, { unattendedChargeAuthorizedAt: "infinity" }, { payerAccountRef: "" },
    { acquisitionRef: {} }, { _host: {} }, { lines: [] }, { lines: [{ ...facts.lines[0], quantity: 0 }] },
    { lines: [{ ...facts.lines[0], unitAmountMinor: -1 }] }, { lines: [{ ...facts.lines[0], unitAmountMinor: 0 }] },
    { lines: [{ ...facts.lines[0], quantity: "2" }] }, { lines: [facts.lines[0], facts.lines[0]] },
    { lines: [facts.lines[0], { ...facts.lines[0], sku: "OTHER" }] }]) {
    await expect(writer.register(p.orderId, { ...facts, ...delta } as NativeRenewalPurchaseFacts)).rejects.toThrow();
  }
  await expect(writer.register(randomUUID(), facts)).rejects.toThrow("order_missing");
  await expect(writer.complete(p.orderId)).rejects.toThrow("not_ready");
  const unpaid = await purchase(false, false);
  // The pre-existing compensation RPC lacks a runtime table grant. G4 owns
  // that repair; do not elevate the caller or widen a grant in G2.
  await expect(rpc("commerce_compensate_abandoned_checkout", [`cancel:${unpaid.orderId}`, unpaid.orderId, "fixture_cancel", at])).rejects.toMatchObject({ code: "42501" });
  await expect(writer.register(unpaid.orderId, facts)).rejects.toThrow("not_declared");
  await expect(writer.transitionMethod({ subscriptionId: randomUUID(), eventKey: "missing-method", expectedState: "healthy",
    healthState: "healthy", methodRef: "method", evidenceRef: "evidence" })).rejects.toThrow("method_missing");
  expect(await writer.readMethod(randomUUID())).toBeNull();
  const f = await active();
  await expect(writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: "invalid-method", expectedState: "healthy",
    healthState: "healthy", methodRef: "method", evidenceRef: "" })).rejects.toThrow("method_invalid");
  for (const role of ["anon", "authenticated"]) {
    const permissions = (await admin.query(`SELECT has_function_privilege($1,'public.subscription_register_renewal_purchase(uuid,jsonb)','EXECUTE') AS register,
      has_function_privilege($1,'public.subscription_complete_renewal_attachment(uuid)','EXECUTE') AS complete,
      has_function_privilege($1,'public.subscription_transition_sandbox_method(uuid,text,text,text,text,text)','EXECUTE') AS method,
      has_function_privilege($1,'public.subscription_record_sandbox_renewal_observation(uuid,text,text,text,timestamptz)','EXECUTE') AS observation,
      has_function_privilege($1,'public.subscription_pending_renewal_attachments(integer)','EXECUTE') AS pending,
      has_function_privilege($1,'public.subscription_renewal_purchase_facts(uuid)','EXECUTE') AS facts`, [role])).rows[0];
    expect(permissions).toEqual({ register: false, complete: false, method: false, observation: false, pending: false, facts: false });
  }
});

it("an attachment failure leaves paid service active with restartable saved facts and no partial renewal rows", async () => {
  const p = await purchase();
  const failing: SubscriptionQueryExecutor = { query(sql, values) {
    if (sql.includes("subscription_complete_renewal_attachment")) throw new Error("synthetic writer loss");
    return executor.query(sql, values);
  } };
  const result = await api.activateNativePurchaseWithRenewal(failing, { ...p, facts });
  expect(result.renewalAttachment).toBe("pending");
  const sub = String(result.activation.subscriptionId);
  expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [sub])).rows[0].status).toBe("active");
  expect(await api.createPostgresPurchaseRenewalWriter(executor).pending()).toContainEqual({ orderId: p.orderId, subscriptionId: sub, hasPurchaseFacts: true });
  expect(await api.createPostgresPurchaseRenewalWriter(executor).pending(0)).toEqual([
    { orderId: p.orderId, subscriptionId: sub, hasPurchaseFacts: true },
  ]);
  expect(await rpc("subscription_renewal_purchase_facts", [sub])).toBeNull();
  // A database failure inside materialization rolls back header and lines too.
  const locked = await admin.connect(); await locked.query("BEGIN");
  await locked.query("LOCK TABLE public.subscription_method_states IN ACCESS EXCLUSIVE MODE");
  const db = await runtime.connect(); await db.query("SET lock_timeout='100ms'");
  try { await expect(api.createPostgresPurchaseRenewalWriter(db).complete(p.orderId)).rejects.toMatchObject({ code: "55P03" }); }
  finally { await db.query("RESET lock_timeout"); db.release(); await locked.query("ROLLBACK"); locked.release(); }
  expect((await runtime.query("SELECT count(*)::int AS n FROM public.subscription_renewal_terms WHERE subscription_id=$1", [sub])).rows[0].n).toBe(0);
  const child = `import {argv} from 'node:process';import {createPostgresPurchaseRenewalWriter} from '@openlup/platform/subscriptions';import pg from 'pg';
    const p=new pg.Pool({connectionString:argv[1]});
    console.log(JSON.stringify(await createPostgresPurchaseRenewalWriter(p).complete(argv[2])));await p.end();`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", child, runtimeUrl, p.orderId], { cwd: scratch });
  expect(JSON.parse(stdout)).toMatchObject({ subscriptionId: sub, replayed: false });
  const invalid = await purchase();
  const pending = await api.activateNativePurchaseWithRenewal(executor, { ...invalid, facts: { ...facts, currency: "invalid" } });
  expect(pending).toMatchObject({ renewalAttachment: "pending", activation: { state: "active" } });
  expect(await api.createPostgresPurchaseRenewalWriter(executor).pending()).toContainEqual({ orderId: invalid.orderId,
    subscriptionId: pending.activation.subscriptionId, hasPurchaseFacts: false });
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(invalid.orderId, facts);
  const race = await Promise.all([writer.complete(invalid.orderId), writer.complete(invalid.orderId)]);
  expect(race.map(row => row.replayed).sort()).toEqual([false, true]);
});

it("freezes a complete production snapshot, rejects tampering, and a fresh installed process decodes database bytes alone", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.cycle).toMatchObject({ status: "correlated", logicalCycleNumber: 2, nativeRenewalCounter: 1 });
  expect(snapshot.orderSnapshot).toMatchObject({ shippingAddressRef: null, shippingQuoteRef: null });
  const claim = await d.input.store.claimDue({ snapshot, workerId: "g2-freeze", now });
  const wire = d.codec.encode(snapshot), bytes = JSON.stringify(wire);
  expect(bytes).not.toContain("_host");
  expect(JSON.stringify(d.codec.encode(d.codec.decode(wire)))).toBe(bytes);
  expect(() => d.codec.decode({ ...wire, currency: "EUR" })).toThrow();
  expect(() => d.codec.decode({ ...wire, _host: {} })).toThrow();
  const child = `import {argv} from 'node:process';import {createNativeRenewalCodec} from '@openlup/platform/subscriptions';import pg from 'pg';
    const p=new pg.Pool({connectionString:argv[1]});const r=await p.query('SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1',[argv[2]]);
    const c=createNativeRenewalCodec();console.log(JSON.stringify(c.encode(c.decode(r.rows[0].cycle_snapshot))));await p.end();`;
  await runtime.end(); await admin.end(); await migration.end();
  // This fixture places PGDATA in its disposable writable container layer,
  // outside the helper's tmpfs, so a real container restart retains the DB.
  await exec("docker", ["restart", `g2-purchase-${process.pid}`]);
  const { stdout: endpoint } = await exec("docker", ["inspect", "--format", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', `g2-purchase-${process.pid}`]);
  const restarted = new URL(container!.connectionString); restarted.port = endpoint.trim();
  container!.connectionString = restarted.toString();
  const runtimeEndpoint = new URL(runtimeUrl); runtimeEndpoint.port = endpoint.trim(); runtimeUrl = runtimeEndpoint.toString();
  expect(await waitForPostgresTcpReady(container!.connectionString)).toBe(true);
  admin = new Pool({ connectionString: container!.connectionString }); runtime = new Pool({ connectionString: runtimeUrl });
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", child, runtimeUrl, claim.operationId], { cwd: scratch });
  expect(stdout.trim()).toBe(bytes);
  expect(await d.input.store.buildCycleSnapshots(d.due)).toEqual(snapshot);
  await expect(d.input.store.claimDue({ snapshot: { ...snapshot, frozenFingerprint: "0".repeat(64) }, workerId: "changed", now })).rejects.toThrow();
});

it.each(["succeeded", "declined"] as const)("runs sandbox renewal %s from an installed package without hand-written terms or method rows", async scenario => {
  const f = await active(), d = await deps(f.subscriptionId, scenario);
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  expect(result.status).toBe(scenario === "succeeded" ? "succeeded" : "refused"); expect(d.execute).toHaveBeenCalledTimes(1);
  expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].status).toBe("active");
  if (scenario === "succeeded") {
    // G7 owns this known terminal public-run replay defect; no second dispatch.
    expect((await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, later)).status).toBe("terminal_replay");
  } else {
    expect((await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, later)).status).toBe("terminal_replay");
    expect((await runtime.query("SELECT count(*)::int n FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscriptionId])).rows[0].n).toBe(1);
  }
  expect(d.execute).toHaveBeenCalledTimes(1);
});

it("a stale method selection is refused before dispatch rather than stranded as ambiguous", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "succeeded");
  d.input.policy = api.createSandboxRenewalPolicy("stale-method");
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  expect(result).toMatchObject({ status: "refused", reason: "sandbox_method_unavailable" });
  expect(await d.input.store.readRenewal(result.identityKey)).toMatchObject({ state: "refused", externalAttemptRef: null });
  expect((await runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].status).toBe("active");
});

it("ambiguous dispatch survives a fresh process, never redispatches, and only matching late evidence can settle", async () => {
  const f = await active(), d = await deps(f.subscriptionId, "ambiguous");
  const first = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  expect(first.status).toBe("awaiting_provider"); expect(d.execute).toHaveBeenCalledTimes(1);
  const op = (await d.input.store.readRenewal(first.identityKey))!;
  const child = `import {argv} from 'node:process';import {createNativeRenewalCodec,createPostgresRenewalStore,createPostgresSandboxRenewalRail,createSandboxRenewalPolicy,runOneAutomaticSubscriptionRenewal} from '@openlup/platform/subscriptions';import pg from 'pg';
    const p=new pg.Pool({connectionString:argv[1]});const store=createPostgresRenewalStore(p,createNativeRenewalCodec());
    const due=(await store.listDue(500,'${later}')).find(x=>x.subscriptionId===argv[2]);const rail=createPostgresSandboxRenewalRail(p,{scenario:'succeeded'});
    let executions=0;rail.execute=async()=>{executions++;throw Error('forbidden redispatch');};const forbidden=async()=>{throw Error('unexpected preparation');};
    const result=await runOneAutomaticSubscriptionRenewal({store,settlement:{prepareRenewal:forbidden,acknowledgeExternalAttempt:forbidden,recordTerminalOutcome:forbidden},failureHandoff:{handoffFailure:forbidden},
      inventory:{expireReservations:forbidden,reserve:forbidden},paymentRails:{resolve:()=>rail},workerId:'g2-new-process',policy:createSandboxRenewalPolicy('sandbox-method')},due,'${later}');
    console.log(JSON.stringify({result,executions}));await p.end();`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", child, runtimeUrl, f.subscriptionId], { cwd: scratch });
  expect(JSON.parse(stdout)).toMatchObject({ result: { status: "awaiting_provider" }, executions: 0 });
  const resumed = await deps(f.subscriptionId, "ambiguous", "2026-09-29T12:15:00.000Z");
  expect(resumed.execute).not.toHaveBeenCalled();
  const observation = { operationId: op.operationId, fingerprint: op.operationFingerprint,
    externalAttemptRef: op.externalAttemptRef!, outcome: "succeeded" as const, occurredAt: later };
  await expect(resumed.rail.observe({ ...observation, fingerprint: "0".repeat(64) })).rejects.toThrow("observation_invalid");
  await resumed.rail.observe(observation); await resumed.rail.observe(observation);
  await expect(resumed.rail.observe({ ...observation, outcome: "refused" })).rejects.toThrow("observation_conflict");
  expect((await api.runOneAutomaticSubscriptionRenewal(resumed.input, resumed.due, "2026-09-29T12:15:00.000Z")).status).toBe("succeeded");
  expect(resumed.execute).not.toHaveBeenCalled();
});

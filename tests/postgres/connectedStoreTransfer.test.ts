import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { createPostgresAbandonedCheckoutCompensationPort, createPostgresPurchaseReservationPort, type PurchaseReservationInput } from "@openlup/platform/inventory";
import { createPostgresDestinationPort, type DestinationDocument } from "@openlup/platform/commerce/server/destinations";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import * as jose from "jose";
import * as renewal from "@openlup/platform/subscriptions";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import type { RenewalPreparedSettlement, RenewalReservationResult, RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createCapturedTransactionalDelivery, createPostgresTransactionalDeliveryStore, createTransactionalDelivery, createPostgresDeliveryReconciliationPort } from "@openlup/platform/communications";
import { refusedNoticeSources, noticeSessionWithRecipientFault } from "./m19NoticeFixture.js";
import { createOidcIdentityVerifier, createPostgresAccountLinkStore, createPostgresCustomerMePort, deriveOidcPrincipalId } from "@openlup/platform/identity";
import { createPostgresPaymentTruthPort, createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import type { SandboxPaymentAttempt, SandboxPaymentOutcome } from "@openlup/platform/payments/contracts";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore, connectedNativeStoreTables, connectedStoreClusterIdentitySql, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { mapManagedIdentityForConnectedRestore, restoreConnectedNativeStore, type ManagedIdentityMappingSource } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresPartnerAcquisitionPort } from "../../server/adapters/postgres/partners/partnerAcquisitionRoutines.js";
import { createPartnerAcquisitionSubmitHandler } from "../../server/bff/partners/partnerAcquisitionDirect.js";
import type { VercelResponse } from "../../server/_lib/types/vercel.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem, type OrderReviewMediaFilesystemCensus } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { createOrderReviewMediaTransferReader } from "../../server/adapters/filesystem/orderReviewMediaTransferReader.js";
import { restoreOrderReviewMediaFilesystem } from "../../server/adapters/filesystem/orderReviewMediaTransferRestore.js";
import { fixture, openCase, replacement } from "../helpers/fulfillmentNative.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const containers: PostgresContainer[] = [], pools: Pool[] = [], ports: { close(): Promise<void> }[] = [];
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
const selectedUnits = [selected.baseline, ...selected.forward];
type Installation = { owner: Pool; ownerUrl: string; runtime: Pool; restore: Pool; runtimeUrl: string };
let targetNumber = 0;
let source: Installation, target: Installation, pristine: ConnectedNativeStoreCapture, packet: ConnectedNativeStoreCapture;
let graph: Awaited<ReturnType<typeof fixture>>, successor: string, prunedHold: string, retainedHold: string, erased: string;
let purchaseHold: PurchaseReservationInput, purchaseHoldId: string;
let retainedCancellation: { idempotencyKey: string; orderId: string; reason: string };
let identity: Awaited<ReturnType<typeof identityFixture>>;
let consent: Awaited<ReturnType<typeof consentFixture>>;

let payments: Awaited<ReturnType<typeof paymentTransferFixture>>;
const paymentOptions = { dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment_recovered" };
const paymentAt = "2026-10-30T12:00:00.123Z";
let retainedDestination: DestinationDocument;
let destinationCommand: { operator: string; subscription: string; payload: object; key: string; version: number };
let media: { parent: string; sourceRoot: string; targetRoot: string; grant: string; confirmedRef: string; pendingRef: string;
  cleanupRef: string; partialTemp: string; census: OrderReviewMediaFilesystemCensus } | undefined;
const mediaLimits = { maximumFiles: 20, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
const renewalAt = "2026-09-01T12:00:00.000Z", renewalDue = "2026-09-29T12:01:00.000Z";
// Identifying-looking synthetic references deliberately demonstrate that the
// sandbox channel check does not enforce nonpersonal reference contents.
const renewalFacts: renewal.NativeRenewalPurchaseFacts = {
  settlementChannelKey: "sandbox", authorizationRef: "sandbox-authorization:customer@example.invalid",
  unattendedChargeAuthorizedAt: renewalAt, payerAccountRef: "payer@example.invalid",
  methodRef: "sandbox-method:customer@example.invalid", methodEvidenceRef: "sandbox-evidence:customer@example.invalid",
  stockSourceKey: "transfer-renewal", templateId: "transfer-refill", cadenceDays: 28, currency: "XXX",
  lines: [{ lineOrdinal: 1, sku: "retained-sku", quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0,
  acquisitionRef: "acquisition:customer@example.invalid",
};
let retainedRenewal: { orderId: string; subscriptionId: string }, pendingRenewal: typeof retainedRenewal;
const terminalNotices: { source: "event" | "reminder"; id: string }[] = [];
async function dispatchNotices(installation: Installation, unresolvedClients: ReadonlySet<string> = new Set()) {
  const store = createPostgresTransactionalDeliveryStore({ connectionString: installation.runtimeUrl });
  const captured: string[] = [];
  try {
    const delivery = createTransactionalDelivery({ store, delivery: createCapturedTransactionalDelivery({ outcome: command => {
      captured.push(command.idempotencyKey); return { state: "accepted" };
    } }) });
    const binding = renewal.createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: store.readReceipt },
      async withSession(work) { const db = await installation.runtime.connect(); try { return await work(noticeSessionWithRecipientFault(db, unresolvedClients)); } finally { db.release(); } },
      async bind(notice) { return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug }; },
    });
    await binding.run(100);
    return captured;
  } finally { await store.close(); }
}


async function renewalPurchase(complete: boolean) {
  const call = async (name: string, values: unknown[]) => (await source.runtime.query(
    `SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) AS value`, values)).rows[0].value;
  const key = randomUUID();
  // Match the retained-transfer suite's existing order fixture. G5 owns
  // checkout draft receipts; every G2 row below is produced by its real writer.
  const orderId = randomUUID(), order = await source.owner.connect();
  try {
    await order.query("BEGIN");
    await order.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',200)", [orderId, graph.client]);
    await order.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,sku_id,quantity,unit_amount_minor,line_amount_minor) SELECT $1,1,id,2,100,200 FROM public.catalog_skus WHERE sku='retained-sku'", [orderId]);
    await order.query("COMMIT");
  } catch (error) { await order.query("ROLLBACK"); throw error; } finally { order.release(); }
  const intent = await call("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", 200, "XXX", "{}", renewalAt]);
  await captureSandboxPurchase(paymentPort(source.runtime), { settlementIntentId: intent.settlement.id, key, at: renewalAt });
  await call("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, renewalAt]);
  const writer = renewal.createPostgresPurchaseRenewalWriter(source.runtime);
  await writer.register(orderId, renewalFacts);
  const intentRow = (await source.runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  const fingerprint = createHash("sha256").update(intentRow.external_ref ?? intentRow.id).digest("hex");
  const activated = await call("subscription_activate_from_captured_payment", [`activate:${key}`, orderId, fingerprint]);
  if (complete) {
    await writer.complete(orderId);
    const change = { subscriptionId: activated.subscriptionId, eventKey: `missing:${orderId}`, expectedState: "healthy" as const,
      healthState: "method_missing" as const, methodRef: renewalFacts.methodRef, evidenceRef: "sandbox-missing:customer@example.invalid" };
    await writer.transitionMethod(change);
    await writer.transitionMethod({ ...change, eventKey: `repair:${orderId}`, expectedState: "method_missing", healthState: "healthy",
      evidenceRef: "sandbox-repaired:customer@example.invalid" });
    // Explicit synthetic delivered-parcel fact for the carried enforcing
    // alignment policy. Never confirm the original fixture's undelivered replacement.
    const shipment = randomUUID();
    await source.owner.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'fixture-port','3pl',$3)", [shipment, orderId, `transfer-parcel:${orderId}`]);
    await source.runtime.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)",
      [`transfer-arrival:${orderId}`, shipment, "2026-09-02T12:00:00.000Z", `evidence:transfer-arrival:${orderId}`]);
  }
  return { orderId, subscriptionId: String(activated.subscriptionId) };
}

function pool(connectionString: string): Pool { const result = new Pool({ connectionString }); pools.push(result); return result; }
async function installation(label: string): Promise<Installation> {
  const container = await runPostgresContainer({ name: `m14-connected-${label}-${process.pid}`, password: "synthetic-transfer" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Connected transfer PostgreSQL unavailable");
  const bootstrap = pool(container.connectionString);
  await bootstrap.query(`CREATE ROLE transfer_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
    ALTER DATABASE postgres OWNER TO transfer_owner;
    CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
    CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer'`);
  const url = (login: string, startup = false) => {
    const value = new URL(container.connectionString); value.username = login;
    if (startup) value.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    return value.toString();
  };
  const owner = pool(url(selection.migrationLogin, true));
  const runner = createPostgresMigrationRunner({ connectionString: url(selection.migrationLogin) }, { installation: selection, poolFactory: () => owner });
  expect((await runner.apply()).applied).toEqual(selectedUnits.map(unit => unit.file));
  expect((await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual(selectedUnits.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
  expect((await runner.status()).pending).toEqual([]);
  return { owner, ownerUrl: url(selection.migrationLogin, true), runtime: pool(url(selection.runtimeLogin)), restore: pool(url(selection.restoreLogin!)), runtimeUrl: url(selection.runtimeLogin) };
}
async function capture(db: Pool, sourceId: string, limits = { maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 }): Promise<ConnectedNativeStoreCapture> {
  return captureConnectedNativeStore({ sourceId, catalogueId: selected.objectInventorySha256, ...limits,
    source: { async withSnapshot(work) {
      const client = await db.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } },
  });
}
function paymentPort(db: Pool) { return createPostgresSandboxPaymentSimulator(db, paymentOptions); }
function paymentReceive(db: Pool, attempt: SandboxPaymentAttempt, observationId: string) {
  return paymentPort(db).ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
    settlementIntentId: attempt.settlementIntentId, attemptId: attempt.id, observationId,
  })), headers: {}, receivedAt: paymentAt });
}
async function paymentObservation(db: Pool, attempt: SandboxPaymentAttempt, outcome: SandboxPaymentOutcome) {
  const input = { attemptId: attempt.id, idempotencyKey: `observation:${randomUUID()}`, outcome, occurredAt: paymentAt,
    payerEmail: "dispatch-only@example.invalid", rawPayload: { contact: "dispatch-only@example.invalid" } };
  const observation = await paymentPort(db).recordObservation(input);
  return { input, ...observation };
}
async function paymentFixture() {
  const clientId = randomUUID(), orderId = randomUUID(), writer = await source.owner.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [clientId, `${clientId}@example.invalid`]);
    await writer.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)", [orderId, clientId]);
    await writer.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)", [orderId]);
    await writer.query("COMMIT");
  } catch (error) { await writer.query("ROLLBACK"); throw error; } finally { writer.release(); }
  await source.runtime.query("SELECT public.commerce_open_settlement_intent($1,$2,'sandbox',900,'XXX','{}'::jsonb,$3)", [`open:${orderId}`, orderId, paymentAt]);
  const intentId = (await source.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1", [orderId])).rows[0].id as string;
  const input = { settlementIntentId: intentId, idempotencyKey: `attempt:${randomUUID()}`, requestFingerprint: "b".repeat(64), at: paymentAt };
  const extraFacts = { authorizationRef: "sandbox:authorization", unattendedChargeAuthorizedAt: paymentAt,
    payerAccountRef: "sandbox:payer", methodRef: "sandbox:method", methodEvidenceRef: "sandbox:evidence", payerEmail: "dispatch-only@example.invalid" };
  await expect(paymentPort(source.runtime).beginAttempt({ ...input, methodFacts: extraFacts })).rejects.toThrow("payment_simulator_method_facts_invalid");
  return { orderId, intentId, input, attempt: await paymentPort(source.runtime).beginAttempt(input) };
}
async function paymentTransferFixture() {
  const open = await paymentFixture(), fenced = await paymentFixture(), pending = await paymentFixture(), review = await paymentFixture();
  const refused = await paymentObservation(source.runtime, fenced.attempt, "refused");
  expect((await paymentReceive(source.runtime, fenced.attempt, refused.id)).status).toBe(200);
  const nextInput = { ...fenced.input, idempotencyKey: `attempt:${randomUUID()}` };
  const active = await paymentPort(source.runtime).beginAttempt(nextInput);
  const unknown = await paymentObservation(source.runtime, active, "indeterminate");
  expect((await paymentReceive(source.runtime, active, unknown.id)).status).toBe(200);
  const captured = await paymentObservation(source.runtime, pending.attempt, "captured");
  await source.runtime.query("SELECT public.oms_cancel_unpaid_order($1,$2,'buyer cancelled')", [`cancel:${review.orderId}`, review.orderId]);
  const cancelled = await paymentObservation(source.runtime, review.attempt, "captured");
  expect((await paymentReceive(source.runtime, review.attempt, cancelled.id)).status).toBe(200);
  const reviewEvent = (await source.owner.query("SELECT id FROM public.payment_truth_events WHERE source_event_id=$1", [`sandbox:${cancelled.id}`])).rows[0].id as string;
  return { open, fenced, active, nextInput, refused, pending, captured, review, cancelled, reviewEvent };
}

async function identityFixture() {
  const issuer = "https://issuer.example.invalid/retained-store", audience = "customer-api";
  const key = await jose.generateKeyPair("ES256"), jwk = { ...await jose.exportJWK(key.publicKey), kid: "native-source", alg: "ES256", use: "sig" };
  const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: ["ES256"], maxTokenLifetimeSeconds: 3600 }, {
    loadJwt: async () => jose,
    fetch: async url => {
      if (String(url) === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, jwks_uri: `${issuer}/keys` });
      if (String(url) === `${issuer}/keys`) return Response.json({ keys: [jwk] });
      return new Response(null, { status: 404 });
    },
  });
  const token = (subject: string) => new jose.SignJWT({ email: "retained@example.invalid", email_verified: true })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m")
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid }).sign(key.privateKey);
  const accessToken = await token("original-native-subject"), verified = await verifier.verifyToken(accessToken);
  if (!verified.ok) throw new Error("Owned signed native fixture did not verify");
  return { verifier, token, accessToken, principal: verified.principal };
}

type AccountChoices = { marketingNewsletter: { state: string; granted: boolean }; marketingGiftsDiscounts: { state: string; granted: boolean } };
type AccountReceipt = { permissionEventId: string; workId: string | null; replayed: boolean; choices: AccountChoices };
async function consentActor<T>(db: Installation, principal: string, sql: string, values: unknown[]): Promise<T> {
  const client = await db.runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
    await client.query("SET LOCAL ROLE authenticated");
    expect((await client.query("SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows).toEqual([{ current_user: "authenticated", superuser: false }]);
    const result = (await client.query<{ result: T }>(sql, values)).rows[0]!.result;
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const consentRead = (db: Installation, principal: string, client: string) => consentActor<AccountChoices>(db, principal,
  "SELECT public.customer_account_communication_choices_as_actor($1) AS result", [client]);
const consentSet = (db: Installation, principal: string, client: string, purpose: string, value: boolean, key: string) => consentActor<AccountReceipt>(db, principal,
  "SELECT public.customer_account_communication_choice_set_as_actor($1,$2,$3,$4) AS result", [client, purpose, value, key]);
async function consentFixture() {
  // Only client ownership and trusted install-time configuration are fixture rows.
  // Every preference, evaluator choice, permission event and sync work is written by its actor routine.
  await source.owner.query("INSERT INTO public.customer_account_consent_sync_targets(binding,provider_kind,enabled) VALUES('retained-account','synthetic-provider',true)");
  const principal = identity.principal.principalId;
  const newsletter = await consentSet(source, principal, graph.client, "marketing_newsletter", true, "transfer-newsletter");
  const giftGrant = await consentSet(source, principal, graph.client, "marketing_gifts_discounts", true, "transfer-gift-grant");
  await source.owner.query("UPDATE public.customer_account_consent_sync_targets SET enabled=false");
  const giftWithdraw = await consentSet(source, principal, graph.client, "marketing_gifts_discounts", false, "transfer-gift-withdraw");
  expect(giftWithdraw.workId).toBeNull();
  await source.owner.query("UPDATE public.customer_account_consent_sync_targets SET enabled=true");
  const heldClient = randomUUID(), heldPrincipal = randomUUID(), email = "held-consent@example.invalid";
  await source.owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [heldClient, email, heldPrincipal]);
  await consentSet(source, heldPrincipal, heldClient, "marketing_gifts_discounts", true, "transfer-before-bounce");
  const delivery = createPostgresDeliveryReconciliationPort({ connectionString: source.runtimeUrl }, { binding: "retained-account" }); ports.push(delivery);
  const at = new Date().toISOString(), messageId = "synthetic:consent-transfer";
  const send = await delivery.registerNetworkTarget({ sourceKey: messageId, messageId, recipientEmail: email,
    templateReference: "synthetic", acceptedAt: at, evidence: "network_accepted" });
  await delivery.applyObservation({ sendId: send.id, messageId, observationKey: messageId, kind: "bounced", occurredAt: at, recipientEmail: email, source: "callback" });
  const heldGrant = await consentSet(source, heldPrincipal, heldClient, "marketing_gifts_discounts", true, "transfer-after-bounce");
  return { principal, heldClient, heldPrincipal, newsletter, giftGrant, giftWithdraw, heldGrant,
    choices: await consentRead(source, principal, graph.client), heldChoices: await consentRead(source, heldPrincipal, heldClient) };
}

async function mediaFixture() {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "m14-connected-media-"));
  const sourceRoot = join(parent, "source"), targetRoot = join(parent, "target");
  // Register even a partially prepared fixture for bounded teardown.
  media = { parent, sourceRoot, targetRoot, grant: "", confirmedRef: "", pendingRef: "", cleanupRef: "", partialTemp: "", census: { objects: [], temporary: [] } };
  const store = await OrderReviewMediaObjectStore.create(sourceRoot), grant = `review-grant:${randomUUID()}`;
  const subject = `client:${graph.client}`;
  await source.owner.query("INSERT INTO public.subscriber_profiles(subject_reference,revision,fingerprint) VALUES($1,1,$2)", [subject, "a".repeat(64)]);
  await source.owner.query("INSERT INTO public.subscriber_review_access_grants(order_id,kind,grant_reference,expires_at) VALUES($1,'review_request',$2,'2999-01-01')", [graph.order, grant]);
  await source.owner.query(`INSERT INTO public.subscriber_retention_intents(idempotency_key,subject_reference,subscription_id,source_reference,
    access_grant_reference,kind,template_reference,fingerprint,expected_revision,recipient_fingerprint,control_key,status,delivery_reference,attempt_count)
    VALUES($1,$2,$3,$4,$5,'review_request','retained.review','${"b".repeat(64)}',1,'${"c".repeat(64)}','retained.review','accepted','retained-delivery',1)`,
  [`retained-${graph.order}`, subject, graph.subscription, `order:${graph.order}`, grant]);
  const lifecycle = createPostgresOrderReviewLifecyclePort(source.runtime);
  const uploads = createPostgresOrderReviewMediaPort(source.runtime, { async run(work) {
    const client = await source.runtime.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } });
  const comment = "Retained synthetic review";
  await lifecycle.submit({ grant, rating: 5, comment, fingerprint: createHash("sha256").update(`5\n${comment}`).digest("hex") });
  const body = (value: Buffer) => (async function* () { yield value; })();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  let confirmedRef = "", pendingRef = "", cleanupRef = "", partialTemp = "";
  for (const kind of ["confirmed", "pending", "cleanup"] as const) {
    const capabilityDigest = createHash("sha256").update(`owned-${kind}`).digest("hex"), writerRef = `retained-writer:${kind}`;
    const intent = await lifecycle.createMediaIntent({ grant, contentType: "image/png", byteLength: png.length, capabilityDigest, commandKey: `retained-intent:${kind}` });
    const admission = await uploads.admitUpload({ capabilityDigest, declaredContentType: "image/png", declaredByteLength: png.length, writerRef });
    if (admission.kind !== "lease") throw new Error("Source media lease unavailable under actual runtime role");
    const { reservation } = admission;
    const partial = kind === "pending" ? png.subarray(0, 8) : png;
    const receipt = await store.writeTemp(writerRef, body(partial), png.length, reservation.leaseExpiresAt);
    if (kind === "pending") { pendingRef = intent.media.mediaRef; partialTemp = receipt.tempRef; continue; }
    expect(await uploads.finalizeUpload({ capabilityDigest, writerRef, leaseVersion: reservation.leaseVersion,
      digest: receipt.sha256, byteLength: receipt.bytes, promote: () => store.promote(receipt.tempRef, reservation.objectKey) })).toMatchObject({ state: "stored" });
    await lifecycle.confirmMedia({ grant, mediaRef: intent.media.mediaRef, digest: receipt.sha256, commandKey: `retained-confirm:${kind}` });
    if (kind === "confirmed") confirmedRef = intent.media.mediaRef;
    else {
      cleanupRef = intent.media.mediaRef;
      expect(await uploads.prepareAdminDelete({ actorRef: "synthetic-preparation", mediaRef: cleanupRef, idempotencyKey: "retained-cleanup" })).toMatchObject({ media: { state: "cleanup_pending" } });
    }
  }
  const census = await captureOrderReviewMediaFilesystem({ root: sourceRoot, ...mediaLimits });
  return { parent, sourceRoot, targetRoot, grant, confirmedRef, pendingRef, cleanupRef, partialTemp, census };
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Connected transfer proof requires owned disposable PostgreSQL");
  source = await installation("source");
  identity = await identityFixture();
  graph = await fixture(source.owner);
  const retainedGraph = await fixture(source.owner);
  const product = randomUUID(), sku = randomUUID(), priceList = randomUUID();
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'retained-product','Retained product')", [product]);
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,net_weight_g,sellable_in_subscription) VALUES($1,$2,'retained-sku','Retained SKU',100,true)", [sku, product]);
  await source.owner.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product, sku]);
  await source.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Retained list','ZZ','XXX')", [priceList]);
  await source.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,100)", [priceList, sku]);
  await source.owner.query("UPDATE public.subscriptions SET price_list_id=$2,currency_code='XXX' WHERE id=$1", [graph.subscription, priceList]);
  await source.owner.query(`INSERT INTO public.subscription_lines
    (subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
    VALUES($1,$2,1,0,100,'XXX')`, [graph.subscription, sku]);
  await source.owner.query("UPDATE public.clients SET principal_id=$2,email='retained@example.invalid',lifecycle_stage='customer' WHERE id=$1", [graph.client, identity.principal.principalId]);
  await source.owner.query("UPDATE public.subscriptions SET next_cycle_at='2027-01-01T12:00:00.123456Z' WHERE id=$1", [graph.subscription]);
  await openCase(source.owner, graph);
  prunedHold = (await source.owner.query("SELECT id FROM public.commerce_order_holds WHERE idempotency_key=$1", [`exception-${graph.order}`])).rows[0].id;
  await openCase(source.owner, retainedGraph);
  retainedHold = (await source.owner.query("SELECT id FROM public.commerce_order_holds WHERE idempotency_key=$1", [`exception-${retainedGraph.order}`])).rows[0].id;
  await source.owner.query("INSERT INTO public.commerce_order_operations(order_id,hold_id,operation_type,idempotency_key) VALUES($1,$2,'hold_created',$3)", [graph.order, prunedHold, `hold-history-${prunedHold}`]);
  await source.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.exception' AND idempotency_key=$1", [`shipment_exception:${prunedHold}`]);
  successor = await replacement(source.owner, graph);
  await source.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'tracking','retained-tracking','2026-08-02T03:04:05.123456Z')", [successor]);
  await source.owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','fixture-stock','fixture-settlement','2020-01-02T03:04:05.654321Z','retained-authorization')`, [graph.subscription]);
  await source.owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'retained-sku',1,9007199254740993)", [graph.subscription]);
  const openOrder = randomUUID();
  const orderWriter = await source.owner.connect();
  await orderWriter.query("BEGIN");
  try {
    await orderWriter.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',9007199254740993)", [openOrder, graph.client]);
    await orderWriter.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,9007199254740993,9007199254740993)", [openOrder]);
    await orderWriter.query("COMMIT");
  } catch (error) { await orderWriter.query("ROLLBACK"); throw error; }
  finally { orderWriter.release(); }
  await source.owner.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
    VALUES($1,'fixture-settlement',9007199254740993,'XXX',$2)`, [openOrder, `owed-${openOrder}`]);
  const parent = "f1000000-0000-4000-8000-000000000001", child = "11000000-0000-4000-8000-000000000002";
  await source.owner.query("INSERT INTO public.invoicing_duties(id,order_id,original_key) VALUES($1,$2,'original-invoice-duty')", [parent, graph.order]);
  await source.owner.query("INSERT INTO public.invoicing_duties(id,order_id,parent_duty_id,original_key) VALUES($1,$2,$3,'retained-child-duty')", [child, graph.order, parent]);
  await source.owner.query("INSERT INTO public.invoicing_seller_revisions(duty_id,eligibility_version) VALUES($1,'invoicing.seller.v1')", [parent]);
  await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts)
    VALUES('subscription',$1,'retained.owed','original-effect-key','{"frozen":9007199254740993}','processing',3)`, [graph.subscription]);
  const fingerprint = createHash("sha256").update("retained-recipient@example.invalid").digest("hex");
  await source.owner.query(`INSERT INTO public.communication_recipient_consents
    (recipient_fingerprint,purpose,state,captured_at,updated_at)
    VALUES($1,'marketing_newsletter','suppressed','2026-01-01','2026-01-02')`, [fingerprint]);
  const syncId = (await source.owner.query<{ id: string }>(`INSERT INTO public.outbox_events
    (aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts)
    VALUES('communication_native_sync',$1,$2,'retained-sync:1','{}','pending',2) RETURNING id`,
  [randomUUID(), `communication.native.sync.${fingerprint}`])).rows[0]!.id;
  await source.owner.query(`INSERT INTO public.communication_native_sync_state
    (work_id,binding,provider_kind,contact_id,normalized_email,purpose,event_kind,command_fingerprint)
    VALUES($1,'retained-binding','synthetic-provider','retained-contact','retained-recipient@example.invalid',
      'marketing_newsletter','suppress',$2)`, [syncId, fingerprint]);
  const sendId = (await source.owner.query<{ id: string }>(`INSERT INTO public.communication_native_sends
    (binding,source_key,message_id,recipient_fingerprint,template_reference,accepted_at)
    VALUES('retained-binding','retained-send:1','provider-message:1',$1,'retained-template','2026-01-01') RETURNING id`,
  [fingerprint])).rows[0]!.id;
  await source.owner.query(`INSERT INTO public.communication_native_observations
    (binding,observation_key,send_id,kind,occurred_at,source,fact_fingerprint)
    VALUES('retained-binding','retained-observation:1',$1,'delayed','2026-01-02','callback',$2)`,
  [sendId, fingerprint]);
  const admin = randomUUID(), revoked = randomUUID(); erased = randomUUID();
  await source.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'admin@example.invalid'),($2,'revoked@example.invalid')", [admin, revoked]);
  await source.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy','2020-01-01')`, [admin]);
  await source.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at,membership_revoked_at,membership_revoked_by)
    VALUES($1,'distributor','revoked','legacy','2020-01-01','2021-01-01',$2)`, [revoked, admin]);
  await source.owner.query(`INSERT INTO public.identity_privacy_erasures(erasure_id,idempotency_key,principal_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
    VALUES($1,$2,$3,$4,'identity.erasure.v1','{}','[]','[]','2022-01-01T03:04:05.123456Z')`, [randomUUID(), randomUUID(), erased, admin]);
  media = await mediaFixture();
  consent = await consentFixture();

  retainedRenewal = await renewalPurchase(true);
  pendingRenewal = await renewalPurchase(false);

  payments = await paymentTransferFixture();
  const purchaseOrder = randomUUID(), purchaseItem = randomUUID();
  await source.owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
    inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES('retained-stock','retained-sku',10,10,0,'sellable','2026-09-01','2027-12-01','retained','retained',$1)`, ["a".repeat(64)]);
  const purchaseWriter = await source.owner.connect();
  try {
    await purchaseWriter.query("BEGIN");
    await purchaseWriter.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',0)", [purchaseOrder, graph.client]);
    await purchaseWriter.query("INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,$3,1,2,0,0)", [purchaseItem, purchaseOrder, sku]);
    await purchaseWriter.query("COMMIT");
  } catch (error) { await purchaseWriter.query("ROLLBACK"); throw error; } finally { purchaseWriter.release(); }
  purchaseHold = { idempotencyKey: "retained-purchase-hold", orderId: purchaseOrder, stockSourceKey: "retained-stock",
    items: [{ orderItemId: purchaseItem, skuId: sku, quantity: 2 }], paymentStatus: "created",
    expiresAt: "2026-09-02T12:00:00.000Z", now: "2026-09-01T12:00:00.000Z", metadata: { note: "retained@example.invalid", padding: "x".repeat(32768) } };
  purchaseHoldId = (await createPostgresPurchaseReservationPort(source.runtime).reserveOrderItems(purchaseHold)).reservations[0]!.reservationId;
  const cancelledOrder = randomUUID(), cancelledItem = randomUUID();
  const cancelledWriter = await source.owner.connect();
  try {
    await cancelledWriter.query("BEGIN");
    await cancelledWriter.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',0)", [cancelledOrder, graph.client]);
    await cancelledWriter.query("INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,$3,1,2,0,0)", [cancelledItem, cancelledOrder, sku]);
    await cancelledWriter.query("COMMIT");
  } catch (error) { await cancelledWriter.query("ROLLBACK"); throw error; } finally { cancelledWriter.release(); }
  await source.owner.query("SELECT public.subscription_declare_provisional_activation($1,$2,28,'2026-09-01')", [randomUUID(), cancelledOrder]);
  await createPostgresPurchaseReservationPort(source.runtime).reserveOrderItems({ ...purchaseHold, idempotencyKey: "retained-cancelled-hold", orderId: cancelledOrder,
    items: [{ orderItemId: cancelledItem, skuId: sku, quantity: 2 }] });
  retainedCancellation = { idempotencyKey: "retained-cancellation", orderId: cancelledOrder, reason: "retained@example.invalid" };
  expect(await createPostgresAbandonedCheckoutCompensationPort(source.runtime, () => "2026-09-01T12:00:00Z").cancelAbandonedOrder(retainedCancellation)).toEqual({ cancelled: true });
  const destinations = createPostgresDestinationPort(source.runtime);
  retainedDestination = await destinations.registerOrder({ idempotencyKey: `destination-${graph.order}`, orderId: graph.order,
    address: { recipientName: "Synthetic personal recipient", line1: "Synthetic personal street", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: "2026-09-01T12:00:00Z" });
  await source.owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [admin]);
  destinationCommand = { operator: admin, subscription: graph.subscription, key: `address-${graph.order}`,
    version: Number((await source.runtime.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows[0].template_version),
    payload: { newAddress: { recipientName: "Synthetic future recipient", line1: "Synthetic future street", city: "Fixture", postalCode: "00000", country: "ZZ" } } };
  await source.runtime.query("SELECT public.customer_support_change_shipping_destination($1,$2,$3,$4,$5,'2026-09-01T12:00:00Z')", [admin, graph.subscription, destinationCommand.payload, destinationCommand.version, destinationCommand.key]);
  for (const sourceKind of ["event", "reminder"] as const) {
    for (const reason of ["missing_recipient", "disabled_control", "consent_refused"] as const) {
      const seeded = await refusedNoticeSources(source.owner, sourceKind, reason, 1);
      try {
        expect(await dispatchNotices(source, seeded.unresolvedClients)).not.toContain(`subscription-notice:${sourceKind}:${seeded.refused[0]}`);
        expect((await source.runtime.query("SELECT reason FROM public.subscription_notice_refusals WHERE source=$1 AND source_id=$2", [sourceKind, seeded.refused[0]])).rows)
          .toEqual([{ reason: "notice_policy_refused" }]);
        terminalNotices.push({ source: sourceKind, id: seeded.refused[0]! });
      } finally { await seeded.changeCondition(); }
    }
  }
  packet = await capture(source.owner, "owned-existing-source");
}, postgresSetupTimeoutMs);
// Each case owns a fresh qualified target and can run without another case.
beforeEach(async () => {
  target = await installation(`target-${++targetNumber}`);
  pristine = await capture(target.owner, "owned-pristine-target");
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await closePostgres(containers, pools, ports.map(port => () => port.close())); }
  finally { if (media) await rm(media.parent, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

// Independent whole-row readback; no importer/capture comparison helper is used.
async function census(db: Pool): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const client = await db.connect();
  try {
    await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL TimeZone='UTC'");
    for (const table of connectedNativeStoreTables) result[table] = (await client.query(`SELECT to_jsonb(t)::text AS value FROM public."${table}" t`)).rows.map(row => String(row.value)).sort();
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const restore = (capturePacket = packet) => restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: capturePacket, freshTarget: pristine });
function corruptDeclaredTotal(): ConnectedNativeStoreCapture {
  const copy = JSON.parse(JSON.stringify(packet)) as ConnectedNativeStoreCapture;
  const orders = copy.compatible.tables.find(table => table.table === "commerce_orders")!;
  let changed = false;
  orders.rows = orders.rows.map(row => {
    if ((JSON.parse(row) as { id: string }).id !== graph.order) return row;
    const corrupted = row.replace(/"total_amount_minor": 900(?=[,}])/, '"total_amount_minor": 901');
    if (corrupted === row) throw new Error("Deferred-total counterexample did not change the source row");
    changed = true; return corrupted;
  });
  if (!changed) throw new Error("Deferred-total counterexample source order missing");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const { sha256: _inner, ...inner } = copy.compatible; copy.compatible.sha256 = hash(inner);
  const { sha256: _outer, ...outer } = copy; copy.sha256 = hash(outer);
  return copy;
}

// Solo median 6.32 s, max 6.44 s; source CI 14.9 s and merge group 21.3 s both ran without coverage (10 s flat limit).
it("restores writer-created sandbox attempts, cyclic observations and terminal review truth, then continues once", async () => {
  const before = await census(source.owner);
  expect(JSON.stringify(packet)).not.toContain("dispatch-only@example.invalid");
  expect((await restore()).replayed).toBe(false);
  expect(await census(target.owner)).toEqual(before);
  expect((await restore()).replayed).toBe(true);
  const restarted = pool(target.runtimeUrl), port = paymentPort(restarted), truth = createPostgresPaymentTruthPort(restarted, paymentOptions);
  const p = payments;
  expect(await port.readAttempt({ settlementIntentId: p.open.intentId })).toMatchObject({ id: p.open.attempt.id, state: "dispatched", latestObservation: null });
  expect((await port.beginAttempt(p.open.input)).replayed).toBe(true);
  await expect(port.beginAttempt({ ...p.open.input, idempotencyKey: `attempt:${randomUUID()}` })).rejects.toThrow("payment_simulator_attempt_unresolved");
  expect(await port.readAttempt({ settlementIntentId: p.fenced.intentId })).toMatchObject({ id: p.active.id, state: "indeterminate" });
  expect((await port.beginAttempt(p.nextInput)).replayed).toBe(true);
  await expect(port.beginAttempt({ ...p.nextInput, idempotencyKey: `attempt:${randomUUID()}` })).rejects.toThrow("payment_simulator_attempt_unresolved");
  await expect(port.recordObservation({ ...p.refused.input, idempotencyKey: `observation:${randomUUID()}`, outcome: "captured" })).rejects.toThrow("wrong_attempt");
  expect(await paymentReceive(restarted, p.fenced.attempt, p.refused.id)).toMatchObject({ status: 200, data: { replayed: true } });
  expect(await port.recordObservation(p.captured.input)).toEqual({ id: p.captured.id, replayed: true });
  expect((await paymentReceive(restarted, p.pending.attempt, p.captured.id)).status).toBe(200);
  expect(await paymentReceive(restarted, p.pending.attempt, p.captured.id)).toMatchObject({ status: 200, data: { replayed: true } });
  for (const current of [{ ...p.open, active: p.open.attempt }, { ...p.fenced, active: p.active }]) {
    const late = await paymentObservation(restarted, current.active, "captured");
    expect((await paymentReceive(restarted, current.active, late.id)).status).toBe(200);
    expect(await paymentReceive(restarted, current.active, late.id)).toMatchObject({ status: 200, data: { replayed: true } });
  }
  for (const current of [p.open, p.fenced, p.pending]) {
    expect((await target.owner.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [current.intentId])).rows).toHaveLength(1);
    expect((await target.owner.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid'", [current.orderId])).rows).toHaveLength(1);
  }
  const original = await createPostgresPaymentTruthPort(source.runtime, paymentOptions).readEvent(p.reviewEvent);
  expect(await truth.readEvent(p.reviewEvent)).toEqual(original);
  expect(original).toMatchObject({ event: { applicationStatus: "review_required", state: "open", outcome: "captured" }, financial: { orderStatus: "cancelled" } });
  expect(original!.event.reviewRequiredAt).toBeTruthy();
  const observation = (await port.readAttempt({ settlementIntentId: p.review.intentId }))!.latestObservation!;
  const reconciliation = { eventId: p.reviewEvent, idempotencyKey: randomUUID(), evidenceStatus: "observed" as const, outcome: "captured" as const,
    occurredAt: paymentAt, failure: null, evidence: { sourceKind: "reconciliation_read" as const, sourceReference: observation.id,
      observedStatus: observation.outcome, observedAt: observation.occurredAt, payloadFingerprint: observation.fingerprint, attemptRef: p.review.attempt.id } };
  expect((await truth.recordReconciliation(reconciliation)).event.applicationStatus).toBe("review_required");
  expect((await truth.recordReconciliation(reconciliation)).event.replayed).toBe(true);
  for (let n = 0; n < 2; n++) expect((await truth.sweepOpenEvents({ now: "2030-01-01T00:00:00Z", limit: 1000 })).eventIds).not.toContain(p.reviewEvent);
  expect(await paymentReceive(restarted, p.review.attempt, p.cancelled.id)).toMatchObject({ status: 200, data: { replayed: true } });
  expect((await target.owner.query("SELECT e.review_required_at IS NOT NULL AS review,e.outcome,o.status FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id JOIN public.commerce_orders o ON o.id=i.order_id WHERE e.id=$1", [p.reviewEvent])).rows)
    .toEqual([{ review: true, outcome: "captured", status: "cancelled" }]);
  const reviewTransitions = "SELECT id,outcome FROM public.commerce_settlement_transitions WHERE intent_id=$1 ORDER BY id";
  expect((await target.owner.query(reviewTransitions, [p.review.intentId])).rows).toEqual((await source.owner.query(reviewTransitions, [p.review.intentId])).rows);
  expect((await target.owner.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [p.review.intentId])).rows).toEqual([]);
  for (const table of ["payment_simulator_attempts", "payment_simulator_observations"] as const) {
    const rows = packet.owned.find(data => data.table === table)!.rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.join()).not.toContain("dispatch-only@example.invalid");
    expect(rows.join()).not.toContain("rawPayload"); expect(rows.join()).not.toContain("payerEmail");
  }
}, 65_000);

// Solo median 4.31 s, max 4.34 s; allow headroom for hosted database contention.
it("rolls back the whole restore when a captured simulator observation is missing", async () => {
  const corrupted = structuredClone(packet), observations = corrupted.owned.find(data => data.table === "payment_simulator_observations")!;
  observations.rows = observations.rows.filter(row => (JSON.parse(row) as { id: string }).id !== payments.captured.id);
  const { sha256: _hash, ...body } = corrupted; corrupted.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const before = await census(target.owner);
  await expect(restore(corrupted)).rejects.toMatchObject({ code: "target_conflict" });
  expect(await census(target.owner)).toEqual(before);
}, 30_000);

// Solo medians 3.70/3.64 s, maxima 3.78/3.69 s for the two table-limit cases.
for (const table of ["payment_simulator_attempts", "payment_simulator_observations"] as const) it(`counts linkable ${table} rows and bytes toward the transfer limits`, async () => {
  const all = [...packet.compatible.tables, ...packet.owned], index = all.findIndex(data => data.table === table);
  const through = all.slice(0, index + 1), rows = through.reduce((sum, data) => sum + data.rows.length, 0);
  const bytes = through.reduce((sum, data) => sum + data.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
  await expect(capture(source.owner, "sandbox-row-limit", { maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: "limit_exceeded", table });
  await expect(capture(source.owner, "sandbox-byte-limit", { maximumRows: 10000, maximumBytes: bytes - 1 })).rejects.toMatchObject({ code: "limit_exceeded", table });
  const oversized = structuredClone(packet), targetRows = oversized.owned.find(data => data.table === table)!;
  targetRows.rows = Array.from({ length: 10001 }, () => targetRows.rows[0]!);
  const { sha256: _hash, ...body } = oversized; oversized.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const before = await census(target.owner);
  await expect(restore(oversized)).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(await census(target.owner)).toEqual(before);
}, 30_000);

// Solo without coverage: 6.30 s including restore; retain 30 s headroom.
it("transfers purchase owners, lines and receipts losslessly and preserves replay and bounded capture", async () => {
  for (const table of ["subscription_activations", "commerce_checkout_compensations", "fulfillment_stock_current", "fulfillment_inventory_reservations", "fulfillment_inventory_reservation_lines", "fulfillment_purchase_reservation_receipts"]) {
    expect(packet.owned.find(value => value.table === table)?.rows.length).toBeGreaterThan(0);
  }
  const heldClient = await source.owner.connect();
  try {
    await heldClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const table of ["subscription_activations", "commerce_checkout_compensations", "fulfillment_purchase_reservation_receipts"]) {
      const index = packet.owned.findIndex(value => value.table === table);
      const priorBytes = [...packet.compatible.tables, ...packet.owned.slice(0, index)]
        .reduce((sum, rowset) => sum + rowset.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
      const bytes = packet.owned[index]!.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
      await expect(captureConnectedNativeStore({ sourceId: "bounded-purchase-metadata", catalogueId: selected.objectInventorySha256,
        maximumRows: 10000, maximumBytes: priorBytes + bytes - 1, source: { withSnapshot: work => work({ query: (sql, values) => heldClient.query(sql, values ? [...values] : undefined) }) } }))
        .rejects.toMatchObject({ code: "limit_exceeded", table });
    }
  } finally { await heldClient.query("ROLLBACK"); heldClient.release(); }
  expect((await restore()).replayed).toBe(false);
  const sourceRows = await census(source.owner), targetRows = await census(target.owner);
  for (const table of ["subscription_activations", "commerce_checkout_compensations", "fulfillment_stock_current", "fulfillment_inventory_reservations", "fulfillment_inventory_reservation_lines", "fulfillment_purchase_reservation_receipts"]) {
    expect(targetRows[table]).toEqual(sourceRows[table]);
  }
  expect((await restore()).replayed).toBe(true);
  const cancellation = createPostgresAbandonedCheckoutCompensationPort(target.runtime, () => "2026-09-03T12:00:00Z");
  expect(await cancellation.cancelAbandonedOrder(retainedCancellation)).toEqual({ cancelled: true });
  await expect(cancellation.cancelAbandonedOrder({ ...retainedCancellation, reason: "changed" })).rejects.toMatchObject({ code: "23505" });
  const port = createPostgresPurchaseReservationPort(target.runtime);
  expect(await port.reserveOrderItems(purchaseHold)).toMatchObject({ replayed: true, reservations: [{ reservationId: purchaseHoldId }] });
  await expect(port.reserveOrderItems({ ...purchaseHold, metadata: { note: "changed" } })).rejects.toMatchObject({ code: "23505" });
  expect((await target.owner.query("SELECT count(*)::int n FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1", [purchaseHold.orderId])).rows).toEqual([{ n: 1 }]);
}, 30_000);

// Solo median 3.55 s, max 3.61 s; allow headroom for hosted database contention.
it("refuses a native capture login that row security would silently filter", async () => {
  const login = "transfer_filtered_reader";
  await source.owner.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-transfer';
    GRANT pg_read_all_data TO ${login}`);
  const url = new URL(source.ownerUrl); url.username = login; url.search = "";
  const reader = new Pool({ connectionString: url.toString(), max: 1 });
  const errors: unknown[] = [];
  try {
    expect(Number((await source.owner.query("SELECT count(*) FROM public.clients")).rows[0].count)).toBeGreaterThan(0);
    const client = await reader.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // The baseline dump can leave a pooled session with this setting off.
      await client.query("SET LOCAL row_security = on");
      expect((await client.query("SELECT count(*)::int AS rows FROM public.clients")).rows).toEqual([{ rows: 0 }]);
      for (const table of ["commerce_destinations", "commerce_destination_bindings"]) {
        expect(Number((await source.owner.query(`SELECT count(*) n FROM public.${table}`)).rows[0].n)).toBeGreaterThan(0);
        expect((await client.query(`SELECT count(*)::int AS rows FROM public.${table}`)).rows).toEqual([{ rows: 0 }]);
        await client.query("SAVEPOINT address_filter; SET LOCAL row_security=off");
        await expect(client.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT address_filter");
      }
      await expect(captureConnectedNativeStore({ sourceId: "native-filtered-login", catalogueId: selected.objectInventorySha256,
        maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
        source: { withSnapshot: work => work({ query: async (sql, values) => {
          try { return await client.query(sql, values ? [...values] : undefined); }
          catch (error) { errors.push((error as { code?: unknown }).code); throw error; }
        } }) } })).rejects.toMatchObject({ code: "database_unavailable" });
      expect(errors).toEqual(["42501"]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  } finally {
    await reader.end();
    await source.owner.query(`DROP ROLE ${login}`);
  }
}, 30_000);

// Solo median 5.03 s, max 5.21 s; allow headroom for hosted database contention.
it("preserves native JSON digits above the JavaScript exact integer range", async () => {
  const carried = await capture(source.owner, "native-json-number-source");
  await restore(carried);
  expect((await target.owner.query("SELECT payload->>'frozen' AS value FROM public.outbox_events WHERE idempotency_key='original-effect-key'"))
    .rows).toEqual([{ value: "9007199254740993" }]);
}, 30_000);

// Solo median 5.17 s, max 5.18 s; allow headroom for hosted database contention.
it("refuses a changed known trigger body and an unknown INSERT trigger before importing rows", async () => {
  const before = await census(target.owner);
  const original = (await target.owner.query<{ definition: string }>(
    "SELECT pg_catalog.pg_get_functiondef('public.fulfillment_emit_shipment_exception_notification()'::regprocedure) AS definition")).rows[0]!.definition;
  try {
    // Keeping the admitted trigger name must not admit another function body.
    await target.owner.query(`CREATE OR REPLACE FUNCTION public.fulfillment_emit_shipment_exception_notification()
      RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
      BEGIN RAISE EXCEPTION 'unreviewed_trigger_executed' USING ERRCODE='P0001'; END; $$`);
    await expect(restore()).rejects.toMatchObject({ code: "schema_conflict" });
    expect(await census(target.owner)).toEqual(before);
  } finally { await target.owner.query(original); }
  try {
    await target.owner.query(`CREATE TRIGGER retained_transfer_unapproved AFTER INSERT ON public.commerce_order_holds
      FOR EACH ROW EXECUTE FUNCTION public.fulfillment_emit_shipment_exception_notification()`);
    await expect(restore()).rejects.toMatchObject({ code: "schema_conflict" });
    expect(await census(target.owner)).toEqual(before);
  } finally { await target.owner.query("DROP TRIGGER IF EXISTS retained_transfer_unapproved ON public.commerce_order_holds"); }
  expect(await census(target.owner)).toEqual(before);
}, 30_000);

// Uses the existing 30-second connected-transfer integration deadline.
it("captures only the address-reference registry census and preserves the target installation registry", async () => {
  const references = [randomUUID(), randomUUID()];
  const localReference = randomUUID();
  const insertReference = (db: Pool, reference: string) => db.query(`INSERT INTO acquisition_private.address_references
    (source,reference,revision,provenance,created_at,updated_at)
    VALUES('census_fixture',$1,'v1','synthetic_fixture','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z') RETURNING id`, [reference]);
  try {
    const ids: string[] = [];
    for (const reference of references) ids.push((await insertReference(source.owner, reference)).rows[0].id);
    await insertReference(target.owner, localReference);
    const sourcePacket = await capture(source.owner, "source-with-address-reference-registry");
    const freshTarget = await capture(target.owner, "target-with-own-address-reference-registry");
    expect(sourcePacket.outsideProfileCensus.filter(entry => entry.disposition !== "unsupported-empty").map(entry => entry.relation).sort())
      .toEqual(["acquisition_private.address_references", "acquisition_private.installation_key", "public.platform_schema_migrations"]);
    expect(sourcePacket.outsideProfileCensus.find(entry => entry.relation === "acquisition_private.address_references"))
      .toEqual({ relation: "acquisition_private.address_references", owner: "platform_acquisition_owner", rows: "2", disposition: "target-address-references" });
    expect(freshTarget.outsideProfileCensus.find(entry => entry.relation === "acquisition_private.address_references")).toMatchObject({ rows: "1" });
    expect(sourcePacket.emptyOutsideProfile).not.toContain("acquisition_private.address_references");
    expect([...sourcePacket.compatible.tables, ...sourcePacket.owned].some(entry => String(entry.table) === "address_references")).toBe(false);
    for (const value of [...references, ...ids, "synthetic_fixture"]) expect(JSON.stringify(sourcePacket)).not.toContain(value);
    expect(JSON.stringify(freshTarget)).not.toContain(localReference);
    const before = (await target.owner.query("SELECT to_jsonb(t)::text AS value,ctid::text,xmin::text FROM acquisition_private.address_references t")).rows;
    const invalid = structuredClone(sourcePacket);
    invalid.owned.push({ table: "address_references", columns: [{ name: "reference", type: "text" }], rows: ['{"reference":"synthetic-private-row"}'] } as unknown as ConnectedNativeStoreCapture["owned"][number]);
    const { sha256: _old, ...body } = invalid;
    invalid.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await expect(restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: invalid, freshTarget }))
      .rejects.toMatchObject({ code: "invalid_input", message: "postgres_transfer_invalid_input" });
    expect((await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: sourcePacket, freshTarget })).replayed).toBe(false);
    expect((await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: sourcePacket, freshTarget })).replayed).toBe(true);
    expect((await target.owner.query("SELECT to_jsonb(t)::text AS value,ctid::text,xmin::text FROM acquisition_private.address_references t")).rows).toEqual(before);
    expect(await census(target.owner)).toEqual(await census(source.owner));
  } finally {
    await source.owner.query("DELETE FROM acquisition_private.address_references WHERE source='census_fixture'");
    await target.owner.query("DELETE FROM acquisition_private.address_references WHERE source='census_fixture'");
  }
}, 30_000);

// Uses the existing 30-second connected-transfer integration deadline.
it("refuses nonempty acquisition cases despite the address-reference census exception", async () => {
  const id = randomUUID();
  const insertCase = (db: Pool) => db.query(`INSERT INTO acquisition_private.cases
    (id,case_reference,source_kind,lifecycle,dedupe_fingerprint,consent_version,policy_version,consent_accepted_at,locale,source_path,created_at,updated_at)
    VALUES($1,$2,'partner_inquiry','new',decode(repeat('cd',32),'hex'),'not-applicable','fixture-v1',
      '2026-09-01T12:00:00Z','und','/partners/b2b-inquiries','2026-09-01T12:00:00Z','2026-09-01T12:00:00Z')`, [id, `acquisition-case:${id}`]);
  await insertCase(source.owner);
  await insertCase(target.owner);
  const before = await census(target.owner);
  try {
    await expect(capture(source.owner, "source-with-acquisition-case"))
      .rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.cases", message: "postgres_transfer_unsupported_table:acquisition_private.cases" });
    await expect(restore()).rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.cases", message: "postgres_transfer_unsupported_table:acquisition_private.cases" });
    expect(await census(target.owner)).toEqual(before);
    expect((await target.owner.query("SELECT id FROM acquisition_private.cases")).rows).toEqual([{ id }]);
  } finally {
    await source.owner.query("DELETE FROM acquisition_private.cases WHERE id=$1", [id]);
    await target.owner.query("DELETE FROM acquisition_private.cases WHERE id=$1", [id]);
  }
}, 30_000);

// Uses the existing 30-second connected-transfer integration deadline.
it.each(["acquisition_private.address_references_extra", "other_private.address_references"])("refuses other private relation %s", async relation => {
  if (relation.startsWith("other_private.")) await source.owner.query("CREATE SCHEMA other_private");
  await source.owner.query(`CREATE TABLE ${relation}(value text); INSERT INTO ${relation} VALUES('synthetic-private-row')`);
  try {
    await expect(capture(source.owner, "source-with-other-private-relation"))
      .rejects.toMatchObject({ code: "unsupported_table", table: relation, message: `postgres_transfer_unsupported_table:${relation}` });
  } finally {
    await source.owner.query(`DROP TABLE ${relation}`);
    if (relation.startsWith("other_private.")) await source.owner.query("DROP SCHEMA other_private");
  }
}, 30_000);

// Solo median 5.18 s, max 5.29 s; allow headroom for hosted database contention.
it("refuses private business omission and nonpristine targets without deleting existing obligations", async () => {
  const targetBefore = await census(target.owner);
  // An actual canonical private BUSINESS row must not disappear as if private
  // meant credentials. Its key fingerprint is synthetic; no key payload is read.
  await source.owner.query(`INSERT INTO acquisition_private.rate_limit_windows VALUES('requester',decode(repeat('ab',32),'hex'),now(),1,now())`);
  try { await expect(capture(source.owner, "source-with-private-business")).rejects.toMatchObject({ code: "unsupported_table", table: "acquisition_private.rate_limit_windows" }); }
  finally { await source.owner.query("DELETE FROM acquisition_private.rate_limit_windows WHERE key_kind='requester' AND key_fingerprint=decode(repeat('ab',32),'hex')"); }
  const setting = pristine.owned.find(table => table.table === "commerce_settings")!.rows
    .find(row => (JSON.parse(row) as { key: string }).key === "shipping_flat_minor")!;
  await target.owner.query("UPDATE public.commerce_settings SET value_minor=41 WHERE key='shipping_flat_minor'");
  try {
    await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
    expect((await target.owner.query("SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor'")).rows[0].value_minor).toBe(41);
  } finally {
    await target.owner.query(`UPDATE public.commerce_settings t SET value_minor=p.value_minor,value_text=p.value_text,updated_at=p.updated_at
      FROM jsonb_populate_record(NULL::public.commerce_settings,$1::jsonb) p WHERE t.key=p.key`, [setting]);
  }
  const retainedNotification = packet.compatible.tables.find(table => table.table === "outbox_events")!.rows.find(row => {
    const value = JSON.parse(row) as { event_type: string; idempotency_key: string };
    return value.event_type === "commerce.shipment.exception" && value.idempotency_key === `shipment_exception:${retainedHold}`;
  });
  if (!retainedNotification) throw new Error("Retained source obligation fixture missing");
  await target.owner.query("INSERT INTO public.outbox_events SELECT (pg_catalog.jsonb_populate_record(NULL::public.outbox_events,$1::jsonb)).*", [retainedNotification]);
  try {
    await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
    expect((await target.owner.query("SELECT pg_catalog.to_jsonb(o)::text AS value FROM public.outbox_events o")).rows)
      .toEqual([{ value: retainedNotification }]);
  } finally {
    await target.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.exception' AND idempotency_key=$1", [`shipment_exception:${retainedHold}`]);
  }
  expect(await census(target.owner)).toEqual(targetBefore);
}, 30_000);

// Solo median 3.86 s, max 4.07 s; allow headroom for hosted database contention.
it("bounds customer-linked purchase facts, method events and method state in transfer", async () => {
  const compatibleRows = packet.compatible.tables.reduce((sum, table) => sum + table.rows.length, 0);
  const compatibleBytes = packet.compatible.tables.reduce((sum, table) => sum + table.rows.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0), 0);
  let rows = compatibleRows, bytes = compatibleBytes;
  for (const name of ["subscription_renewal_attachments", "subscription_method_state_events", "subscription_method_states", "subscription_activations"]) {
    const held = packet.owned.find(table => table.table === name)!;
    expect(held.rows.length).toBeGreaterThan(0);
    rows += held.rows.length; bytes += held.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
    for (const limits of [{ maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 }, { maximumRows: 10000, maximumBytes: bytes - 1 }]) {
      await expect(captureConnectedNativeStore({ sourceId: "bounded-renewal-source", catalogueId: selected.objectInventorySha256, ...limits,
        source: { async withSnapshot(work) {
          const client = await source.owner.connect();
          try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            return await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          } finally { await client.query("ROLLBACK"); client.release(); }
        } },
      })).rejects.toMatchObject({ code: "limit_exceeded", table: name });
    }
  }
  const oversized = structuredClone(packet), held = oversized.owned.find(table => table.table === "subscription_method_states")!;
  held.rows = Array.from({ length: 10001 }, () => held.rows[0]);
  const { sha256: _old, ...body } = oversized;
  oversized.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await expect(restore(oversized)).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(await census(target.owner)).toEqual(Object.fromEntries([...pristine.compatible.tables, ...pristine.owned].map(table => [table.table, [...table.rows].sort()])));
}, 30_000);

it("restores writer-produced renewal data and pending duties, then renews through the restricted runtime", async () => {
  await restore();
  expect((await restore()).replayed).toBe(true);
  for (const table of ["subscription_renewal_attachments", "subscription_method_state_events", "subscription_method_states",
    "subscription_renewal_terms", "subscription_renewal_term_lines", "subscription_activations"] as const) {
    const read = async (pool: Pool) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL TimeZone='UTC'");
        return (await client.query(`SELECT to_jsonb(t)::text AS value FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
      } finally { await client.query("ROLLBACK"); client.release(); }
    };
    expect(await read(target.owner)).toEqual(await read(source.owner));
  }
  for (const table of ["subscription_renewal_attachments", "subscription_method_state_events"]) {
    await expect(target.runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
  }
  const writer = renewal.createPostgresPurchaseRenewalWriter(target.runtime);
  expect(await writer.pending()).toContainEqual({ ...pendingRenewal, hasPurchaseFacts: true });
  expect(await writer.complete(pendingRenewal.orderId)).toMatchObject({ subscriptionId: pendingRenewal.subscriptionId, replayed: false });
  expect(await writer.complete(pendingRenewal.orderId)).toMatchObject({ replayed: true });
  await expect(writer.register(pendingRenewal.orderId, { ...renewalFacts, payerAccountRef: "different@example.invalid" })).rejects.toThrow("purchase_conflict");
  expect(await writer.readMethod(retainedRenewal.subscriptionId)).toMatchObject({ healthState: "healthy",
    methodRef: renewalFacts.methodRef, evidenceRef: "sandbox-repaired:customer@example.invalid" });
  // The row proof supplies current stock after restore through its production
  // writer; inventory-history transfer belongs to the final joined witness.
  await createPostgresFulfillmentStockSyncPort(target.runtime, { sourceKey: renewalFacts.stockSourceKey, readLocalInventoryStock: async () => [] })
    .recordProviderStockCurrent({ requestKey: "fixture-stock", snapshot: { providerRef: "sandbox-stock", collectedAt: renewalAt,
      sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef: "retained-sku", totalQuantity: 100,
      forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: "transfer-stock" }, inventoryClass: "sellable",
      lastSyncedAt: renewalAt, staleAfter: "2027-01-01T00:00:00.000Z" });
  const codec = renewal.createNativeRenewalCodec(), store = renewal.createPostgresRenewalStore(target.runtime, codec);
  const call = async <T = Record<string, unknown>>(name: string, values: unknown[]): Promise<T> =>
    (await target.runtime.query(`SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) AS value`, values)).rows[0].value as T;
  const settlement: RenewalSettlementPort = {
    prepareRenewal: i => call<RenewalPreparedSettlement>("commerce_prepare_subscription_renewal", [i.operationId, i.claimToken, i.now]),
    acknowledgeExternalAttempt: async i => codec.readback(await call("commerce_acknowledge_subscription_renewal_attempt", [i.operationId, i.operationFingerprint, i.externalAttemptRef, i.acknowledgedAt])),
    recordTerminalOutcome: async i => codec.readback(await call("commerce_record_subscription_renewal_outcome", [i.operationId, i.eventKey, i.operationFingerprint, i.outcome, i.externalRef ?? null, i.reason ?? null, i.occurredAt])),
  };
  const due = (await store.listDue(100, renewalDue)).find(row => row.subscriptionId === retainedRenewal.subscriptionId)!;
  const snapshot = await store.buildCycleSnapshots(due);
  expect(snapshot.cycle.status).toBe("correlated");
  expect(snapshot.payerAccountRef).toBe(renewalFacts.payerAccountRef);
  expect(await call("subscription_delivery_alignment_admit_renewal", [due.subscriptionId, due.scheduledAt, renewalDue]))
    .toMatchObject({ allowed: true, reason: "predecessor_delivered" });
  const rail = renewal.createPostgresSandboxRenewalRail(target.runtime, { scenario: "succeeded", now: () => renewalDue });
  const lifecycle = renewal.createPostgresRetryLifecycleBinding({ executor: target.runtime, async withTransaction(work) {
    const client = await target.runtime.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }, settlement: () => settlement, correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
  const result = await renewal.runOneAutomaticSubscriptionRenewal({ store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
    inventory: { expireReservations: async () => 0, reserve: i => call<RenewalReservationResult>("fulfillment_reserve_subscription_renewal", [i.operationId, i.claimToken, 900, i.now]) },
    paymentRails: { resolve: channel => channel === "sandbox" ? rail : null }, workerId: "transfer-renewal", policy: renewal.createSandboxRenewalPolicy(renewalFacts.methodRef),
  }, due, renewalDue);
  expect(result.status).toBe("succeeded");
  expect((await target.runtime.query("SELECT status FROM public.subscriptions WHERE id=$1", [retainedRenewal.subscriptionId])).rows[0].status).toBe("active");
}, 30_000);

// Three real restore outcomes, full graph censuses and post-replay runtime
// checks share one bounded hosted integration deadline; retry remains zero.
it("preserves the connected retained graph, pruned history and exact replay under actual roles", async () => {
  const sourceBefore = await census(source.owner), targetBefore = await census(target.owner);
  const ledger = (await target.owner.query("SELECT to_jsonb(m)::text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows;
  const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  if (!media) throw new Error("Connected media fixture missing");
  const mediaInput = { root: media.targetRoot, census: media.census, ...mediaLimits,
    objects: createOrderReviewMediaTransferReader({ root: media.sourceRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes }),
    temporary: createOrderReviewMediaTransferReader({ root: media.sourceRoot, maximumObjectBytes: mediaLimits.maximumObjectBytes, area: "tmp" }),
  };
  expect(await restoreOrderReviewMediaFilesystem(mediaInput)).toEqual({ replayed: false, objects: 2, temporary: 1 });
  // Files can publish before a failed DB transaction. The target stays inactive;
  // exact filesystem replay plus the original pristine DB baseline permits retry.
  await expect(restore(corruptDeclaredTotal())).rejects.toMatchObject({ code: "target_conflict" });
  expect(await census(target.owner)).toEqual(targetBefore);
  expect((await restoreOrderReviewMediaFilesystem(mediaInput)).replayed).toBe(true);
  const result = await restore();
  expect(result).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 1 });
  expect(await census(target.owner)).toEqual(sourceBefore);
  expect((await target.owner.query("SELECT to_jsonb(m)::text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows).toEqual(ledger);
  expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
  expect((await target.owner.query("SELECT 1 FROM public.outbox_events WHERE idempotency_key=$1", [`shipment_exception:${prunedHold}`])).rows).toEqual([]);
  expect((await target.owner.query("SELECT 1 FROM public.outbox_events WHERE idempotency_key=$1", [`shipment_exception:${retainedHold}`])).rows).toHaveLength(1);
  expect((await target.owner.query("SELECT unit_amount_minor::text AS value FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [graph.subscription])).rows[0].value).toBe("9007199254740993");
  const tuples = (await target.owner.query("SELECT xmin::text FROM public.clients WHERE id=$1", [graph.client])).rows;
  expect((await restore()).replayed).toBe(true);
  expect((await target.owner.query("SELECT xmin::text FROM public.clients WHERE id=$1", [graph.client])).rows).toEqual(tuples);
  expect((await restoreOrderReviewMediaFilesystem(mediaInput)).replayed).toBe(true);
  const runtimeStore = await OrderReviewMediaObjectStore.create(media.targetRoot);
  const mediaPort = createPostgresOrderReviewMediaPort(target.runtime);
  const authorized = await mediaPort.readAuthorized(media.grant, media.confirmedRef);
  if (!authorized) throw new Error("Retained review grant did not authorize its media under actual R");
  expect(await runtimeStore.inspect(authorized.objectKey)).toMatchObject({ exists: true,
    sha256: authorized.media.observedDigest, bytes: authorized.media.observedByteLength });
  const downloaded: Uint8Array[] = []; for await (const chunk of await runtimeStore.open(authorized.objectKey)) downloaded.push(chunk);
  expect(createHash("sha256").update(Buffer.concat(downloaded)).digest("hex")).toBe(authorized.media.observedDigest);
  expect(await mediaPort.readAuthorized(`review-grant:${randomUUID()}`, media.confirmedRef)).toBeNull();
  expect(await mediaPort.readAuthorized(media.grant, media.pendingRef)).toBeNull();
  expect(await mediaPort.readAuthorized(media.grant, media.cleanupRef)).toBeNull();
  expect(await runtimeStore.inspect(media.partialTemp)).toMatchObject({ exists: true, bytes: 8 });
  expect(await captureOrderReviewMediaFilesystem({ root: media.targetRoot, ...mediaLimits })).toEqual(media.census);
  const verified = await identity.verifier.verifyToken(identity.accessToken);
  if (!verified.ok) throw new Error("Retained source token did not verify at target");
  const gateway = createPostgresDataGateway({ connectionString: target.runtimeUrl }, { poolFactory: () => target.runtime });
  const me = (principalId: string) => gateway.asActor({ sub: principalId, role: "authenticated" }, db => createPostgresCustomerMePort(db as PgGatewayClient).getCustomerMe(principalId));
  expect(await me(verified.principal.principalId)).toMatchObject({ clientId: graph.client, email: "retained@example.invalid" });
  const other = await identity.verifier.verifyToken(await identity.token("different-signed-subject"));
  if (!other.ok) throw new Error("Distinct owned subject token did not verify");
  expect(await me(other.principal.principalId)).toBeNull();
  const accounts = createPostgresAccountLinkStore({ connectionString: target.runtimeUrl }); ports.push(accounts);
  await expect(accounts.createAccount({ email: "erased@example.invalid", principalId: erased, acquisitionSource: "direct", lifecycleStage: "lead" })).rejects.toThrow("account_erased_refused");
  await expect(target.restore.query("SELECT id FROM public.clients")).rejects.toMatchObject({ code: "42501" });
  await expect(target.runtime.query("SET ROLE openlup_retained_import_owner")).rejects.toMatchObject({ code: "42501" });
  expect((await target.runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
  // Import never claims delivery. Only this explicit synthetic arrival after
  // recovery may shift the schedule, through the existing actual runtime rail.
  expect((await target.owner.query("SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1", [successor])).rows[0].delivered_at).toBeNull();
  const arrival = () => target.runtime.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)", ["retained-late-arrival", successor, "2027-03-10T12:00:00.654321Z", "evidence:owned-arrival-evidence"]);
  await arrival();
  const schedule = (await target.owner.query("SELECT next_cycle_at::text FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows;
  await arrival();
  expect((await target.owner.query("SELECT next_cycle_at::text FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows).toEqual(schedule);
  expect(schedule[0].next_cycle_at).toBe("2027-04-07 12:00:00.654321+00");
}, 30_000);

// Solo without coverage: 7.90 s; 30 s exceeds three times that measurement.
it("retains actor-written consent history, replay, suppression and trusted target across a store move", async () => {
  expect(pristine.owned.find(table => table.table === "customer_account_consent_sync_targets")!.rows).toEqual([]);
  await target.owner.query("INSERT INTO public.customer_account_consent_sync_targets(binding,provider_kind,enabled) VALUES('different-target','synthetic-provider',false)");
  try {
    await expect(restore()).rejects.toMatchObject({ code: "target_conflict" });
    expect((await target.owner.query("SELECT binding,enabled FROM public.customer_account_consent_sync_targets")).rows).toEqual([{ binding: "different-target", enabled: false }]);
  } finally { await target.owner.query("DELETE FROM public.customer_account_consent_sync_targets"); }
  await restore();
  expect(await census(target.owner)).toEqual(await census(source.owner));
  expect(await consentRead(target, consent.principal, graph.client)).toEqual(consent.choices);
  expect(consent.choices).toMatchObject({ marketingNewsletter: { state: "granted", granted: true }, marketingGiftsDiscounts: { state: "denied", granted: false } });
  expect(await consentRead(target, consent.heldPrincipal, consent.heldClient)).toEqual(consent.heldChoices);
  expect(consent.heldChoices.marketingGiftsDiscounts).toMatchObject({ state: "suppressed", granted: false });
  const beforeReplay = await census(target.owner);
  for (const [key, purpose, value, receipt] of [
    ["transfer-newsletter", "marketing_newsletter", true, consent.newsletter],
    ["transfer-gift-grant", "marketing_gifts_discounts", true, consent.giftGrant],
    ["transfer-gift-withdraw", "marketing_gifts_discounts", false, consent.giftWithdraw],
  ] as const) expect(await consentSet(target, consent.principal, graph.client, purpose, value, key)).toEqual({ ...receipt, replayed: true, choices: consent.choices });
  expect(await consentSet(target, consent.heldPrincipal, consent.heldClient, "marketing_gifts_discounts", true, "transfer-after-bounce"))
    .toEqual({ ...consent.heldGrant, replayed: true, choices: consent.heldChoices });
  await expect(consentSet(target, consent.principal, graph.client, "marketing_gifts_discounts", false, "transfer-gift-grant"))
    .rejects.toMatchObject({ code: "23505", message: "account_consent_idempotency_conflict" });
  expect(await census(target.owner)).toEqual(beforeReplay);
  expect((await restore()).replayed).toBe(true);
  const result = await consentSet(target, consent.heldPrincipal, consent.heldClient, "marketing_gifts_discounts", true, "target-still-held");
  expect(result.choices.marketingGiftsDiscounts).toMatchObject({ state: "suppressed", granted: false });
  expect((await target.owner.query("SELECT binding,provider_kind,event_kind FROM public.communication_native_sync_state WHERE work_id=$1", [result.workId])).rows)
    .toEqual([{ binding: "retained-account", provider_kind: "synthetic-provider", event_kind: "suppress" }]);
  expect((await target.owner.query("SELECT count(*)::int AS n FROM public.customer_account_consent_events")).rows[0].n)
    .toBe(beforeReplay.customer_account_consent_events.length + 1);
  expect((await target.owner.query("SELECT to_jsonb(t)::text AS value FROM public.customer_account_consent_sync_targets t")).rows.map(row => row.value))
    .toEqual(packet.owned.find(table => table.table === "customer_account_consent_sync_targets")!.rows);
}, 30_000);

// Solo without coverage: 4.18 s; 30 s exceeds three times that measurement.
it("counts personal consent history and attribution toward whole-capture row and byte limits", async () => {
  const index = packet.owned.findIndex(table => table.table === "customer_account_consent_events");
  const ledger = packet.owned[index]!;
  expect(ledger.rows).toHaveLength(5);
  const event = JSON.parse(ledger.rows[0]!) as Record<string, unknown>;
  expect(event).toMatchObject({ source: "customer_communication_preferences", source_ref: { route: "/api/bff/customers/communication-preferences" } });
  expect(event.recipient_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(event.principal_id).toEqual(expect.any(String));
  const prior = [...packet.compatible.tables, ...packet.owned.slice(0, index)];
  const priorRows = prior.reduce((total, table) => total + table.rows.length, 0);
  const priorBytes = prior.reduce((total, table) => total + table.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0), 0);
  const ledgerBytes = ledger.rows.reduce((total, row) => total + Buffer.byteLength(row), 0);
  for (const limits of [{ maximumRows: priorRows + ledger.rows.length - 1, maximumBytes: 64 * 1024 * 1024 },
    { maximumRows: 10000, maximumBytes: priorBytes + ledgerBytes - 1 }]) {
    await expect(captureConnectedNativeStore({ sourceId: "consent-limit-proof", catalogueId: selected.objectInventorySha256, ...limits,
      source: { async withSnapshot(work) {
        const client = await source.owner.connect();
        try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) }); await client.query("COMMIT"); return result; }
        catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      } },
    })).rejects.toMatchObject({ code: "limit_exceeded", table: "customer_account_consent_events" });
  }
}, 30_000);

// Solo without coverage: 6.52 s; 30 s exceeds three times that measurement.
it("retains terminal event and reminder refusals after changed policy, restore and replay", async () => {
  await restore();
  const rows = async () => (await target.runtime.query(`SELECT source,source_id,reason,
    to_char(refused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,xmin::text,ctid::text
    FROM public.subscription_notice_refusals ORDER BY source,source_id`)).rows;
  const before = await rows();
  expect(before).toHaveLength(6);
  expect((await census(target.owner)).subscription_notice_refusals).toEqual((await census(source.owner)).subscription_notice_refusals);
  for (let replay = 0; replay < 2; replay++) {
    const sent = await dispatchNotices(target);
    for (const notice of terminalNotices) expect(sent).not.toContain(`subscription-notice:${notice.source}:${notice.id}`);
    expect(await rows()).toEqual(before);
  }
  expect((await restore()).replayed).toBe(true);
  expect(await rows()).toEqual(before);
}, 30_000);

// Solo without coverage: 3.85 s; 30 s exceeds three times that measurement.
it("counts terminal refusal source identities and times toward capture row and byte limits", async () => {
  const index = packet.owned.findIndex(table => table.table === "subscription_notice_refusals");
  const retained = packet.owned[index]!;
  expect(retained.rows).toHaveLength(6);
  const prior = [...packet.compatible.tables, ...packet.owned.slice(0, index)];
  const rowCount = prior.reduce((sum, table) => sum + table.rows.length, 0);
  const bytes = prior.reduce((sum, table) => sum + table.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
  for (const limits of [{ maximumRows: rowCount + 5, maximumBytes: 64 * 1024 * 1024 },
    { maximumRows: 10000, maximumBytes: bytes + retained.rows.reduce((total, row) => total + Buffer.byteLength(row), 0) - 1 }]) {
    await capture(source.owner, "terminal-refusal-limits", limits).then(() => { throw new Error("Expected the terminal refusal capture limit"); },
      (error: { code: string; table?: string }) => expect({ code: error.code, table: error.table })
        .toEqual({ code: "limit_exceeded", table: "subscription_notice_refusals" }));
  }
}, 30_000);


it("checks the identity mapper's erased-subject and conflict branches with synthetic records", async () => {
  const issuer = "https://issuer.example.invalid/managed";
  const liveManagedId = randomUUID(), erasedManagedId = randomUUID(), adminManagedId = randomUUID(), revokedManagedId = randomUUID();
  const liveClient = randomUUID(), erasedClient = randomUUID(), auditId = randomUUID(), erasureId = randomUUID();
  const created = "2025-01-01T00:00:00.123456Z", revokedAt = "2025-02-01T00:00:00.123456Z";
  const sourceRows = {
    clients: [
      { id: liveClient, created_at: created, updated_at: created, email: "shared@example.invalid", first_name: "Retained",
        last_name: null, phone: null, country: null, lifecycle_stage: "customer", acquisition_source: null,
        external_ref: null, metadata: {}, preferences: {}, auth_user_id: liveManagedId, identity_kind: "customer", marketing_contact_id: null },
      { id: erasedClient, created_at: created, updated_at: revokedAt, email: `erased+${erasedClient}@identity.invalid`, first_name: null,
        last_name: null, phone: null, country: null, lifecycle_stage: "inactive", acquisition_source: null,
        external_ref: null, metadata: {}, preferences: {}, auth_user_id: null, identity_kind: "customer", marketing_contact_id: null },
    ],
    adminUsers: [
      { id: adminManagedId, email: "shared@example.invalid", created_at: created, role: "admin", is_machine_actor: false,
        membership_state: "active", membership_provenance: "legacy", membership_accepted_at: created,
        membership_revoked_at: null, membership_revoked_by: null, membership_revocation_reason: null },
      { id: revokedManagedId, email: "revoked@example.invalid", created_at: created, role: "distributor", is_machine_actor: false,
        membership_state: "revoked", membership_provenance: "legacy", membership_accepted_at: created,
        membership_revoked_at: revokedAt, membership_revoked_by: adminManagedId, membership_revocation_reason: "policy" },
    ],
    revokeAudit: [{ id: auditId, actor_admin_id: adminManagedId, actor_email: "shared@example.invalid", actor_kind: "human",
      action: "revoke", source: "admin_ui", entity_type: "admin_user_membership", entity_id: revokedManagedId,
      target_admin_id: revokedManagedId, target_email: "revoked@example.invalid",
      old_value: { membershipState: "active", role: "distributor" },
      new_value: { membershipState: "revoked", revokedAt, revokedBy: adminManagedId, revocationReason: "policy" },
      occurred_at: revokedAt, idempotency_key: null, request_id: null }],
    erasures: [{ erasure_id: erasureId, idempotency_key: randomUUID(), client_id: erasedClient, principal_id: erasedManagedId,
      actor_principal_id: adminManagedId, contract_version: "identity.erasure.v1", contributor_versions: { identity: 1 },
      dispositions: [{ resource: "contact", disposition: "erased" }], retained_obligations: [], completed_at: revokedAt }],
    lifecycleEvents: [{ id: randomUUID(), client_id: liveClient, from_stage: null, to_stage: "customer", occurred_at: created },
      { id: randomUUID(), client_id: erasedClient, from_stage: "customer", to_stage: "inactive", occurred_at: revokedAt }],
  };
  const before = await census(target.owner);
  const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  const sourceClient = await source.owner.connect();
  let observed: ConnectedNativeStoreCapture["observation"];
  let sourceProjection: typeof sourceRows;
  try {
    await sourceClient.query("CREATE TEMP TABLE managed_identity_projection(kind text NOT NULL,payload jsonb NOT NULL)");
    for (const [kind, rows] of Object.entries(sourceRows)) for (const row of rows) {
      await sourceClient.query("INSERT INTO managed_identity_projection(kind,payload) VALUES($1,$2::jsonb)", [kind, JSON.stringify(row)]);
    }
    await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const fact = (await sourceClient.query<{ cluster: string; database: string; login: string; snapshot: string }>(`SELECT
      ${connectedStoreClusterIdentitySql} AS cluster,current_database() AS database,
      session_user::text AS login,txid_current_snapshot()::text AS snapshot`)).rows[0]!;
    observed = fact;
    // The local managed fixture is a PostgreSQL projection, not a provider-auth
    // token or source-key export. Read exact stored JSON values in one snapshot.
    const stored = async <T>(kind: string): Promise<T[]> => (await sourceClient.query<{ payload: string }>(
      "SELECT payload::text FROM managed_identity_projection WHERE kind=$1 ORDER BY payload::text", [kind]))
      .rows.map(row => JSON.parse(row.payload) as T);
    sourceProjection = {
      clients: await stored<(typeof sourceRows.clients)[number]>("clients"),
      adminUsers: await stored<(typeof sourceRows.adminUsers)[number]>("adminUsers"),
      revokeAudit: await stored<(typeof sourceRows.revokeAudit)[number]>("revokeAudit"),
      erasures: await stored<(typeof sourceRows.erasures)[number]>("erasures"),
      lifecycleEvents: await stored<(typeof sourceRows.lifecycleEvents)[number]>("lifecycleEvents"),
    };
    await sourceClient.query("COMMIT");
  } catch (error) { await sourceClient.query("ROLLBACK"); throw error; }
  finally { await sourceClient.query("DROP TABLE IF EXISTS managed_identity_projection").catch(() => undefined); sourceClient.release(); }
  const subjects = [liveManagedId, erasedManagedId, adminManagedId, revokedManagedId]
    .map(managedId => ({ managedId, subject: managedId }));
  const evidence: ManagedIdentityMappingSource = { sourceId: "representative-managed-identity", issuer,
    observation: observed, subjects, ...sourceProjection };
  const mapped = await mapManagedIdentityForConnectedRestore({ source: evidence, freshTarget: pristine, targetOwner: target.owner });
  const otherIssuer = await mapManagedIdentityForConnectedRestore({ source: { ...evidence,
    issuer: "https://other-issuer.example.invalid/managed" }, freshTarget: pristine, targetOwner: target.owner });
  expect(otherIssuer.subjects[0]!.principalId).not.toBe(mapped.subjects[0]!.principalId);
  expect(mapped.subjects).toEqual(subjects.map(({ managedId, subject }) => ({ managedId, issuer, subject,
    principalId: deriveOidcPrincipalId(issuer, subject) })));
  expect(mapped.packet.observation).toEqual(observed);
  expect(mapped.auditReferences).toEqual([{ sourceId: evidence.sourceId, sourceRowId: auditId, targetAuditId: auditId }]);
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: mapped.packet, freshTarget: pristine }))
    .toMatchObject({ replayed: false });
  expect((await target.owner.query("SELECT id,principal_id,email FROM public.clients ORDER BY id")).rows).toEqual([
    { id: liveClient, principal_id: deriveOidcPrincipalId(issuer, liveManagedId), email: "shared@example.invalid" },
    { id: erasedClient, principal_id: null, email: `erased+${erasedClient}@identity.invalid` },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  expect((await target.owner.query("SELECT principal_id,role,membership_state FROM public.platform_human_memberships ORDER BY principal_id")).rows)
    .toEqual([{ principal_id: deriveOidcPrincipalId(issuer, adminManagedId), role: "admin", membership_state: "active" },
      { principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), role: "distributor", membership_state: "revoked" }]
      .sort((a, b) => a.principal_id.localeCompare(b.principal_id)));
  expect((await target.owner.query("SELECT actor_principal_id,target_principal_id,old_value,new_value FROM public.platform_human_membership_audit_events WHERE id=$1", [auditId])).rows)
    .toEqual([{ actor_principal_id: deriveOidcPrincipalId(issuer, adminManagedId),
      target_principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), old_value: { membershipState: "active", role: "distributor" },
      new_value: { membershipState: "revoked", revokedAt, revokedBy: deriveOidcPrincipalId(issuer, adminManagedId),
        revocationReason: "policy", sourceAuditRef: { sourceId: evidence.sourceId, rowId: auditId } } }]);
  expect((await target.owner.query("SELECT principal_id,client_id,dispositions FROM public.identity_privacy_erasures WHERE erasure_id=$1", [erasureId])).rows)
    .toEqual([{ principal_id: deriveOidcPrincipalId(issuer, erasedManagedId), client_id: erasedClient,
      dispositions: [{ resource: "contact", disposition: "erased" }] }]);
  expect((await target.owner.query("SELECT email,first_name,last_name,phone,country,metadata,principal_id FROM public.clients WHERE id=$1", [erasedClient])).rows)
    .toEqual([{ email: `erased+${erasedClient}@identity.invalid`, first_name: null, last_name: null,
      phone: null, country: null, metadata: {}, principal_id: null }]);
  expect((await target.owner.query("SELECT from_stage,to_stage FROM public.customer_subject_lifecycle_events WHERE client_id=$1 ORDER BY occurred_at", [erasedClient])).rows)
    .toEqual([{ from_stage: "customer", to_stage: "inactive" }]);
  const accounts = createPostgresAccountLinkStore({ connectionString: target.runtimeUrl }); ports.push(accounts);
  await expect(accounts.createAccount({ email: "same@example.invalid", principalId: deriveOidcPrincipalId(issuer, erasedManagedId),
    acquisitionSource: "direct", lifecycleStage: "lead" })).rejects.toThrow("account_erased_refused");
  expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
  expect((await restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: mapped.packet, freshTarget: pristine })).replayed).toBe(true);
  const linkedSource = evidence.clients.find(row => row.auth_user_id === liveManagedId)!;
  const erasedSource = evidence.clients.find(row => row.id === erasedClient)!;
  const invalid = [
    { ...evidence, subjects: subjects.filter(value => value.managedId !== liveManagedId) },
    { ...evidence, erasures: [] },
    { ...evidence, clients: [{ ...evidence.clients[0], preferences: { hidden: true } }, evidence.clients[1]] },
    { ...evidence, adminUsers: [{ ...evidence.adminUsers[0], is_machine_actor: true }, evidence.adminUsers[1]] },
    { ...evidence, erasures: [{ ...evidence.erasures[0], principal_id: liveManagedId }] },
    { ...evidence, erasures: [{ ...evidence.erasures[0], unsupported_field: "retained-source-only" }] },
    { ...evidence, erasures: [...evidence.erasures, { ...evidence.erasures[0], erasure_id: randomUUID(),
      idempotency_key: randomUUID(), client_id: null, principal_id: adminManagedId }] },
    { ...evidence, adminUsers: evidence.adminUsers.map(row => row.id === revokedManagedId
      ? { ...row, email: `erased+${revokedManagedId}@identity.invalid` } : row) },
    { ...evidence, issuer: "https://issuer.example.invalid/managed#alias" },
    { ...evidence, revokeAudit: [{ ...evidence.revokeAudit[0], actor_admin_id: randomUUID() }] },
    { ...evidence, revokeAudit: [{ ...evidence.revokeAudit[0], unexpected_field: "unsafe" }] },
    { ...evidence, clients: evidence.clients.map(row => row.id === erasedClient ? { ...row, email: "erased+leak@example.invalid" } : row) },
  ];
  for (const candidate of invalid) await expect(mapManagedIdentityForConnectedRestore({ source: candidate, freshTarget: pristine, targetOwner: target.owner }))
    .rejects.toMatchObject({ code: "invalid_input" });
  const redactedOperator = { ...evidence,
    adminUsers: evidence.adminUsers.map(row => row.id === revokedManagedId
      ? { ...row, email: `erased+${revokedManagedId}@identity.invalid`, membership_revocation_reason: null } : row),
    revokeAudit: [{ ...evidence.revokeAudit[0], new_value: { membershipState: "revoked", revokedAt, revokedBy: adminManagedId } }],
    erasures: [...evidence.erasures, { ...evidence.erasures[0], erasure_id: randomUUID(),
      idempotency_key: randomUUID(), client_id: null, principal_id: revokedManagedId }],
  };
  const redactedMapping = await mapManagedIdentityForConnectedRestore({ source: redactedOperator,
    freshTarget: pristine, targetOwner: target.owner });
  const mappedRows = (table: string) => (redactedMapping.packet.compatible.tables.find(entry => entry.table === table)
    ?? redactedMapping.packet.owned.find(entry => entry.table === table))!.rows
    .map(row => JSON.parse(row) as Record<string, unknown>);
  expect(mappedRows("platform_human_principals")).toContainEqual(expect.objectContaining({
    principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), email: `erased+${revokedManagedId}@identity.invalid` }));
  expect(mappedRows("platform_human_memberships")).toContainEqual(expect.objectContaining({
    principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), membership_state: "revoked", membership_revocation_reason: null }));
  expect(mappedRows("identity_privacy_erasures")).toContainEqual(expect.objectContaining({
    principal_id: deriveOidcPrincipalId(issuer, revokedManagedId), client_id: null }));
  for (const field of [
    { old_value: { ...(evidence.revokeAudit[0]!.old_value as Record<string, unknown>), role: "admin" } },
    { new_value: { ...(evidence.revokeAudit[0]!.new_value as Record<string, unknown>), revokedBy: liveManagedId } },
    { new_value: { ...(evidence.revokeAudit[0]!.new_value as Record<string, unknown>), revokedAt: created } },
    { new_value: { ...(evidence.revokeAudit[0]!.new_value as Record<string, unknown>), revocationReason: "different" } },
  ]) await expect(mapManagedIdentityForConnectedRestore({ source: { ...evidence,
    revokeAudit: [{ ...evidence.revokeAudit[0], ...field }] }, freshTarget: pristine, targetOwner: target.owner }))
    .rejects.toMatchObject({ code: "target_conflict", table: "platform_human_membership_audit_events" });
  await expect(mapManagedIdentityForConnectedRestore({ source: { ...evidence,
    adminUsers: evidence.adminUsers.map(row => row.id === revokedManagedId
      ? { ...row, membership_revoked_by: revokedManagedId } : row) },
  freshTarget: pristine, targetOwner: target.owner }))
    .rejects.toMatchObject({ code: "target_conflict", table: "platform_human_membership_audit_events" });
  await expect(mapManagedIdentityForConnectedRestore({ source: { ...evidence, clients: [linkedSource,
    { ...linkedSource, id: randomUUID(), email: "other@example.invalid" }, erasedSource] },
  freshTarget: pristine, targetOwner: target.owner })).rejects.toMatchObject({ code: "target_conflict", table: "clients" });
  expect(before.clients).toEqual([]);
}, 30_000);

// Solo without coverage: 4.97 s including restore; retain 30 s headroom.
it("retains private destinations, scoped bindings, support replay and exact address data after restore", async () => {
  await restore();
  // The existing census compares every field in UTC without truncating stored microseconds.
  const targetRows = await census(target.owner), sourceRows = await census(source.owner);
  for (const table of ["commerce_destinations", "commerce_destination_bindings", "subscription_command_receipts", "customer_support_subscription_commands", "customer_support_subscription_audit_events"]) {
    expect(targetRows[table]).toEqual(sourceRows[table]);
  }
  const original = await createPostgresDestinationPort(target.runtime).registerOrder({ idempotencyKey: `destination-${graph.order}`, orderId: graph.order,
    address: { recipientName: "Synthetic personal recipient", line1: "Synthetic personal street", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: "2026-09-02T12:00:00Z" });
  expect(original).toEqual(retainedDestination);
  const replay = await target.runtime.query("SELECT public.customer_support_change_shipping_destination($1,$2,$3,$4,$5,'2026-09-02T12:00:00Z') result", [destinationCommand.operator, destinationCommand.subscription, destinationCommand.payload, destinationCommand.version, destinationCommand.key]);
  expect(replay.rows[0].result).toMatchObject({ replayed: true });
  await expect(target.runtime.query("SELECT public.customer_support_change_shipping_destination($1,$2,$3,$4,$5,'2026-09-02T12:00:00Z')", [destinationCommand.operator, destinationCommand.subscription, destinationCommand.payload, destinationCommand.version + 1, destinationCommand.key])).rejects.toMatchObject({ code: "23505" });
}, 30_000);

// Solo without coverage: 3.68 s including restore; retain 30 s headroom.
it("enforces actual cumulative row and byte limits at EACH address relation", async () => {
  for (const table of ["commerce_destinations", "commerce_destination_bindings"]) {
    const index = packet.owned.findIndex(t => t.table === table);
    const prior = [...packet.compatible.tables, ...packet.owned.slice(0, index)];
    const rowsBefore = prior.reduce((n, t) => n + t.rows.length, 0);
    const bytesBefore = prior.reduce((n, t) => n + t.rows.reduce((m, row) => m + Buffer.byteLength(row), 0), 0);
    const relation = packet.owned[index]!;
    expect(relation.rows.length).toBeGreaterThan(0);
    for (const limits of [
      { maximumRows: rowsBefore + relation.rows.length - 1, maximumBytes: 64 * 1024 * 1024 },
      { maximumRows: 10000, maximumBytes: bytesBefore + relation.rows.reduce((n, row) => n + Buffer.byteLength(row), 0) - 1 },
    ]) {
      await expect(captureConnectedNativeStore({ sourceId: "address-bounded", catalogueId: selected.objectInventorySha256, ...limits,
        source: { async withSnapshot(work) { const client = await source.owner.connect();
          try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); return await work({ query: (sql, args) => client.query(sql, args ? [...args] : undefined) }); }
          finally { await client.query("ROLLBACK"); client.release(); }
        } } })).rejects.toMatchObject({ code: "limit_exceeded", table });
    }
  }
}, 30_000);


it("drains every target acquisition command before opening a new installation-key namespace", async () => {
  const sourcePort = createPostgresPartnerAcquisitionPort({ connectionString: source.ownerUrl });
  const targetPort = createPostgresPartnerAcquisitionPort({ connectionString: target.ownerUrl });
  ports.push(sourcePort, targetPort);
  const input = { idempotencyKey: "managed-drain-command-1", requesterKey: "synthetic-requester",
    policyVersion: "partner-inquiry-request-v1", sourcePath: "/partners/b2b-inquiries" as const,
    acceptedAt: new Date().toISOString(), request: { company: "Synthetic Partner", country: "US",
      firstName: "Ada", lastName: "Example", email: "drain-source@example.invalid", phone: "+15551234567", notes: null } };
  expect(await sourcePort.submit(input)).toMatchObject({ ok: true, replayed: false });
  expect(await sourcePort.submit(input)).toMatchObject({ ok: true, replayed: true });
  const sourceReceipt = (await source.owner.query("SELECT to_jsonb(c)::text AS value FROM acquisition_private.commands c WHERE scope='partner_submit' AND idempotency_key=$1", [input.idempotencyKey])).rows;
  expect(sourceReceipt).toHaveLength(1);
  const sourceDigest = (await source.owner.query("SELECT encode(acquisition_private.keyed_digest('transfer-probe','{}'::jsonb),'hex') AS digest")).rows[0].digest;
  const targetDigest = (await target.owner.query("SELECT encode(acquisition_private.keyed_digest('transfer-probe','{}'::jsonb),'hex') AS digest")).rows[0].digest;
  expect(targetDigest).not.toBe(sourceDigest);
  const keyIdentity = (await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;

  const started = new Date(Date.now() - 1000).toISOString();
  const env = { OPENLUP_ACQUISITION_DRAIN_STARTED_AT: started, OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS: "3600" };
  const request = (key: string, email: string) => ({ method: "POST", query: {}, headers: { "idempotency-key": key,
    "x-forwarded-for": "127.0.0.1" }, body: { company: "Synthetic Partner", country: "US", firstName: "Ada",
    lastName: "Example", email, phone: "+15551234567", notes: null } });
  const response = () => {
    const headers: Record<string, string> = {};
    let statusCode = 0, body: unknown;
    const res = { setHeader(name: string, value: string) { headers[name] = value; return res; },
      status(value: number) { statusCode = value; return res; }, json(value: unknown) { body = value; return res; } } as unknown as VercelResponse;
    return { res, headers, get statusCode() { return statusCode; }, get body() { return body; } };
  };
  const during = response();
  await createPartnerAcquisitionSubmitHandler({ env, resolvePort: async () => targetPort })(
    request(input.idempotencyKey, "drain-source@example.invalid") as unknown as Parameters<ReturnType<typeof createPartnerAcquisitionSubmitHandler>>[0], during.res);
  expect(during.statusCode).toBe(503);
  expect(Number(during.headers["Retry-After"])).toBeGreaterThan(0);
  expect(during.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE",
    details: { reason: "acquisition_legacy_drain" } } });
  expect((await target.owner.query("SELECT count(*)::integer AS count FROM acquisition_private.commands")).rows[0].count).toBe(0);

  const ended = response();
  await createPartnerAcquisitionSubmitHandler({ env: { ...env, OPENLUP_ACQUISITION_DRAIN_ENDED_AT: new Date().toISOString() },
    resolvePort: async () => targetPort })(request(input.idempotencyKey, "drain-source@example.invalid") as unknown as Parameters<ReturnType<typeof createPartnerAcquisitionSubmitHandler>>[0], ended.res);
  expect(ended.statusCode).toBe(200);
  expect((await target.owner.query("SELECT count(*)::integer AS count FROM acquisition_private.commands WHERE scope='partner_submit' AND idempotency_key=$1", [input.idempotencyKey])).rows[0].count).toBe(1);

  const maximum = response();
  await createPartnerAcquisitionSubmitHandler({ env: { OPENLUP_ACQUISITION_DRAIN_STARTED_AT: new Date(Date.now() - 2000).toISOString(),
    OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS: "1" }, resolvePort: async () => targetPort })(
    request("managed-drain-command-2", "drain-second@example.invalid") as unknown as Parameters<ReturnType<typeof createPartnerAcquisitionSubmitHandler>>[0], maximum.res);
  expect(maximum.statusCode).toBe(200);
  expect((await target.owner.query("SELECT count(*)::integer AS count FROM acquisition_private.commands WHERE scope='partner_submit'")).rows[0].count).toBe(2);
  expect((await source.owner.query("SELECT to_jsonb(c)::text AS value FROM acquisition_private.commands c WHERE scope='partner_submit' AND idempotency_key=$1", [input.idempotencyKey])).rows).toEqual(sourceReceipt);
  expect((await target.owner.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows).toEqual(keyIdentity);
}, 30_000);


// Solo 15.06 s without coverage; 60 s covers installed tarballs, capture/restore and child restart with headroom.
it("preserves native checkout receipt identity, privacy and microseconds across transfer and restart", async () => {
  const { installSubscriptionConsumer } = await import("../helpers/installSubscriptionConsumer.js");
  const { execFileSync } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const consumer = await mkdtemp(join(process.cwd(), ".context/scratch/checkout-transfer-consumer-"));
  try {
    const installed = await installSubscriptionConsumer(consumer);
    const checkout = await import(installed.resolve("@openlup/platform/commerce/server/native-checkout")) as typeof import("@openlup/platform/commerce/server/native-checkout");
    const native = await installation("checkout-source");
    const clientId = randomUUID(), principalId = randomUUID(), skuId = randomUUID(), listId = randomUUID();
    await native.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'checkout-transfer@example.invalid')", [principalId]);
    await native.owner.query("INSERT INTO public.clients(id,principal_id,email) VALUES($1,$2,'checkout-transfer@example.invalid')", [clientId, principalId]);
    await native.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'checkout-transfer','Synthetic checkout')", [skuId]);
    await native.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,'CHECKOUT-TRANSFER','Synthetic checkout')", [skuId]);
    await native.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic checkout','ZZ','XXX')", [listId]);
    await native.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,100)", [listId, skuId]);
    const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
    const request = { idempotencyKey: `checkout-transfer:${randomUUID()}`, quoteSnapshot: { contractVersion: "commerce.v0" as const, quote: {
      currency: "XXX", taxIncluded: true as const,
      lines: [{ sku: "CHECKOUT-TRANSFER", productSlug: "checkout-transfer", quantity: 2,
        unitPriceGross: money(100), lineSubtotalGross: money(200), tax: { included: true as const, country: "ZZ",
          category: "standard", vatRateBps: 2000, legalBasis: "Synthetic transfer tax", netAmount: money(167), vatAmount: money(33), grossAmount: money(200) } }],
      discounts: [], context: { mode: "one_time" as const, cadenceDays: null, promoCodes: [],
        hostFacts: { clientId, principalId, contact: "checkout-transfer@example.invalid" } },
      subtotalGross: money(200), discountTotalGross: money(0), shippingGross: money(0), shippingDiscountGross: money(0),
      totalGross: money(200), netTotal: money(167), taxTotal: money(33) } } };
    const created = await checkout.createPostgresNativeCheckoutPersistence(native.runtime).createOrderDraft(request, { clientId });
    const orderId = created.orderDraft.orderId.replace(/^order_/, "");
    // Precision fixture only: the public writer creates the receipt; its timestamp is not part of the request fingerprint.
    await native.owner.query("UPDATE public.commerce_order_draft_receipts SET created_at='2026-11-03T12:34:56.123456Z' WHERE order_id=$1", [orderId]);
    const carried = await capture(native.owner, "native-checkout-source");
    const receipt = carried.owned.find(data => data.table === "commerce_order_draft_receipts")!;
    expect(receipt.rows).toHaveLength(1);
    const receiptRow = JSON.parse(receipt.rows[0]!);
    const order = JSON.parse(carried.compatible.tables.find(data => data.table === "commerce_orders")!.rows[0]!);
    expect(receiptRow.response_payload.orderDraft.quoteSnapshot).toEqual(order.metadata.quoteSnapshot);
    expect(order.metadata.quoteSnapshot).toEqual(request.quoteSnapshot);
    expect(receiptRow.created_at).toBe("2026-11-03T12:34:56.123456+00:00");
    const throughReceipt = [...carried.compatible.tables, receipt];
    const rows = throughReceipt.reduce((total, data) => total + data.rows.length, 0);
    const bytes = throughReceipt.reduce((total, data) => total + data.rows.reduce((size, row) => size + Buffer.byteLength(row), 0), 0);
    await expect(capture(native.owner, "receipt-row-bound", { maximumRows: rows - 1, maximumBytes: 64 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: "limit_exceeded", table: "commerce_order_draft_receipts" });
    await expect(capture(native.owner, "receipt-byte-bound", { maximumRows: 10000, maximumBytes: bytes - 1 }))
      .rejects.toMatchObject({ code: "limit_exceeded", table: "commerce_order_draft_receipts" });
    expect(await restore(carried)).toMatchObject({ replayed: false });
    expect((await census(target.owner)).commerce_order_draft_receipts).toEqual(receipt.rows);
    const retained = (await target.owner.query(`SELECT r.order_id,
      r.response_payload#>>'{orderDraft,orderId}' AS response_order,
      to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      r.request_fingerprint=md5((o.metadata->'quoteSnapshot')::text||'|'||(o.metadata->'orderDraftSnapshot')::text||'|'||coalesce(o.client_id::text,'')) AS fingerprint_matches,
      o.client_id,c.principal_id FROM public.commerce_order_draft_receipts r JOIN public.commerce_orders o ON o.id=r.order_id
      JOIN public.clients c ON c.id=o.client_id WHERE r.order_id=$1`, [orderId])).rows;
    expect(retained).toEqual([{ order_id: orderId, response_order: created.orderDraft.orderId,
      created_at: "2026-11-03T12:34:56.123456Z", fingerprint_matches: true, client_id: clientId, principal_id: principalId }]);
    expect((await target.owner.query("SELECT principal_id FROM public.platform_human_principals WHERE principal_id=$1", [principalId])).rows)
      .toEqual([{ principal_id: principalId }]);
    await target.runtime.end();
    const script = join(consumer, "restart-checkout.mjs");
    await writeFile(script, `import {Pool} from "pg";
import {readFileSync} from "node:fs";
import {createPostgresNativeCheckoutPersistence} from "@openlup/platform/commerce/server/native-checkout";
const input=JSON.parse(readFileSync(0,"utf8")),db=new Pool({connectionString:input.url});
try {
  const port=createPostgresNativeCheckoutPersistence(db),replay=await port.createOrderDraft(input.request,{clientId:input.clientId});
  const changed=structuredClone(input.request);changed.quoteSnapshot.quote.context.hostFacts.contact="changed@example.invalid";
  let refusal=null;try {await port.createOrderDraft(changed,{clientId:input.clientId});}catch(error){refusal={name:error.name,details:error.details};}
  const counts=(await db.query("SELECT (SELECT count(*)::int FROM public.commerce_orders) orders,(SELECT count(*)::int FROM public.commerce_order_draft_receipts) receipts,(SELECT count(*)::int FROM public.outbox_events WHERE event_type='commerce.order_draft.created') events")).rows[0];
  const role=(await db.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) elevated")).rows[0];
  console.log(JSON.stringify({replay,refusal,counts,role}));
}finally {await db.end();}`);
    const restarted = JSON.parse(execFileSync(process.execPath, [script], { cwd: consumer, encoding: "utf8", timeout: 30_000,
      input: JSON.stringify({ url: target.runtimeUrl, request, clientId }) }));
    expect(restarted.replay).toEqual({ ...created, orderDraft: { ...created.orderDraft, replayed: true } });
    expect(restarted.refusal).toMatchObject({ name: "CommerceOrderDraftConflictError", details: { code: "23505" } });
    expect(restarted.counts).toEqual({ orders: 1, receipts: 1, events: 1 });
    expect(restarted.role).toEqual({ current_user: "transfer_runtime", elevated: false });
    expect((await census(target.owner)).commerce_order_draft_receipts).toEqual(receipt.rows);
    expect(await restore(carried)).toMatchObject({ replayed: true });
    console.info("Checkout transfer retained tables:", connectedNativeStoreTables.length);
  } finally { await rm(consumer, { recursive: true, force: true }); }
}, 60_000);

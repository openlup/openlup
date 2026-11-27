import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { createPostgresAbandonedCheckoutCompensationPort, createPostgresPurchaseReservationPort, type PurchaseReservationInput } from "@openlup/platform/inventory";
import { createPostgresDestinationPort, type DestinationDocument } from "@openlup/platform/commerce/server/destinations";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import * as jose from "jose";
import * as renewal from "@openlup/platform/subscriptions";
import { expect } from "vitest";
import { disposition as orderDraftReceiptDisposition } from "./orderDraftReceiptsV2.fixture.js";
import { createCapturedTransactionalDelivery, createPostgresTransactionalDeliveryStore, createTransactionalDelivery, createPostgresDeliveryReconciliationPort } from "@openlup/platform/communications";
import { refusedNoticeSources, noticeSessionWithRecipientFault } from "./m19NoticeFixture.js";
import { createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createOidcIdentityVerifier } from "@openlup/platform/identity";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import type { SandboxPaymentAttempt, SandboxPaymentOutcome } from "@openlup/platform/payments/contracts";
import { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore, connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import type { QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { OrderReviewMediaObjectStore } from "../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { captureOrderReviewMediaFilesystem, type OrderReviewMediaFilesystemCensus } from "../../server/adapters/filesystem/orderReviewMediaTransferInventory.js";
import { fixture, openCase, replacement } from "../helpers/fulfillmentNative.js";
import type { JourneyTargetInstallation } from "../helpers/storeJourney.js";
import { composeNativePrivacy, nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";

export type Installation = JourneyTargetInstallation;

export const selection: QualifiedPostgresInstallation = {
  generation: "qualified-v2",
  roleMode: "installer-managed",
  migrationLogin: "transfer_owner",
  bootstrapLogin: "postgres",
  runtimeLogin: "transfer_runtime",
  restoreLogin: "transfer_restore",
};

export const selected = selectPlatformMigrationManifest(
  JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2",
  { migrationIsBootstrap: false, hasRestore: true },
);

export const paymentOptions = { dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment_recovered" };
export const paymentAt = "2026-10-30T12:00:00.123Z";
export const mediaLimits = { maximumFiles: 20, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
export const renewalAt = "2026-09-01T12:00:00.000Z";
export const renewalDue = "2026-09-29T12:01:00.000Z";

// Identifying-looking synthetic references deliberately demonstrate that the
// sandbox channel check does not enforce nonpersonal reference contents.
export const renewalFacts: renewal.NativeRenewalPurchaseFacts = {
  settlementChannelKey: "sandbox", authorizationRef: "sandbox-authorization:customer@example.invalid",
  unattendedChargeAuthorizedAt: renewalAt, payerAccountRef: "payer@example.invalid",
  methodRef: "sandbox-method:customer@example.invalid", methodEvidenceRef: "sandbox-evidence:customer@example.invalid",
  stockSourceKey: "transfer-renewal", templateId: "transfer-refill", cadenceDays: 28, currency: "XXX",
  lines: [{ lineOrdinal: 1, sku: "retained-sku", quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0,
  acquisitionRef: "acquisition:customer@example.invalid",
};

export type PaymentExecutor = Parameters<typeof createPostgresSandboxPaymentSimulator>[0];
export function paymentPort(db: PaymentExecutor) { return createPostgresSandboxPaymentSimulator(db, paymentOptions); }
export function paymentReceive(db: PaymentExecutor, attempt: SandboxPaymentAttempt, observationId: string) {
  return paymentPort(db).ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
    settlementIntentId: attempt.settlementIntentId, attemptId: attempt.id, observationId,
  })), headers: {}, receivedAt: paymentAt });
}
export async function paymentObservation(db: PaymentExecutor, attempt: SandboxPaymentAttempt, outcome: SandboxPaymentOutcome) {
  const input = { attemptId: attempt.id, idempotencyKey: `observation:${randomUUID()}`, outcome, occurredAt: paymentAt,
    payerEmail: "dispatch-only@example.invalid", rawPayload: { contact: "dispatch-only@example.invalid" } };
  const observation = await paymentPort(db).recordObservation(input);
  return { input, ...observation };
}

export async function capture(
  db: Pool,
  sourceId: string,
  limits = { maximumRows: 10000, maximumBytes: 64 * 1024 * 1024 },
): Promise<ConnectedNativeStoreCapture> {
  return captureConnectedNativeStore({
    sourceId, catalogueId: selected.objectInventorySha256, ...limits,
    source: {
      async withSnapshot(work) {
        const client = await db.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          await client.query("COMMIT"); return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      },
    },
  });
}

// Independent whole-row readback; no importer/capture comparison helper is used.
export async function census(db: Pool): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const client = await db.connect();
  try {
    await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL TimeZone='UTC'");
    for (const table of connectedNativeStoreTables) {
      result[table] = (await client.query(`SELECT to_jsonb(t)::text AS value FROM public."${table}" t`)).rows.map(row => String(row.value)).sort();
    }
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export function restoreInstallation(
  target: Installation,
  pristine: ConnectedNativeStoreCapture,
  capturePacket: ConnectedNativeStoreCapture,
) {
  return restoreConnectedNativeStore({ owner: target.owner, installation: selection, packet: capturePacket, freshTarget: pristine });
}

export function transferredPrivacy(target: Installation) {
  return composeNativePrivacy({
    store: createPostgresPrivacyStore(),
    unitOfWork: createPostgresPrivacyUnitOfWork({ connectionString: target.runtimeUrl }, { poolFactory: () => target.runtime }),
  }).operations;
}

export async function dispatchNotices(installation: Installation, unresolvedClients: ReadonlySet<string> = new Set()) {
  const store = createPostgresTransactionalDeliveryStore({ connectionString: installation.runtimeUrl });
  const captured: string[] = [];
  try {
    const delivery = createTransactionalDelivery({ store, delivery: createCapturedTransactionalDelivery({ outcome: command => {
      captured.push(command.idempotencyKey); return { state: "accepted" };
    } }) });
    const binding = renewal.createPostgresLifecycleMessages({
      delivery: { send: delivery.send, readReceipt: store.readReceipt },
      async withSession(work) { const db = await installation.runtime.connect(); try { return await work(noticeSessionWithRecipientFault(db, unresolvedClients)); } finally { db.release(); } },
      async bind(notice) { return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug }; },
    });
    await binding.run(100);
    return captured;
  } finally { await store.close(); }
}

export type AccountChoices = { marketingNewsletter: { state: string; granted: boolean }; marketingGiftsDiscounts: { state: string; granted: boolean } };
export type AccountReceipt = { permissionEventId: string; workId: string | null; replayed: boolean; choices: AccountChoices };

export async function consentActor<T>(db: Installation, principal: string, sql: string, values: unknown[]): Promise<T> {
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

export const consentRead = (db: Installation, principal: string, client: string) => consentActor<AccountChoices>(
  db, principal, "SELECT public.customer_account_communication_choices_as_actor($1) AS result", [client]);

export const consentSet = (db: Installation, principal: string, client: string, purpose: string, value: boolean, key: string) => consentActor<AccountReceipt>(
  db, principal, "SELECT public.customer_account_communication_choice_set_as_actor($1,$2,$3,$4) AS result", [client, purpose, value, key]);

export type MediaFixture = {
  parent: string;
  sourceRoot: string;
  targetRoot: string;
  grant: string;
  confirmedRef: string;
  pendingRef: string;
  cleanupRef: string;
  partialTemp: string;
  census: OrderReviewMediaFilesystemCensus;
};

async function renewalPurchase(source: Installation, graph: Awaited<ReturnType<typeof fixture>>, complete: boolean) {
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

async function paymentFixture(source: Installation) {
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

async function paymentTransferFixture(source: Installation) {
  const open = await paymentFixture(source), fenced = await paymentFixture(source), pending = await paymentFixture(source), review = await paymentFixture(source);
  const refused = await paymentObservation(source.runtime, fenced.attempt, "refused");
  expect((await paymentReceive(source.runtime, fenced.attempt, refused.id)).status).toBe(200);
  const nextInput = { ...fenced.input, idempotencyKey: `attempt:${randomUUID()}` };
  const active = await paymentPort(source.runtime).beginAttempt(nextInput);
  const unknown = await paymentObservation(source.runtime, active, "indeterminate");
  expect((await paymentReceive(source.runtime, active, unknown.id)).status).toBe(200);
  const captured = await paymentObservation(source.runtime, pending.attempt, "captured");
  await expect(source.runtime.query("SELECT public.oms_cancel_unpaid_order($1,$2,'buyer cancelled')", [`cancel:${review.orderId}`, review.orderId]))
    .rejects.toMatchObject({ code: "23505", message: "oms_cancel_unpaid_order_payment_in_flight" });
  // Retained historical cancellation remains transferable even with late payment evidence.
  await source.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [review.orderId]);
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
  // The retained token is minted once in beforeAll and verified late in this file. Hosted runs take up to
  // 660 s for the whole file, so the lifetime is about 4x that and stays below the verifier's 3,600 s maximum.
  const token = (subject: string) => new jose.SignJWT({ email: "retained@example.invalid", email_verified: true })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("45m")
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid }).sign(key.privateKey);
  const accessToken = await token("original-native-subject"), verified = await verifier.verifyToken(accessToken);
  if (!verified.ok) throw new Error("Owned signed native fixture did not verify");
  return { verifier, token, accessToken, principal: verified.principal };
}

async function consentFixture(
  source: Installation,
  identity: Awaited<ReturnType<typeof identityFixture>>,
  graph: Awaited<ReturnType<typeof fixture>>,
  ports: { close(): Promise<void> }[],
) {
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

async function mediaFixture(
  source: Installation,
  graph: Awaited<ReturnType<typeof fixture>>,
  mediaCleanup: { parent?: string },
): Promise<MediaFixture> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "m14-connected-media-"));
  const sourceRoot = join(parent, "source"), targetRoot = join(parent, "target");
  // Register even a partially prepared fixture for bounded teardown.
  mediaCleanup.parent = parent;
  const store = await OrderReviewMediaObjectStore.create(sourceRoot), grant = `review-grant:${randomUUID()}`;
  const subject = `client:${graph.client}`;
  await source.owner.query("INSERT INTO public.subscriber_profiles(subject_reference,revision,fingerprint) VALUES($1,1,$2)", [subject, "a".repeat(64)]);
  await source.owner.query("INSERT INTO public.subscriber_review_access_grants(order_id,kind,grant_reference,expires_at) VALUES($1,'review_request',$2,now()+interval '30 days')", [graph.order, grant]);
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
  const censusResult = await captureOrderReviewMediaFilesystem({ root: sourceRoot, ...mediaLimits });
  return { parent, sourceRoot, targetRoot, grant, confirmedRef, pendingRef, cleanupRef, partialTemp, census: censusResult };
}

export async function seedRetainedTransferStore(
  source: Installation,
  ports: { close(): Promise<void> }[],
  mediaCleanup: { parent?: string },
) {
  const identity = await identityFixture();
  const graph = await fixture(source.owner);
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
  const prunedHold = (await source.owner.query("SELECT id FROM public.commerce_order_holds WHERE idempotency_key=$1", [`exception-${graph.order}`])).rows[0].id as string;
  await openCase(source.owner, retainedGraph);
  const retainedHold = (await source.owner.query("SELECT id FROM public.commerce_order_holds WHERE idempotency_key=$1", [`exception-${retainedGraph.order}`])).rows[0].id as string;
  await source.owner.query("INSERT INTO public.commerce_order_operations(order_id,hold_id,operation_type,idempotency_key) VALUES($1,$2,'hold_created',$3)", [graph.order, prunedHold, `hold-history-${prunedHold}`]);
  await source.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.exception' AND idempotency_key=$1", [`shipment_exception:${prunedHold}`]);
  const successor = await replacement(source.owner, graph);
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
  const admin = randomUUID(), revoked = randomUUID(), erased = randomUUID();
  await source.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'admin@example.invalid'),($2,'revoked@example.invalid')", [admin, revoked]);
  await source.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy','2020-01-01')`, [admin]);
  await source.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at,membership_revoked_at,membership_revoked_by)
    VALUES($1,'distributor','revoked','legacy','2020-01-01','2021-01-01',$2)`, [revoked, admin]);
  const retainedErasure = { erasureId: randomUUID(), key: randomUUID(), actor: admin };
  const historicalVersions = Object.fromEntries(nativePrivacyContributors(createPostgresPrivacyStore())
    .filter(owner => owner.id !== "customer-saved-addresses").map(owner => [owner.id, owner.version]));
  await source.owner.query(`INSERT INTO public.identity_privacy_erasures(erasure_id,idempotency_key,principal_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
    VALUES($1,$2,$3,$4,'identity.erasure.v1',$5,$6,'[]','2022-01-01T03:04:05.123456Z')`,
  [retainedErasure.erasureId, retainedErasure.key, erased, admin, historicalVersions, JSON.stringify([orderDraftReceiptDisposition])]);
  await source.owner.query("INSERT INTO public.identity_privacy_erasure_reconciliations(erasure_id,contributor_id,evidence_ref) VALUES($1,'customer-saved-addresses',$2)",
    [retainedErasure.erasureId, randomUUID()]);
  const media = await mediaFixture(source, graph, mediaCleanup);
  const consent = await consentFixture(source, identity, graph, ports);

  const retainedRenewal = await renewalPurchase(source, graph, true);
  await source.owner.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,
    quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
    VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-09-02')`, [retainedRenewal.subscriptionId]);
  const pendingRenewal = await renewalPurchase(source, graph, false);

  const payments = await paymentTransferFixture(source);
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
  const purchaseHold: PurchaseReservationInput = { idempotencyKey: "retained-purchase-hold", orderId: purchaseOrder, stockSourceKey: "retained-stock",
    items: [{ orderItemId: purchaseItem, skuId: sku, quantity: 2 }], paymentStatus: "created",
    expiresAt: "2026-09-02T12:00:00.000Z", now: "2026-09-01T12:00:00.000Z", metadata: { note: "retained@example.invalid", padding: "x".repeat(32768) } };
  const purchaseHoldId = (await createPostgresPurchaseReservationPort(source.runtime).reserveOrderItems(purchaseHold)).reservations[0]!.reservationId;
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
  const retainedCancellation = { idempotencyKey: "retained-cancellation", orderId: cancelledOrder, reason: "retained@example.invalid" };
  expect(await createPostgresAbandonedCheckoutCompensationPort(source.runtime, () => "2026-09-01T12:00:00Z").cancelAbandonedOrder(retainedCancellation)).toEqual({ cancelled: true });
  const destinations = createPostgresDestinationPort(source.runtime);
  const retainedDestination: DestinationDocument = await destinations.registerOrder({ idempotencyKey: `destination-${graph.order}`, orderId: graph.order,
    address: { recipientName: "Synthetic personal recipient", line1: "Synthetic personal street", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: "2026-09-01T12:00:00Z" });
  await source.owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [admin]);
  const destinationCommand = { operator: admin, subscription: graph.subscription, key: `address-${graph.order}`,
    version: Number((await source.runtime.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows[0].template_version),
    payload: { newAddress: { recipientName: "Synthetic future recipient", line1: "Synthetic future street", city: "Fixture", postalCode: "00000", country: "ZZ" } } };
  await source.runtime.query("SELECT public.customer_support_change_shipping_destination($1,$2,$3,$4,$5,'2026-09-01T12:00:00Z')", [admin, graph.subscription, destinationCommand.payload, destinationCommand.version, destinationCommand.key]);
  const terminalNotices: { source: "event" | "reminder"; id: string }[] = [];
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
  // Keep all three preview shapes, including both acceptance foreign keys.
  const previewActor = randomUUID();
  const previewVersion = Number((await source.owner.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [graph.subscription])).rows[0].template_version);
  const recordPreview = async (hash: string) => (await source.runtime.query(
    "SELECT public.subscription_quote_preview_record($1,$2,$3,'update_package_template',$4,$5,$6,$7,$8,$9,$10) AS result",
    [previewActor, graph.client, graph.subscription, hash, previewVersion, "2026-11-06T12:00:00Z",
      { planDays: 28, nominalPlanDays: 28, compositionConstraint: { kind: "plan_days", value: 28 } },
      { baseLines: [], addonLines: [] }, { currentRecurringPrice: { amountMinor: 100, currency: "XXX" } },
      "2026-11-05T12:00:00Z"])).rows[0].result;
  const acceptedPreview = await recordPreview("c".repeat(64));
  const editEvent = (await source.owner.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
    VALUES($1,'subscription.customer_self_service.update_package_template','retained-package-edit','{"linePricing":[]}') RETURNING id`, [graph.subscription])).rows[0].id;
  await source.runtime.query("SELECT public.subscription_quote_preview_mark_accepted($1,'retained-package-key',$2,'2026-11-05T12:00:00Z')", [acceptedPreview.id, editEvent]);
  await recordPreview("d".repeat(64));
  const noopPreview = await recordPreview("e".repeat(64));
  // Seed the storage shape directly. The consent writer is outside this witness.
  await source.owner.query(`WITH receipt AS (
    INSERT INTO public.subscription_command_receipts
      (actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,result,status)
    VALUES ($1,'retained-package-noop',$2,$3,repeat('a',64),'{}','{}','noop')
    RETURNING id,idempotency_key
  )
  UPDATE public.subscription_quote_previews q
  SET status='accepted',accepted_at='2026-11-05T12:00:00Z',accepted_idempotency_key=receipt.idempotency_key,
    accepted_noop_receipt_id=receipt.id
  FROM receipt WHERE q.id=$4`, [previewActor, graph.subscription, graph.client, noopPreview.id]);
  // Capture the new event's delivery receipt as well, so later dispatcher replay
  // does not create a new obligation on an otherwise identical restored graph.
  await dispatchNotices(source);
  const historicalReferences = { pruned: (await fixture(source.owner)).shipment, retained: (await fixture(source.owner)).shipment };
  for (const shipment of Object.values(historicalReferences)) {
    await source.owner.query("UPDATE public.fulfillment_shipments SET status='handed_over',handed_over_at='2026-08-02T03:04:05.123456Z' WHERE id=$1", [shipment]);
    await source.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'tracking',$2,'2026-08-02T03:04:06.654321Z')", [shipment, `historical-tracking:${shipment}`]);
    await source.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'label',$2,'2026-08-02T03:04:06.654321Z')", [shipment, `historical-label:${shipment}`]);
  }
  await source.owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.shipment.dispatched' AND idempotency_key=$1", [`shipment_dispatched:${historicalReferences.pruned}`]);
  const packet = await capture(source.owner, "owned-existing-source");
  expect(packet.owned.find(entry => entry.table === "subscription_edit_quotes")!.rows).toHaveLength(1);
  return {
    packet,
    graph,
    successor,
    prunedHold,
    retainedHold,
    erased,
    historicalReferences,
    purchaseHold,
    purchaseHoldId,
    retainedErasure,
    retainedCancellation,
    identity,
    consent,
    payments,
    retainedDestination,
    destinationCommand,
    media,
    retainedRenewal,
    pendingRenewal,
    terminalNotices,
  };
}

export type RetainedTransferSeed = Awaited<ReturnType<typeof seedRetainedTransferStore>>;

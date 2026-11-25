import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import { applyDemoSeed, demonstrationMarker } from "../../examples/neutral-store/installation/install.ts";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { createPostgresPurchaseRenewalWriter } from "@openlup/platform/subscriptions";
import type { NativeCheckoutDraftRequest } from "@openlup/platform/commerce/server/native-checkout";
import { createAcquisitionFinancialPolicy } from "../../examples/neutral-store/owned/acquisition-policy.ts";
import { acquisitionFixture, configured } from "./acquisitionAdmissionFixture.js";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const suffix = "_catalog_order_checkout_protection.sql";
const pair = { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" };
const prefix = "catalog_price_setup_native_order_";
const claimRefusal = prefix + "claim_guard_unverified";
const guardRefusal = prefix + "guard_unverified";
const admissionRefusal = prefix + "admission_unverified";
const policyRefusal = prefix + "policy_pair_unverified";
const pgClock = `to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const fixturePolicy = createAcquisitionFinancialPolicy();
const settings = { dunningTemplateSlug: "example-failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "example-recovered" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const val = async (db: Pool | PoolClient, sql: string, args: unknown[] = []) =>
  (await db.query(sql, args)).rows[0]?.value;
const readiness = (db: Pool | PoolClient) => val(db, "SELECT public.commerce_offer_policy_v2_readiness() AS value");
const refuses = (work: Promise<unknown>, message: string = claimRefusal, code = "55000") =>
  expect(work).rejects.toMatchObject({ code, message });
const money = (amountMinor: number, currency = "XXX") => ({ amountMinor, currency });

let f: Awaited<ReturnType<typeof acquisitionFixture>>, read: Pool;

async function configure(owner: Pool, currency = "XXX") {
  await owner.query(`INSERT INTO public.commerce_settings(key,value_text)
    VALUES('settlement_region','ZZ'),('settlement_currency',$1)
    ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text`, [currency]);
  await owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
}
const v2 = (id: string, from: string, to: string | null = null) => ({
  ...configured(id), valid_from: from, valid_to: to, promotion_engine_version: "promotion-engine.v2",
  benefit_lane: "product", benefit_kind: "target_percentage", benefit_value_bps: 2400, benefit_value_minor: null, v2_mirror_of: null,
});
async function promotion(db: Pool | PoolClient, row: ReturnType<typeof v2>) {
  await db.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [row.id, row]);
  return row;
}
const clock = (db: Pool | PoolClient) => val(db, `SELECT ${pgClock} AS value`) as Promise<string>;
const fromYesterday = (db: Pool) => val(db, "SELECT to_char((statement_timestamp() AT TIME ZONE 'UTC')-interval '1 day','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS value") as Promise<string>;
const selector = (db: Pool | PoolClient, at: string) => val(db, "SELECT public.catalog_price_setup_acquisition_terms($1) AS value", [at]);

beforeAll(async () => {
  f = await acquisitionFixture();
  await configure(f.owner);
  read = await f.publication();

}, postgresSetupTimeoutMs);
afterAll(() => f?.close(), postgresTeardownTimeoutMs);
beforeEach(async () => {
  await f.owner.query(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '25 hours'
    WHERE created_at >= statement_timestamp()-interval '24 hours'`);
  await f.owner.query("UPDATE public.commerce_promotion_definitions SET active=false WHERE active");
});

interface PurchaseOptions {
  mode?: "subscription" | "one_time";
  discount?: string;
  extraDiscount?: string;
  threshold?: number;
  shipping?: number;
  terms?: Record<string, unknown>;
  legacy?: boolean;
  bound?: boolean;
  skipAcquisitionAdapter?: boolean;
  clientId?: string;
  useAcquisitionAdapter?: boolean;
  coSettle?: boolean;
}
async function startPurchase(store: typeof f, options: PurchaseOptions = {}) {
  const { mode = "one_time", threshold = 500, shipping = 0 } = options;
  const promotionIds = [options.discount, options.extraDiscount].filter(id => id !== undefined);
  const orderDiscount = 240 * promotionIds.length;
  const clientId = options.clientId ?? await store.client();
  const quote = (await store.request("unused", false)).quoteSnapshot.quote;
  quote.context = {
    mode, cadenceDays: mode === "subscription" ? 28 : null, promoCodes: [],
    pricingPolicy: options.legacy
      ? { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" } : pair,
    shippingTerms: { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 50, freeThresholdMinor: threshold },
    ...(options.terms && { acquisitionTerms: options.terms, acquisitionCapability: "subscription-acquisition.v1" }),
  };
  quote.discounts = promotionIds.map(promotionId => ({ promotionId, appliesTo: "order_total", amountOffMinor: 240, reasonCode: "example" }));
  quote.discountTotalGross = money(orderDiscount);
  quote.shippingGross = money(shipping);
  quote.netTotal = quote.totalGross = money(1000 - orderDiscount + shipping);
  const input: NativeCheckoutDraftRequest = { idempotencyKey: `purchase:${randomUUID()}`, quoteSnapshot: { contractVersion: "commerce.v0", quote } };
  const submit = { schemaVersion: 1, ownerNamespace: "example:checkout", clientId, lane: "example-checkout", requestKey: input.idempotencyKey,
    acceptanceTokenDigest: options.terms ? digest(input.idempotencyKey) : null, submitDigest: digest(clientId) };
  const session = await store.runtime.connect();
  let result;
  try {
    if (mode === "subscription" && (options.terms || options.useAcquisitionAdapter) && !options.skipAcquisitionAdapter) {
      const port = store.checkout.createPostgresAcquisitionCheckoutPersistence({
        async connect() {
          return {
            async query(sql, args) {
              if (sql === "COMMIT" && options.bound !== false) await session.query("SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)", [input.idempotencyKey,clientId,submit]);
              return session.query(sql, args);
            },
            release() {},
          };
        },
      }, { financialPolicy: fixturePolicy, regionCode: "ZZ", isAcquisitionDiscount: d => d.promotionId === options.discount });
      result = await port.createOrderDraft(input, { clientId });
    } else {
      await session.query("BEGIN");
      result = await store.checkout.createPostgresNativeCheckoutPersistence(session).createOrderDraft(input, { clientId });
      if (options.bound !== false) await session.query("SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)", [input.idempotencyKey,clientId,submit]);
      await session.query("COMMIT");
    }
  } catch (error) {
    await session.query("ROLLBACK");
    throw error;
  } finally { session.release(); }

  const id = result.orderDraft.orderId.slice(6);
  const at = await clock(store.runtime);
  if (mode === "subscription") {
    await store.runtime.query("SELECT public.subscription_declare_provisional_activation($1,$2,28,$3)", [`declare:${id}`,id,at]);
    await createPostgresDestinationPort(store.runtime).registerOrder({ orderId: id, idempotencyKey: `destination:${id}`, now: at,
      address: { recipientName: "Example Buyer", line1: "1 Example Lane", city: "Example", postalCode: "00000", country: "ZZ" } });
  }
  const intent = await val(store.runtime, "SELECT public.commerce_open_settlement_intent($1,$2,'sandbox',$3,'XXX','{}',$4) AS value",
    [`intent:${id}`,id,quote.totalGross.amountMinor,at]);
  const intentId = String(intent.settlement.id);
  const simulator = createPostgresSandboxPaymentSimulator(store.runtime, settings);
  if (options.coSettle) {
    const attempt = await simulator.beginAttempt({ settlementIntentId: intentId, idempotencyKey: `attempt:${id}`, requestFingerprint: digest(id), at });
    for (const outcome of ["indeterminate","captured"] as const) {
      const time = await clock(store.runtime);
      const observation = await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: `${id}:${outcome}`, outcome, occurredAt: time });
      expect((await simulator.ingress.receive({ headers: {}, receivedAt: time, rawBody: new TextEncoder().encode(JSON.stringify({
        settlementIntentId: intentId, attemptId: attempt.id, observationId: observation.id,
      })) })).status).toBe(200);
    }
  } else {
    expect((await captureSandboxPurchase(simulator, { settlementIntentId: intentId, key: id, at: await clock(store.runtime) })).status).toBe(200);
  }
  async function activate() {
    const line = quote.lines[0]!;
    const writer = createPostgresPurchaseRenewalWriter(store.runtime);
    await writer.register(id, { settlementChannelKey: "sandbox", authorizationRef: "example:authorization", unattendedChargeAuthorizedAt: at,
      payerAccountRef: "example:payer", methodRef: "example:method", methodEvidenceRef: "example:evidence", stockSourceKey: "example:stock",
      templateId: "example:template", cadenceDays: 28, currency: "XXX", lines: [{ lineOrdinal: 1, sku: line.sku, quantity: line.quantity, unitAmountMinor: 1000 }],
      shippingAmountMinor: shipping, acquisitionRef: options.discount ?? "example:acquisition",
      renewalTerms: { version: "native.renewal-terms.v1", linePricing: [{ sku: line.sku, quantity: line.quantity, unitAmountMinor: 1000, isAddon: false, quoteLine: { ...line } }] } });
    await store.runtime.query("SELECT public.subscription_activate_from_captured_payment_with_edit_window($1,$2,$3,72)",
      [`activate:${id}`,id,digest(intentId)]);
    await writer.complete(id);
  }
  return { id, intentId, clientId, input, submit, result, activate };
}
async function edit(work: (db: PoolClient) => Promise<void>) {
  const db = await f.owner.connect();
  try {
    await db.query("BEGIN");
    await work(db);
  } finally { await db.query("ROLLBACK"); db.release(); }
}
async function assertReadyOrder(db: Pool | PoolClient = read) {
  const result = await readiness(db);
  expect(result).toMatchObject({ contractVersion: "commerce-offer-policy-v2-readiness.v1", evidence: {
    automaticV2MoneyCheckedCount: 1, automaticV2MoneyMismatchCount: 0,
  } });
  return result;
}

it.each([
  ["charged shipping", { threshold: 1001, shipping: 50 }],
  ["the exact free threshold", { threshold: 1000 }],
  ["free shipping above the threshold", { threshold: 999 }],
] as const)("admits an undiscounted one-time order with %s", async (_label, options) => {
  await startPurchase(f, options);
  await assertReadyOrder();
});

it("admits a promoted order with compacted draft payload and co-settled truth", async () => {
  const row = await promotion(f.owner, v2("example:current", await fromYesterday(f.owner)));
  const order = await startPurchase(f, { discount: row.id, coSettle: true });
  const totals = await f.owner.query("SELECT count(*)::int AS n FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND state='settled'", [order.intentId]);
  expect(totals.rows[0].n).toBe(2);
  await f.owner.query("UPDATE public.outbox_events SET status='processed',processed_at=statement_timestamp() WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'", [order.id]);
  await f.owner.query("SELECT public.commerce_outbox_compact_terminal(500,statement_timestamp()+interval '31 days')");
  expect(await val(f.owner, "SELECT payload AS value FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'", [order.id])).toEqual({});
  await assertReadyOrder();
  for (const status of ["fulfillment_pending","fulfilled"]) {
    await f.owner.query("UPDATE public.commerce_orders SET status=$2 WHERE id=$1", [order.id,status]);
    await assertReadyOrder();
  }
});

it("rejects a zero-amount discount entry despite zero adjustments", async () => {
  const order = await startPurchase(f);
  const entries = [{ promotionId:"example:zero",appliesTo:"order_total",amountOffMinor:0,reasonCode:"example" }];
  expect(await val(f.owner,"SELECT count(*)::integer AS value FROM public.commerce_order_adjustments WHERE order_id=$1",[order.id])).toBe(0);
  await edit(async db => { await replaceSnapshot(db,order.id,["discounts"],entries); await evaluateEdited(db,guardRefusal); });
});

// The activation test is the revert-failing A1 proof. The standalone parity test checks selector agreement.
it("admits the captured subscription only after activation and sees only committed evidence", async () => {
  const row = await promotion(f.owner, v2("example:activation", await fromYesterday(f.owner)));
  const selected = f.pricing.selectAcquisitionTerms([row], await clock(f.owner), "ZZ", fixturePolicy)!;
  const order = await startPurchase(f, { mode: "subscription", discount: row.id, terms: { ...selected.terms } });
  await refuses(readiness(read));
  await order.activate();
  await assertReadyOrder();
  const peer = await f.owner.connect();
  const reader = await read.connect();
  try {
    await f.owner.query("UPDATE public.subscription_activations SET activated_at=activated_at-interval '1 microsecond' WHERE order_id=$1",[order.id]);
    await peer.query("BEGIN");
    await peer.query("UPDATE public.subscription_activations SET activated_at=(SELECT paid_at FROM public.commerce_orders WHERE id=$1) WHERE order_id=$1",[order.id]);
    await reader.query("SET statement_timeout='1s'");
    await refuses(readiness(reader));
    await peer.query("COMMIT");
    await assertReadyOrder(reader);
  } finally {
    try { await peer.query("ROLLBACK"); } finally {
      peer.release();
      try { await reader.query("RESET statement_timeout"); } finally { reader.release(); }
    }
  }
  await f.owner.query("UPDATE public.subscription_activations SET repaired=true WHERE order_id=$1", [order.id]);
  await assertReadyOrder();
});

const orderMutations = [
  ["receipt digest", "UPDATE public.commerce_order_draft_receipts SET request_fingerprint=repeat('f',32) WHERE order_id=$1"],
  ["receipt invalidation", "UPDATE public.commerce_order_draft_receipts SET invalidated_at=now(), invalidation_reason='order_cancelled' WHERE order_id=$1"],
  ["receipt timestamp", "UPDATE public.commerce_order_draft_receipts SET created_at=created_at-interval '1 second' WHERE order_id=$1"],
  ["receipt contract", "UPDATE public.commerce_order_draft_receipts SET response_payload=response_payload-'contractVersion' WHERE order_id=$1"],
  ["receipt response order", "UPDATE public.commerce_order_draft_receipts SET response_payload=response_payload #- '{orderDraft,orderId}' WHERE order_id=$1"],
  ["receipt replay flag", "UPDATE public.commerce_order_draft_receipts SET response_payload=jsonb_set(response_payload,'{orderDraft,replayed}','true') WHERE order_id=$1"],
  ["receipt request key", "UPDATE public.commerce_order_draft_receipts SET response_payload=jsonb_set(response_payload,'{orderDraft,idempotencyKey}','\"other-request\"') WHERE order_id=$1"],
  ["populated order receipt key", "UPDATE public.commerce_orders SET catalog_receipt_key='wrong-receipt-key' WHERE id=$1"],
  ["receipt quote", "UPDATE public.commerce_order_draft_receipts SET response_payload=response_payload #- '{orderDraft,quoteSnapshot}' WHERE order_id=$1"],
  ["duplicate receipt", `INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
    SELECT idempotency_key||':copy',request_fingerprint,order_id,response_payload FROM public.commerce_order_draft_receipts WHERE order_id=$1`],
  ["outbox key", "UPDATE public.outbox_events SET idempotency_key='wrong-draft-key' WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'"],
  ["outbox boundary", "UPDATE public.outbox_events SET metadata=metadata-'boundary' WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'"],
  ["outbox timestamp", "UPDATE public.outbox_events SET created_at=created_at-interval '1 second' WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'"],
  ["duplicate draft event", `INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    SELECT aggregate_type,aggregate_id,event_type,idempotency_key||':copy',payload,metadata FROM public.outbox_events
    WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'`],
  ["order money", "UPDATE public.commerce_orders SET total_amount_minor=total_amount_minor+1 WHERE id=$1"],
  ["provider channel", "UPDATE public.commerce_settlement_intents SET channel_key='example-provider' WHERE order_id=$1"],
  ["intent money", "UPDATE public.commerce_settlement_intents SET amount_minor=amount_minor+1 WHERE order_id=$1"],
  ["intent currency", "UPDATE public.commerce_settlement_intents SET currency_code='XTS' WHERE order_id=$1"],
  ["intent settlement instant", "UPDATE public.commerce_settlement_intents SET settled_at=settled_at-interval '1 second' WHERE order_id=$1"],
  ["shipping charge", "DELETE FROM public.commerce_order_adjustments WHERE order_id=$1 AND kind='shipping_charge'"],
  ["adjustment scope", "UPDATE public.commerce_order_adjustments SET scope='line' WHERE order_id=$1 AND kind='promotion_discount'"],
  ["adjustment amount", "UPDATE public.commerce_order_adjustments SET amount_minor=amount_minor+1 WHERE order_id=$1 AND kind='promotion_discount'"],
  ["adjustment fingerprint", "UPDATE public.commerce_order_adjustments SET definition_fingerprint=repeat('f',64) WHERE order_id=$1 AND kind='promotion_discount'"],
  ["claim promotion", "UPDATE public.commerce_promotion_claims SET promotion_id='example:other' WHERE order_id=$1"],
  ["claim client", "UPDATE public.commerce_promotion_claims SET client_id=NULL WHERE order_id=$1"],
  ["claim fingerprint", "UPDATE public.commerce_promotion_claims SET definition_fingerprint=repeat('f',64) WHERE order_id=$1"],
  ["claim amount", "UPDATE public.commerce_promotion_claims SET amount_off_minor=amount_off_minor+1 WHERE order_id=$1"],
  ["claim redemption time", "UPDATE public.commerce_promotion_claims SET redeemed_at=redeemed_at+interval '1 microsecond' WHERE order_id=$1"],
  ["claim reservation time", "UPDATE public.commerce_promotion_claims SET reserved_at=reserved_at-interval '1 microsecond' WHERE order_id=$1"],
  ["claim reservation event", `UPDATE public.commerce_promotion_claim_events SET occurred_at=occurred_at-interval '1 second'
    WHERE transition='reserved' AND claim_id IN (SELECT id FROM public.commerce_promotion_claims WHERE order_id=$1)`],
  ["claim redemption event", `DELETE FROM public.commerce_promotion_claim_events WHERE transition='redeemed'
    AND claim_id IN (SELECT id FROM public.commerce_promotion_claims WHERE order_id=$1)`],
  ["release followed by redemption", `INSERT INTO public.commerce_promotion_claim_events(claim_id,event_key,transition)
    SELECT id,'released:expired','released' FROM public.commerce_promotion_claims WHERE order_id=$1`],
  ["allocation fingerprint", "UPDATE public.commerce_order_items SET promotion_allocation_fingerprint=repeat('f',64) WHERE order_id=$1"],
  ["source line", "UPDATE public.commerce_order_items SET source_line_ordinal=source_line_ordinal+1 WHERE order_id=$1"],
  ["publication acceptance", "UPDATE public.commerce_orders SET catalog_acceptance='{}' WHERE id=$1"],
  ["renewal operation", "UPDATE public.commerce_orders SET renewal_operation_id=gen_random_uuid() WHERE id=$1"],
  ["recovery predecessor", "UPDATE public.commerce_orders SET recreated_from_order_id=gen_random_uuid() WHERE id=$1"],
  ["recovery root", "UPDATE public.commerce_orders SET recovery_root_order_id=gen_random_uuid() WHERE id=$1"],
  ["renewal marker", "UPDATE public.commerce_orders SET metadata=metadata||'{\"renewalOperationId\":\"example\"}' WHERE id=$1"],
  ["refund", "UPDATE public.commerce_orders SET status='refunded' WHERE id=$1"],
] as const;
const intentLookup = "(SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1)";
const captureMutations = [
  ["transition time", `UPDATE public.commerce_settlement_transitions SET occurred_at=occurred_at-interval '1 second' WHERE intent_id=${intentLookup}`],
  ["transition key", `UPDATE public.commerce_settlement_transitions SET idempotency_key=idempotency_key||':wrong' WHERE intent_id=${intentLookup}`],
  ["transition primary event", `UPDATE public.commerce_settlement_transitions SET payload=payload-'paymentTruthEventId' WHERE intent_id=${intentLookup}`],
  ["transition source evidence", `UPDATE public.commerce_settlement_transitions SET payload=payload-'sourceEvidence' WHERE intent_id=${intentLookup}`],
  ["attempt state", `UPDATE public.payment_simulator_attempts SET state='indeterminate' WHERE settlement_intent_id=${intentLookup}`],
  ["inactive attempt", `UPDATE public.payment_simulator_attempts SET is_active=false WHERE settlement_intent_id=${intentLookup}`],
  ["observation time", `UPDATE public.payment_simulator_observations SET occurred_at=occurred_at+interval '1 second'
    WHERE id IN (SELECT last_observation_id FROM public.payment_simulator_attempts WHERE settlement_intent_id=${intentLookup})`],
  ["observation fingerprint", `UPDATE public.payment_simulator_observations SET event_fingerprint=repeat('f',64)
    WHERE id IN (SELECT last_observation_id FROM public.payment_simulator_attempts WHERE settlement_intent_id=${intentLookup})`],
  ["truth source ID", `UPDATE public.payment_truth_events SET source_event_id=source_event_id||':wrong' WHERE settlement_intent_id=${intentLookup}`],
  ["truth ingress key", `UPDATE public.payment_truth_events SET ingest_idempotency_key=ingest_idempotency_key||':wrong' WHERE settlement_intent_id=${intentLookup}`],
  ["truth currency", `UPDATE public.payment_truth_events SET currency_code='XTS' WHERE settlement_intent_id=${intentLookup}`],
  ["truth money", `UPDATE public.payment_truth_events SET amount_minor=amount_minor+1 WHERE settlement_intent_id=${intentLookup}`],
  ["truth occurrence", `UPDATE public.payment_truth_events SET occurred_at=occurred_at-interval '1 second' WHERE settlement_intent_id=${intentLookup}`],
  ["truth settlement time", `UPDATE public.payment_truth_events SET settled_at=settled_at-interval '1 second' WHERE settlement_intent_id=${intentLookup}`],
  ["truth fingerprint", `UPDATE public.payment_truth_events SET event_fingerprint=repeat('e',64) WHERE settlement_intent_id=${intentLookup}`],
  ["truth source", `UPDATE public.payment_truth_events SET source_evidence=jsonb_set(source_evidence,'{sourceKind}','"reconciliation_read"')
    WHERE settlement_intent_id=${intentLookup}`],
  ["truth observation reference", `UPDATE public.payment_truth_events SET source_evidence=jsonb_set(source_evidence,'{sourceReference}','[]')
    WHERE settlement_intent_id=${intentLookup}`],
  ["truth observed time", `UPDATE public.payment_truth_events SET source_evidence=jsonb_set(source_evidence,'{observedAt}','"invalid-time"')
    WHERE settlement_intent_id=${intentLookup}`],
  ["truth attempt", `UPDATE public.payment_truth_events SET source_evidence=source_evidence-'attemptRef' WHERE settlement_intent_id=${intentLookup}`],
  ["truth observed status", `UPDATE public.payment_truth_events SET source_evidence=source_evidence-'observedStatus' WHERE settlement_intent_id=${intentLookup}`],
  ["review-required capture", `UPDATE public.payment_truth_events SET state='open', review_required_at=now(), settled_at=NULL,
    settlement_transition_id=NULL, accounting_document_id=NULL WHERE settlement_intent_id=${intentLookup}`],
  ["contradictory co-settlement", `UPDATE public.payment_truth_events SET amount_minor=amount_minor+1
    WHERE settlement_intent_id=${intentLookup} AND source_evidence->>'observedStatus'='indeterminate'`],
  ["extra primary capture", `INSERT INTO public.payment_truth_events(source_event_id,event_fingerprint,ingest_idempotency_key,
    settlement_intent_id,state,outcome,amount_minor,currency_code,source_evidence,settlement_transition_id,occurred_at,settled_at)
    SELECT source_event_id||':extra',event_fingerprint,ingest_idempotency_key||':extra',settlement_intent_id,
      state,outcome,amount_minor,currency_code,source_evidence,settlement_transition_id,occurred_at,settled_at
    FROM public.payment_truth_events WHERE settlement_intent_id=${intentLookup} AND source_evidence->>'observedStatus'='captured'`],
] as const;

async function evaluateEdited(db: PoolClient, message: string, code = "55000") {
  await db.query("SET LOCAL ROLE openlup_catalog_publication");
  await refuses(readiness(db),message,code);
}

it("rejects independent receipt, outbox, order, claim, allocation and capture defects", async () => {
  const row = await promotion(f.owner, v2("example:protection", await fromYesterday(f.owner)));
  const { id } = await startPurchase(f, { discount: row.id, coSettle: true, threshold: 900, shipping: 50 });
  await assertReadyOrder();
  for (const [name, sql] of [...orderMutations, ...captureMutations]) {
    await edit(async db => {
      await db.query("SET LOCAL session_replication_role='replica'");
      if (name === "duplicate receipt") await db.query("ALTER TABLE public.commerce_order_draft_receipts DROP CONSTRAINT commerce_order_draft_receipts_order_id_key");
      const mutated = await db.query(sql,[id]);
      expect(mutated.rowCount,name).toBeGreaterThan(0);
      await evaluateEdited(db,claimRefusal);
    });
  }
  await assertReadyOrder();
});

async function replaceSnapshot(db: PoolClient, id: string, path: string[], replacement: unknown, both = true) {
  await db.query("SET LOCAL session_replication_role='replica'");
  await db.query(`UPDATE public.commerce_orders SET metadata=jsonb_set(
    CASE WHEN $4 THEN jsonb_set(metadata, ARRAY['orderDraftSnapshot']||$2::text[], $3::jsonb) ELSE metadata END,
    ARRAY['quoteSnapshot','quote']||$2::text[], $3::jsonb) WHERE id=$1`, [id,path,JSON.stringify(replacement),both]);
  await db.query(`UPDATE public.commerce_order_draft_receipts r SET
    request_fingerprint=md5((o.metadata->'quoteSnapshot')::text||'|'||(o.metadata->'orderDraftSnapshot')::text||'|'||o.client_id::text),
    response_payload=jsonb_set(r.response_payload,'{orderDraft,quoteSnapshot}',o.metadata->'quoteSnapshot')
    FROM public.commerce_orders o WHERE r.order_id=o.id AND o.id=$1`,[id]);
}

it.each([
  { label: "shipping contradicts the free threshold", path: ["context","shippingTerms","freeThresholdMinor"], value: 2000, both: true },
  { label: "quote lines differ from draft", path: ["lines","0","productSlug"], value: "different-product", both: false },
  { label: "quote discounts differ from draft", path: ["discounts","0","reasonCode"], value: "different-reason", both: false },
  { label: "quote context differs from draft", path: ["context","promoCodes"], value: ["example"], both: false },
  ...["acquisitionTerms","starterPack","starterRenewalTerms","renewalTerms"].map(key => ({
    label: `one-time has ${key}`, path: ["context",key], value: {}, both: true,
  })),
])("refuses $label", async ({ path,value,both }) => {
  const discount = path[0] === "discounts"
    ? (await promotion(f.owner,v2("example:quote-discount",await fromYesterday(f.owner)))).id : undefined;
  const { id } = await startPurchase(f,{discount});
  await assertReadyOrder();
  await edit(async db => {
    await replaceSnapshot(db,id,path,value,both);
    await evaluateEdited(db,discount ? claimRefusal : guardRefusal);
  });
});

it.each([
  ["one-time submit has an acceptance digest", `UPDATE public.commerce_orders SET metadata=jsonb_set(
    metadata,'{catalogAdmissionSubmit,acceptanceTokenDigest}',to_jsonb(repeat('a',64))) WHERE id=$1`],
  ["one-time order has a subscription cycle", "UPDATE public.commerce_orders SET subscription_cycle_id=gen_random_uuid() WHERE id=$1"],
  ["undiscounted order has allocation columns", `UPDATE public.commerce_order_items SET
    source_line_ordinal=line_ordinal, catalog_unit_amount_minor=unit_amount_minor, catalog_line_amount_minor=line_amount_minor,
    promotion_discount_allocated_minor=0, promotion_allocation_fingerprint=repeat('a',64) WHERE order_id=$1`],
  ["duplicate succeeded settlement transition", `INSERT INTO public.commerce_settlement_transitions
    (intent_id,from_status,to_status,outcome,idempotency_key,payload,occurred_at)
    SELECT intent_id,from_status,to_status,outcome,idempotency_key||':copy',payload,occurred_at
    FROM public.commerce_settlement_transitions WHERE intent_id=${intentLookup} AND outcome='succeeded'`],
])("refuses %s", async (_label,sql) => {
  const { id } = await startPurchase(f);
  await assertReadyOrder();
  await edit(async db => {
    await db.query("SET LOCAL session_replication_role='replica'");
    expect((await db.query(sql,[id])).rowCount).toBe(1);
    await evaluateEdited(db,guardRefusal);
  });
});

it("refuses duplicate discount promotion IDs even when the counts and money agree", async () => {
  const from = await fromYesterday(f.owner);
  const first = await promotion(f.owner,v2("example:first-discount",from));
  const second = await promotion(f.owner,v2("example:second-discount",from));
  const { id } = await startPurchase(f,{ discount:first.id,extraDiscount:second.id });
  await assertReadyOrder();
  await edit(async db => {
    await replaceSnapshot(db,id,["discounts","1","promotionId"],first.id);
    // Keep the allocation bound to the edited draft so it cannot mask the duplicate.
    await db.query(`UPDATE public.commerce_order_items i SET promotion_allocation_fingerprint=encode(
      sha256(convert_to((o.metadata->'orderDraftSnapshot')::text||'|effective-line-allocation.v1','UTF8')),'hex')
      FROM public.commerce_orders o WHERE i.order_id=o.id AND o.id=$1`,[id]);
    await evaluateEdited(db,claimRefusal);
  });
});

it("checks malformed persisted JSON and preserves hard refusal precedence", async () => {
  const row = await promotion(f.owner, v2("example:json", await fromYesterday(f.owner)));
  const { id } = await startPurchase(f,{discount:row.id});
  await assertReadyOrder();
  const cases: [string[], unknown, string?][] = [
    [["lines"],{}], [["lines", "0", "quantity"],2147483648], [["lines", "0", "quantity"],1.5],
    [["lines", "0", "quantity"],"1"], [["lines", "0", "unitPriceGross", "amountMinor"],{}],
    [["discounts"],{}], [["discounts", "0", "appliesTo"],"line"], [["discounts", "0", "amountOffMinor"],0],
    [["context","shippingTerms","freeThresholdMinor"],"invalid"], [["context","mode"],"unknown"],
    [["context","pricingPolicy","offerPolicyVersion"],"unsupported",policyRefusal],
  ];
  for (const [path,value,reason] of cases) await edit(async db => {
    await replaceSnapshot(db,id,path,value);
    await evaluateEdited(db,reason ?? claimRefusal);
  });
});

it("propagates unrelated failures from the canonical money reader", async () => {
  await startPurchase(f);
  await edit(async db => {
    await db.query(`CREATE OR REPLACE FUNCTION public.catalog_price_setup_order_inputs(p_order_id uuid)
      RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog, pg_temp AS $$
      BEGIN RAISE EXCEPTION 'unrelated_order_reader_failure' USING ERRCODE='55000'; END; $$`);
    await evaluateEdited(db,"unrelated_order_reader_failure");
  });
});

it("uses the same SQL-valid standalone terms as the installed TypeScript selector", async () => {
  const from = await fromYesterday(f.owner);
  const end = (await clock(f.owner)).replace(/(\.\d{3})\d+Z$/u,"$1Z");
  const first = v2("example:earlier",from,end);
  const second = v2("example:later",end);
  second.applies_to_payload = { ...second.applies_to_payload, acquisitionTerms: {
    ...second.applies_to_payload.acquisitionTerms, revision: "example:later",
  } };
  await promotion(f.owner,first); await promotion(f.owner,second);
  const order = await startPurchase(f);
  const created = await val(f.owner,`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value
    FROM public.commerce_orders WHERE id=$1`,[order.id]);
  for (const at of [from,end,created]) {
    const ts = f.pricing.selectAcquisitionTerms([first,second],at,"ZZ",fixturePolicy)!;
    const { kind, legacyPairCount, standaloneCount, nextBoundaryAt, ...terms } = await selector(f.owner,at);
    expect({ kind, terms, nextBoundaryAt }).toEqual({ kind:ts.kind,terms:ts.terms,nextBoundaryAt:ts.nextBoundaryAt });
    expect([legacyPairCount,standaloneCount]).toEqual([0,1]);
  }
  const bad = [
    [v2("example:ambiguous",from), "acquisition_terms_ambiguous", "55000"],
    [{ ...v2("example:invalid",from), applies_to_payload: { ...first.applies_to_payload,
      acquisitionTerms: { ...first.applies_to_payload.acquisitionTerms, delivery2DiscountBps: -1 } } }, "acquisition_terms_invalid","22023"],
  ] as const;
  for (const [invalid,reason,code] of bad) await edit(async db => {
    await promotion(db,invalid);
    expect(() => f.pricing.selectAcquisitionTerms([first,second,invalid],end,"ZZ",fixturePolicy)).toThrow(reason);
    await refuses(selector(db,end),reason,code);
  });
  const tooEarly = new Date(Date.parse(from)-1000).toISOString();
  expect(() => f.pricing.selectAcquisitionTerms([first,second],tooEarly,"ZZ",fixturePolicy)).toThrow("acquisition_terms_not_effective");
  await refuses(selector(f.owner,tooEarly),"acquisition_terms_not_effective");
});

it("refuses acquisition changes independently after a real activation", async () => {
  const row = await promotion(f.owner,v2("example:source",await fromYesterday(f.owner)));
  const terms = f.pricing.selectAcquisitionTerms([row],await clock(f.owner),"ZZ",fixturePolicy)!.terms;
  const order = await startPurchase(f,{mode:"subscription",discount:row.id,terms:{...terms}});
  await order.activate();
  await assertReadyOrder();
  for (const key of Object.keys(terms)) await edit(async db => {
    await replaceSnapshot(db,order.id,["context","acquisitionTerms",key],"changed");
    await evaluateEdited(db,claimRefusal);
  });
  for (const [path,value,message] of [
    [["context","acquisitionTerms","extra"],true,claimRefusal],
    [["context","acquisitionCapability"],null,claimRefusal],
    [["context","pricingPolicy","promotionEngineVersion"],"promotion-engine.v1",policyRefusal],
  ] as const) await edit(async db => {
    await replaceSnapshot(db,order.id,[...path],value);
    await evaluateEdited(db,message);
  });
  for (const sql of [
    "UPDATE public.commerce_promotion_definitions SET definition=definition||'{\"name\":\"Edited\"}' WHERE promotion_id=$1",
    "UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id=$1",
  ]) await edit(async db => {
    await db.query(sql,[row.id]);
    await evaluateEdited(db,claimRefusal);
  });
  for (const sql of [
    "UPDATE public.subscription_activations SET client_id=gen_random_uuid() WHERE order_id=$1",
    "UPDATE public.commerce_orders SET subscription_cycle_id=NULL WHERE id=$1",
  ]) await edit(async db => {
    await db.query("SET LOCAL session_replication_role='replica'");
    await db.query(sql,[order.id]);
    await evaluateEdited(db,claimRefusal);
  });
});

it.each(["ambiguous","invalid","missing region"] as const)("refuses an activated acquisition with %s", async problem => {
  const from = await fromYesterday(f.owner);
  const source = await promotion(f.owner,v2(`example:active-acquisition-${problem.replace(" ","-")}`,from));
  const selected = f.pricing.selectAcquisitionTerms([source],await clock(f.owner),"ZZ",fixturePolicy)!;
  const order = await startPurchase(f,{ mode:"subscription",discount:source.id,terms:{...selected.terms} });
  await order.activate();
  await assertReadyOrder();
  await edit(async db => {
    if (problem === "missing region") {
      await db.query("DELETE FROM public.commerce_settings WHERE key='settlement_region'");
      // Call the order guard directly so the outer readiness region check cannot mask propagation here.
      await refuses(db.query("SELECT public.catalog_price_setup_assert_order_guards(statement_timestamp())"),
        "catalog_price_setup_settlement_context_unverified");
      return;
    }
    const extra = v2("example:conflicting-acquisition",from);
    if (problem === "invalid") extra.applies_to_payload.acquisitionTerms.delivery2DiscountBps = -1;
    await promotion(db,extra);
    await evaluateEdited(db,claimRefusal);
  });
});

it("retains hard guards for unbound, no-terms and legacy-pair purchases", async () => {
  const unbound = await startPurchase(f,{bound:false});
  await refuses(readiness(read),guardRefusal);
  await f.owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[unbound.id]);
  const available = await promotion(f.owner,v2("example:prior-offer",await fromYesterday(f.owner)));
  const initial = await startPurchase(f,{mode:"subscription",discount:available.id,
    terms:{...f.pricing.selectAcquisitionTerms([available],await clock(f.owner),"ZZ",fixturePolicy)!.terms}});
  await initial.activate();
  await f.owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[initial.id]);
  await f.owner.query("UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id=$1",[available.id]);
  const noTerms = await startPurchase(f,{mode:"subscription",clientId:initial.clientId,useAcquisitionAdapter:true});
  await refuses(readiness(read),guardRefusal);
  await f.owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[noTerms.id]);
  const legacyWithoutClaim = await startPurchase(f,{mode:"subscription",legacy:true});
  await refuses(readiness(read),admissionRefusal);
  await f.owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[legacyWithoutClaim.id]);
  const from = await fromYesterday(f.owner);
  const legacy = v2("example:legacy",from);
  const mirror = v2("example:mirror",from);
  const metadata = { schemaVersion:"subscription-acquisition.v1",revision:"legacy-50-35",delivery2DiscountBps:3500 };
  for (const definition of [
    { ...legacy, discount_value:44.404, promotion_engine_version:"promotion-engine.v1", benefit_kind:"percentage", benefit_value_bps:null },
    { ...mirror, discount_value:50, benefit_value_bps:5000, v2_mirror_of:legacy.id },
  ]) await f.owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)",
    [definition.id,{ ...definition, applies_to_payload:{cart_mode:"subscription",acquisitionTerms:metadata} }]);
  const selected = await selector(f.owner,await clock(f.owner));
  expect(selected.kind).toBe("legacy_pair");
  const terms = Object.fromEntries(Object.entries(selected)
    .filter(([key]) => !["kind","legacyPairCount","standaloneCount","nextBoundaryAt"].includes(key)));
  const order = await startPurchase(f,{ mode:"subscription", discount:mirror.id,terms,skipAcquisitionAdapter:true });
  await order.activate();
  await refuses(readiness(read));
});

it.each([[-86400000001,false],[-86400000000,true],[0,true],[1,false]])(
  "keeps the exact window decision for creation offset %s microseconds", async (offset, inside) => {
    await edit(async db => {
      const instant = await clock(db);
      await db.query("INSERT INTO public.commerce_orders(status,created_at,metadata) VALUES('paid',$1::timestamptz + $2*interval '1 microsecond','{}')",
        [instant,offset]);
      const checked = db.query("SELECT public.catalog_price_setup_assert_order_guards($1)",[instant]);
      if (inside) await refuses(checked,admissionRefusal);
      else await expect(checked).resolves.toBeDefined();
    });
  },
);

it("upgrades the existing evidence through the real runner", async () => {
  const old = await acquisitionFixture(suffix);
  try {
    await configure(old.owner);
    const readOld = await old.publication();
    const qualifying = await startPurchase(old);
    const incomplete = await startPurchase(old,{bound:false});
    // The full suffix also adds nullable order money markers outside this forward.
    const readEvidence = () => old.effects({ omitOrderMoneyMarkers: true });
    const evidence = await readEvidence();
    await refuses(readiness(readOld),guardRefusal);
    const forward = (await old.runner.status()).pending.find(file => file.endsWith(suffix));
    expect(forward).toBeDefined();
    expect((await old.runner.apply()).applied.slice(0,1)).toEqual([forward]);
    expect(await readEvidence()).toEqual(evidence);
    await refuses(readiness(readOld),guardRefusal);
    await old.owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[incomplete.id]);
    await assertReadyOrder(readOld);
    expect(qualifying.id).toBeDefined();
  } finally { await old.close(); }
}, postgresSetupTimeoutMs);

it("passes readiness for a starter purchase strictly above the free-shipping threshold", async () => {
  const starter = await acquisitionFixture(undefined,"starter_runtime");
  try {
    const config = structuredClone(Object.values(configurations)[0]!);
    await starter.owner.query("DELETE FROM public.price_entries WHERE price_list_id=$1",[starter.list]);
    await starter.owner.query("DELETE FROM public.catalog_skus WHERE id=$1",[starter.product]);
    await starter.owner.query(`COMMENT ON DATABASE "${starter.database}" IS '${demonstrationMarker}'`);
    await applyDemoSeed(config, { connection: starter.owner, installRole:"postgres", runtimeRole:"starter_runtime",
      stock: createPostgresFulfillmentStockSyncPort(starter.runtime, {
        sourceKey:`starter-demo:${config.id}`,readLocalInventoryStock:async () => [],
      }), close:async () => {} });
    await configure(starter.owner,config.market.currency);
    const reader = await starter.publication();
    const host = new URL("../../examples/neutral-store/host/", import.meta.url);
    const driver = `
      import {createHash,randomUUID} from "node:crypto";
      import {readFileSync} from "node:fs";
      import {createPostgresAccountLinkStore} from "@openlup/platform/identity";
      import {composeNativeBindings} from ${JSON.stringify(new URL("native-composition.ts",host).href)};
      import {createOriginPolicy} from ${JSON.stringify(new URL("origin-policy.ts",host).href)};
      const {url,config} = JSON.parse(readFileSync(0,"utf8"));
      const accounts = createPostgresAccountLinkStore({connectionString:url});
      const bindings = await composeNativeBindings(url,createOriginPolicy(config,3210),config,
        {current:"example-acquisition-test-material-000000000000000"});
      try {
        const principalRef = randomUUID();
        const client = await accounts.createAccount({email:principalRef+"@example.invalid",principalId:principalRef,
          acquisitionSource:"example",lifecycleStage:"customer"});
        const actor = {customerRef:client.id,principalRef,operatorRef:null,
          requesterKey:createHash("sha256").update(principalRef).digest("hex"),requestOrigin:"http://127.0.0.1:3210"};
        const call = async (action,payload) => {
          const result = await bindings.actions[action](payload,{config,actor,commandKey:randomUUID()});
          if (!result.ok) throw new Error(action+" refused: "+result.code);
          return result.value;
        };
        const submit = {acquisitionCapability:"subscription-acquisition.v1",locale:"en",configuration:config.id,country:config.market.country,
          termsRevision:config.legal.revision,termsAccepted:true,firstName:"Example",lastName:"Buyer",phone:"000000000",
          line1:"1 Example Lane",city:"Example",postalCode:"00000",
          cart:{schemaVersion:1,configuration:config.id,mode:"one_time",cadenceDays:null,
            lines:[{sku:config.offer.products[0].sku,quantity:1}]}};
        const reviewed = await call("offer.validate",submit);
        const {orderRef} = await call("checkout.create",{...submit,expectedTotal:reviewed.expectedTotal});
        await call("payment.simulate",{orderRef,outcome:"captured"});
        process.stdout.write(orderRef);
      } finally { await bindings.close(); await accounts.close(); }
    `;
    const id = execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",driver],{
      cwd:starter.consumer,input:JSON.stringify({url:starter.runtimeUrl,config}),encoding:"utf8",timeout:20_000,
    }).trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    const quote = await val(starter.owner,"SELECT metadata#>'{quoteSnapshot,quote}' AS value FROM public.commerce_orders WHERE id=$1",[id]);
    expect(quote.subtotalGross.amountMinor).toBeGreaterThan(config.offer.freeShippingFromMinor);
    expect(quote.discounts).toEqual([]);
    expect(quote.shippingGross.amountMinor).toBe(0);
    expect(await val(starter.owner,"SELECT count(*)::integer AS value FROM public.commerce_order_adjustments WHERE order_id=$1",[id])).toBe(0);
    await assertReadyOrder(reader);
  } finally { await starter.close(); }
}, postgresSetupTimeoutMs);

it("rolls back a written draft and replays a completed bound draft without appending evidence", async () => {
  const order = await startPurchase(f);
  const before = await f.effects();
  const replay = await val(f.runtime,"SELECT public.catalog_admission_replay_order_draft($1,$2,$3,$4) AS value",
    [order.input.idempotencyKey,order.clientId,order.submit.lane,order.submit.submitDigest]);
  expect(replay).toEqual({ ...order.result,orderDraft:{...order.result.orderDraft,replayed:true} });
  const witness = await f.runtime.connect();
  try {
    await witness.query("BEGIN");
    const input = {...order.input,idempotencyKey:`purchase:${randomUUID()}`};
    const result = await f.checkout.createPostgresNativeCheckoutPersistence(witness).createOrderDraft(input,{clientId:order.clientId});
    expect(result.orderDraft.replayed).toBe(false);
    await witness.query("SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)",
      [input.idempotencyKey,order.clientId,{ ...order.submit,requestKey:input.idempotencyKey }]);
    await witness.query("ROLLBACK");
  } finally { witness.release(); }
  expect(await f.effects()).toEqual(before);
  await assertReadyOrder();
});

import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresProviderPaymentRail, createPostgresPaymentMethodStore, createPostgresPaymentMethodSetup,
  createPostgresPaymentWebhookControlPort } from "@openlup/platform/payments";
import { createStripePaymentAdapter, type StripePaymentAdapterConfig } from "@openlup/platform/payments/stripe";
import { createScriptedPaymentFake } from "@openlup/platform/payments/testing";
import { activateNativePurchaseWithRenewal, createNativeRenewalCodec, createNativeSubscriptionBinding,
  createPostgresProviderRenewalBinding, createPostgresRenewalSettlementPort,
  createPostgresRetryStore, type SubscriptionQueryExecutor, type AutomaticRenewalPolicy } from "@openlup/platform/subscriptions";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { lifecycleInstallation, call, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { renewal as renewalFixture } from "./subscriptionNativeFixture.js";

type ProviderIntent = Awaited<ReturnType<StripePaymentAdapterConfig["client"]["retrievePaymentIntent"]>>;
const AT = "2026-09-01T12:00:00.000Z", firstDue = "2026-09-29T12:01:00.000Z", secondDue = "2026-10-27T12:01:00.000Z";
const truth = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
const secret = "synthetic-signature", clientId = randomUUID(), principal = randomUUID(), sku = randomUUID(), source = `stock:${randomUUID()}`;
let env: LifecycleInstallation, orderId: string, intentId: string, subscriptionId: string, time = AT;
let currentMethod = "pm_primary", declined = false, remote: ProviderIntent;
const fake = createScriptedPaymentFake<{ create: ProviderIntent; read: ProviderIntent; setup: ProviderIntent; customer: string }>();
let rail: ReturnType<typeof createPostgresProviderPaymentRail>, renewal: ReturnType<typeof createPostgresProviderRenewalBinding>;
let binding: ReturnType<typeof createNativeSubscriptionBinding>;
const codec = createNativeRenewalCodec();
const requests: Record<string, unknown>[] = [];
const transaction = async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => {
  const db = await env.runtime.connect();
  try { await db.query("BEGIN"); const value = await work(db); await db.query("COMMIT"); return value; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
};
const payment = (id: string, status: string): ProviderIntent => ({ id, status, amount: 200,
  currency: "xxx", customer: "cus_primary", payment_method: currentMethod, client_secret: "transient_only",
  latest_charge: `ch_${id}` });
beforeAll(async () => {
  env = await lifecycleInstallation("qualified-v2");
  await env.owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,'synthetic@example.invalid',$2)", [clientId, principal]);
  await env.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [sku, sku]);
  await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Example',true)", [sku, sku]);
  await env.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Example','AA','XXX','2026-01-01')", [sku]);
  await env.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$1,'any',100,'2026-01-01')", [sku]);
  await env.owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
    inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES($1,$2,100,100,0,'sellable',$3,greatest(now(),$3::timestamptz)+interval '1 year','fixture',$2,$4)`, [source, sku, AT, "a".repeat(64)]);
  const quote = { context: { mode: "subscription", cadenceDays: 28 }, lines: [{ sku, quantity: 2,
    unitPriceGross: { amountMinor: 100, currency: "XXX" }, lineSubtotalGross: { amountMinor: 200, currency: "XXX" } }], totalGross: { amountMinor: 200, currency: "XXX" } };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", context: quote.context, lines: quote.lines, totals: { totalGross: quote.totalGross } };
  const made = await call(env.runtime, "commerce_create_order_draft_with_outbox", [`purchase:${sku}`, { quote }, draft, clientId]);
  orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  await createPostgresDestinationPort(env.runtime).registerOrder({ idempotencyKey: `destination:${orderId}`, orderId,
    address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Example", postalCode: "00000", country: "ZZ" }, now: AT });
  await call(env.runtime, "subscription_declare_provisional_activation", [`declare:${orderId}`, orderId, 28, AT]);
  const adapter = createStripePaymentAdapter({ client: {
    async createPaymentIntent(input, options) {
      requests.push({ ...input, key: options.idempotencyKey });
      // Independent owner connection observes committed prepare at dispatch.
      expect((await env.owner.query("SELECT count(*)::int n FROM public.payment_provider_attempts WHERE settlement_intent_id=$1 AND status='created'", [input.metadata.paymentIntentId])).rows[0].n).toBe(1);
      if (declined) throw { type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds",
        payment_intent: { id: "pi_declined_diagnostic", status: "requires_payment_method" } };
      return fake.invoke("create");
    },
    retrievePaymentIntent: () => fake.invoke("read"), createSetupIntent: () => fake.invoke("setup"),
    ensureCustomer: () => fake.invoke("customer"),
  }, mode: "test", supportedCurrencies: ["XXX"], webhookSigningSecrets: [secret], clock: () => Math.floor(Date.parse(time) / 1000) });
  rail = createPostgresProviderPaymentRail({ executor: env.runtime, adapter, mode: "test", truth,
    composeWebhook: (event, control) => renewal ? renewal.composeWebhook(event, control) : control,
    resolveSavedMethodOwner: async () => ({ clientId }), resolveMethodOwner: async () => ({ clientId, subscriptionId }) });
  intentId = (await rail.control.createIntent({ idempotencyKey: `purchase-intent:${orderId}`, targetKind: "one_time_order", orderId,
    amountMinor: 200, currency: "XXX", channelKey: rail.provider, metadata: {}, at: AT })).id;
  renewal = createPostgresProviderRenewalBinding({ enabled: true, channelKey: rail.provider, executor: env.runtime,
    withTransaction: transaction, codec, paymentRail: rail, truth, now: () => time,
    settlement: db => createPostgresRenewalSettlementPort(db, codec, transaction), search: async () => [] });
}, postgresSetupTimeoutMs);
afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);
function signed(type: string, object: Record<string, unknown>, id = `evt_${randomUUID()}`, created: number | null = Math.floor(Date.parse(time) / 1000)) {
  const rawBody = Buffer.from(JSON.stringify({ id, type, livemode: false, ...(created === null ? {} : { created }), data: { object } }));
  const stamp = Math.floor(Date.parse(time) / 1000), digest = createHmac("sha256", secret).update(`${stamp}.${rawBody.toString()}`).digest("hex");
  return { rawBody, headers: { "stripe-signature": `t=${stamp},v1=${digest}` }, receivedAt: time };
}
function executionRequest() {
  return { attemptRef: `purchase-attempt:${orderId}`, intentRef: intentId, fingerprint: "f".repeat(64),
    providerIdempotencyKey: `purchase-provider:${orderId}`, money: { amountMinor: 200, currency: "XXX" }, mode: "test" as const,
    purpose: "initial" as const, orderMode: "subscription_cycle" as const, orderRef: orderId, clientId, customerRef: "cus_primary", saveForFutureUse: true };
}
function policy(): AutomaticRenewalPolicy {
  return { identityKey: due => `subscription:${due.subscriptionId}:cycle:${new Date(due.scheduledAt).toISOString()}`, classifyFailure: () => "soft_retryable", validateInput() {},
    executionInput(_due, operation, prepared) {
      const frozen = operation.cycleSnapshot;
      return { cycleIdempotencyKey: operation.identityKey, executionIdempotencyKey: `${operation.identityKey}:initial`,
        externalIdempotencyKey: `${operation.identityKey}:provider`, requestFingerprint: operation.operationFingerprint,
        paymentIntentId: prepared.settlementIntentId, orderRef: prepared.orderId, orderId: prepared.orderId,
        amountMinor: frozen.pricingSnapshot.totalAmountMinor, currency: frozen.pricingSnapshot.currency, mode: "subscription", flow: "off_session",
        customerRef: "cus_primary", paymentMethodRef: currentMethod, recurringModel: null, clientId, payer: null };
    } };
}
it("prepares a purchase before dispatch and preserves order, client, customer and save-card facts", async () => {
  remote = payment("pi_purchase", "requires_payment_method"); fake.enqueue("create", { kind: "success", value: remote });
  const result = await rail.execute(executionRequest());
  expect(result.execution.handoff).toMatchObject({ kind: "client-confirmed", payload: "transient_only" });
  expect(requests[0]).toMatchObject({ customer: "cus_primary", setupFutureUsage: "off_session", key: executionRequest().providerIdempotencyKey,
    metadata: { orderRef: orderId, clientId, paymentIntentId: intentId, mode: "subscription_cycle" } });
  const a = await rail.readAttempt(intentId);
  expect(a).toMatchObject({ requestPayload: { orderRef: orderId, clientId, customerRef: "cus_primary", saveForFutureUse: true } });
  expect(JSON.stringify(a)).not.toContain("transient_only");
  await expect(rail.execute(executionRequest())).rejects.toThrow("provider_attempt_in_flight");
  expect(requests).toHaveLength(1);
});

it("captures signed evidence, records the saved method, then attaches the paid purchase to renewal", async () => {
  const invalid = signed("payment_intent.succeeded", {}); invalid.headers["stripe-signature"] += "invalid";
  expect((await rail.ingress.receive(invalid)).status).toBe(400);
  const capture = signed("payment_intent.succeeded", { ...remote, status: "succeeded", amount_received: 200, setup_future_usage: "off_session",
    metadata: { paymentIntentId: intentId, clientId, mode: "subscription_cycle" } });
  expect(await rail.ingress.receive(capture)).toMatchObject({ status: 200 });
  expect(await rail.ingress.receive(capture)).toMatchObject({ status: 200, data: { replayed: true } });
  const method = await createPostgresPaymentMethodStore(env.runtime).read(rail.provider, currentMethod);
  expect(method).toMatchObject({ client_id: clientId, active: true, provider_customer_ref: "cus_primary", consent_snapshot: { checkoutMode: "subscription_cycle" } });
  const active = await activateNativePurchaseWithRenewal(env.runtime, { orderId, capturedReference: intentId,
    idempotencyKey: `activate:${orderId}`, facts: { settlementChannelKey: rail.provider, authorizationRef: "purchase-consent",
      unattendedChargeAuthorizedAt: AT, payerAccountRef: "cus_primary", methodRef: currentMethod, methodEvidenceRef: method!.id,
      stockSourceKey: source, templateId: "refill", cadenceDays: 28, currency: "XXX", lines: [{ lineOrdinal: 1, sku, quantity: 2, unitAmountMinor: 100 }],
      shippingAmountMinor: 0, acquisitionRef: null } });
  expect(active.renewalAttachment).toBe("complete"); subscriptionId = String(active.activation.subscriptionId);
  expect(await createPostgresPaymentMethodStore(env.runtime).read(rail.provider, currentMethod)).toMatchObject({ subscription_id: subscriptionId });
});
it("runs an off-session saved-method renewal through the installed runtime role", async () => {
  time = firstDue;
  remote = payment("pi_renewal", "succeeded"); fake.enqueue("create", { kind: "success", value: remote }); fake.enqueue("read", { kind: "success", value: remote });
  const p = policy();
  binding = createNativeSubscriptionBinding({ enabled: true, population: "synthetic", executor: env.runtime, withTransaction: transaction,
    withRunLease: async (_population, work) => work(), codec, settlement: db => createPostgresRenewalSettlementPort(db, codec, transaction),
    inventory: createPostgresRenewalReservationPort(env.runtime), paymentRails: renewal.paymentRails, providerLifecycle: renewal.lifecycle, policy: p,
    retry: { readFrozenMandate: async snapshot => ({ authorized: true, authorizationRef: snapshot.authorizationRef, paymentMethodRef: currentMethod }),
      retryInput: (snapshot, row) => ({ ...p.executionInput(snapshot as never, { identityKey: row.identityKey, operationFingerprint: row.requestFingerprint,
        cycleSnapshot: snapshot } as never, { orderId: row.orderId, settlementIntentId: row.settlementIntentId }),
      executionIdempotencyKey: `${row.identityKey}:retry:${row.retryAttempt}`, externalIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}` }),
      payments: renewal.retryPayments, recoveredTemplate: truth.recoveryTemplateSlug },
    failureTemplate: truth.dunningTemplateSlug, recoveryPath: truth.recoveryUrlPath, workerId: "portable", now: () => time,
    catalogue: { version: "fixture", migration: "fixture" }, readiness: async () => ({ state: "ready", candidate: { artifact: "fixture", configuration: "fixture", environment: "fixture", database: "fixture", schema: "fixture" }, loadedPackages: [], issues: [] }) });
  expect(binding.services.capabilities.preparedAttemptStore).toEqual({ supported: true });
  expect(await binding.services.run()).toMatchObject({ renewals: [{ status: "awaiting_provider" }] });
  const prepared = (await env.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE renewal_operation_id IN (SELECT id FROM public.subscription_renewal_operations WHERE subscription_id=$1)", [subscriptionId])).rows[0];
  expect(await rail.ingress.receive(signed("payment_intent.succeeded", { ...remote, amount_received: 200,
    metadata: { paymentIntentId: prepared.id, clientId, subscriptionId } }))).toMatchObject({ status: 200 });
  expect(requests.at(-1)).toMatchObject({ customer: "cus_primary", paymentMethod: "pm_primary", offSession: true });
  expect((await env.owner.query("SELECT state,terminal_outcome FROM public.subscription_renewal_operations WHERE subscription_id=$1", [subscriptionId])).rows)
    .toEqual([{ state: "succeeded", terminal_outcome: "succeeded" }]);
});
it("attributes a synchronous decline to one rung and one dunning case", async () => {
  time = secondDue; declined = true;
  expect(await binding.services.run()).toMatchObject({ renewals: [{ status: "refused" }] });
  const rows = (await env.owner.query("SELECT retry_attempt,case_id FROM public.subscription_retry_obligations WHERE subscription_id=$1", [subscriptionId])).rows;
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ retry_attempt: 1, case_id: expect.any(String) });
  expect((await env.owner.query("SELECT count(*)::int n FROM public.payment_dunning_case_attribution WHERE case_id=$1", [rows[0].case_id])).rows[0].n).toBe(1);
});
it("registers a SetupIntent replacement before scheduling the recovery retry", async () => {
  declined = false; currentMethod = "pm_replacement"; time = "2026-10-27T12:10:00.000Z";
  const lane = createPostgresPaymentMethodSetup(env.runtime, { enabled: () => true, methodPort: rail.adapter.methodPort!,
    ensureCustomer: async () => { throw new Error("recorded_customer_required"); } });
  const calls = fake.calls.length;
  expect(await lane.execute(randomUUID(), { subscriptionId, idempotencyKey: "replace-card" })).toMatchObject({ kind: "forbidden" });
  expect(fake.calls).toHaveLength(calls);
  fake.enqueue("setup", { kind: "success", value: { id: "seti_replacement", status: "requires_confirmation", client_secret: "transient_only" } });
  expect(await lane.execute(principal, { subscriptionId, idempotencyKey: "replace-card" })).toMatchObject({ kind: "ready", setupRef: "seti_replacement" });
  const setup = signed("setup_intent.succeeded", { id: "seti_replacement", status: "succeeded", customer: "cus_primary", payment_method: currentMethod,
    metadata: { clientId, subscriptionId } });
  expect(await rail.ingress.receive(setup)).toMatchObject({ status: 200 });
  expect(await createPostgresPaymentMethodStore(env.runtime).read(rail.provider, currentMethod)).toMatchObject({ active: true, subscription_id: subscriptionId });
  const obligation = (await env.owner.query("SELECT renewal_operation_id FROM public.subscription_retry_obligations WHERE subscription_id=$1", [subscriptionId])).rows[0];
  expect(await createPostgresRetryStore(env.runtime).read(obligation.renewal_operation_id)).toMatchObject({ retryAttempt: 1, nextRetryAt: expect.any(String) });
  const scheduled = (await createPostgresRetryStore(env.runtime).read(obligation.renewal_operation_id))!.nextRetryAt!;
  time = new Date(Date.parse(scheduled) + 1000).toISOString();
});
it("recovers with the recorded replacement and retains committed accepted-event evidence", async () => {
  remote = payment("pi_recovery", "succeeded"); fake.enqueue("create", { kind: "success", value: remote }); fake.enqueue("read", { kind: "success", value: remote });
  expect(await binding.services.run()).toMatchObject({ retries: [{ status: "awaiting_provider" }] });
  const dispatch = (await env.owner.query(`SELECT r.input FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id
    WHERE o.subscription_id=$1 AND r.kind='prepare' ORDER BY r.attempt_sequence DESC LIMIT 1`, [subscriptionId])).rows[0].input;
  expect(requests.at(-1)).toMatchObject({ paymentMethod: "pm_replacement", key: dispatch.providerIdempotencyKey });
  const intent = (await env.owner.query("SELECT settlement_intent_id FROM public.subscription_retry_obligations WHERE subscription_id=$1", [subscriptionId])).rows[0].settlement_intent_id;
  const event = signed("payment_intent.succeeded", { ...remote, amount_received: 200,
    metadata: { paymentIntentId: intent, clientId, subscriptionId } });
  const interrupted = createPostgresProviderPaymentRail({ executor: env.runtime, adapter: rail.adapter, mode: rail.mode, truth,
    resolveMethodOwner: async () => null, resolveSavedMethodOwner: async () => null,
    composeWebhook: (_event, control) => ({ ...control, async applyPaymentResult() { throw new Error("synthetic_application_interruption"); } }) });
  expect(await interrupted.ingress.receive(event)).toMatchObject({ status: 503 });
  expect(await rail.ingress.receive({ ...event, receivedAt: new Date(Date.parse(event.receivedAt) + 60_000).toISOString() })).toMatchObject({ status: 200 });
  expect((await env.owner.query("SELECT state FROM public.subscription_retry_obligations WHERE subscription_id=$1", [subscriptionId])).rows).toEqual([{ state: "recovered" }]);
  expect((await env.owner.query(`SELECT r.input->>'evidenceKey' AS evidence FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.subscription_id=$1 AND r.kind='recovery'`, [subscriptionId])).rows[0].evidence)
    .toMatch(/^provider:[a-f0-9-]{36}$/);
  const receipt = (await env.owner.query(`SELECT r.input FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.subscription_id=$1 AND r.kind='recovery'`, [subscriptionId])).rows[0].input;
  const evidence = (await env.owner.query(`SELECT payload,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
    FROM public.payment_provider_attempt_evidence WHERE provider_event_id=$1`, [JSON.parse(event.rawBody.toString()).id])).rows[0];
  expect(receipt.firstRecordedAt).toBe(evidence.recorded_at);
  expect(evidence.payload.openlupReceipt.receivedAt).toBe(event.receivedAt);
  expect(Date.parse(receipt.occurredAt)).toBe(Math.floor(Date.parse(time) / 1000) * 1000);
  expect((await env.owner.query("SELECT status FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows).toEqual([{ status: "active" }]);
  fake.assertDrained();
});

it("observes a cumulative partial refund without cancelling or pausing service", async () => {
  const intent = (await env.owner.query("SELECT settlement_intent_id FROM public.subscription_retry_obligations WHERE subscription_id=$1", [subscriptionId])).rows[0].settlement_intent_id;
  const result = await rail.ingress.receive(signed("charge.refunded", { id: "ch_recovery", payment_intent: "pi_recovery", amount: 200,
    amount_refunded: 60, currency: "xxx", metadata: { paymentIntentId: intent } }));
  expect(result.status).toBe(200);
  expect(await call(env.runtime, "payment_refund_readback", [intent])).toMatchObject({ refundCents: 60 });
  expect((await env.owner.query("SELECT status FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows).toEqual([{ status: "active" }]);
});
it("takes the maximum cumulative refund and emits one evidence-gated financial notice", async () => {
  const intent = (await env.owner.query("SELECT settlement_intent_id,order_id FROM public.subscription_retry_obligations WHERE subscription_id=$1", [subscriptionId])).rows[0];
  const event = signed("charge.refunded", { id: "ch_recovery", payment_intent: "pi_recovery", amount: 200,
    amount_refunded: 200, currency: "xxx", metadata: { paymentIntentId: intent.settlement_intent_id } });
  expect((await rail.ingress.receive(event)).status).toBe(200);
  expect((await rail.ingress.receive(event)).status).toBe(200);
  expect(await call(env.runtime, "payment_refund_readback", [intent.settlement_intent_id])).toMatchObject({ refundCents: 200 });
  expect((await rail.ingress.receive(signed("charge.refunded", { id: "ch_recovery", payment_intent: "pi_recovery", amount: 200,
    amount_refunded: 200, currency: "xxx", metadata: { paymentIntentId: intent.settlement_intent_id } }))).status).toBe(200);
  expect((await env.owner.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.refund_processed'", [intent.order_id])).rows[0].n).toBe(1);
  expect((await env.owner.query("SELECT status FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows).toEqual([{ status: "active" }]);
});

describe("durable dispatch boundaries", () => {
  let intent: string, order: string;
  beforeEach(async () => {
    order = randomUUID();
    await env.owner.query(`WITH made AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor)
      VALUES($1,$2,'pending_payment','XXX',200) RETURNING id)
      INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      SELECT id,$3,1,2,100,200 FROM made`, [order, clientId, sku]);
    intent = (await rail.control.createIntent({ idempotencyKey: `intent:${order}`, targetKind: "one_time_order", orderId: order,
      amountMinor: 200, currency: "XXX", metadata: {}, channelKey: rail.provider, at: time })).id;
  });
  const request = () => ({ ...executionRequest(), attemptRef: `attempt:${intent}`, intentRef: intent, orderRef: order,
    providerIdempotencyKey: `provider:${intent}`, saveForFutureUse: false, orderMode: "one_time" as const });
  it("retains uncertainty after a lost provider reply and never dispatches on restart", async () => {
    fake.enqueue("create", { kind: "timeout-after-dispatch" });
    await expect(rail.execute(request())).rejects.toThrow("timeout-after-dispatch");
    const before = await rail.readAttempt(intent), calls = requests.length;
    const restarted = createPostgresProviderPaymentRail({ executor: env.runtime, adapter: rail.adapter, mode: rail.mode, truth,
      resolveMethodOwner: async () => null, resolveSavedMethodOwner: async () => null });
    await expect(restarted.execute(request())).rejects.toThrow("provider_attempt_in_flight");
    await expect(restarted.execute({ ...request(), attemptRef: `other:${intent}` })).rejects.toThrow("provider_attempt_in_flight");
    expect(await rail.readAttempt(intent)).toEqual(before); expect(requests).toHaveLength(calls);
    await expect(restarted.execute({ ...request(), customerRef: "changed" })).rejects.toThrow("payment_control_provider_attempt_prepare_idempotency_conflict");
  });
  it("keeps a committed prepare after finalization fails and excludes transient response bytes", async () => {
    const broken = createPostgresProviderPaymentRail({ executor: { query(sql, values) {
      if (sql.includes("payment_provider_attempt_finalize")) throw new Error("synthetic_finalize_failure");
      return env.runtime.query(sql, values);
    } }, adapter: rail.adapter, mode: rail.mode, truth, resolveMethodOwner: async () => null, resolveSavedMethodOwner: async () => null });
    fake.enqueue("create", { kind: "success", value: payment(`pi_${intent}`, "requires_action") });
    await expect(broken.execute(request())).rejects.toThrow("synthetic_finalize_failure");
    expect(await rail.readAttempt(intent)).toMatchObject({ paymentAttempt: { status: "created", providerAttemptId: null } });
    expect(JSON.stringify(await rail.readAttempt(intent))).not.toContain("transient_only");
    const calls = requests.length; await expect(rail.execute(request())).rejects.toThrow("provider_attempt_in_flight"); expect(requests).toHaveLength(calls);
  });
  it("retains missing provider time without applying capture or inventing a financial timestamp", async () => {
    fake.enqueue("create", { kind: "success", value: payment(`pi_${intent}`, "requires_action") }); await rail.execute(request());
    const result = await rail.ingress.receive(signed("payment_intent.succeeded", { id: `pi_${intent}`, amount: 200,
      amount_received: 200, currency: "xxx", metadata: { paymentIntentId: intent } }, `evt_${intent}`, null));
    expect(result.status).toBe(200);
    expect((await env.owner.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [intent])).rows).toEqual([{ status: "created" }]);
    expect((await env.owner.query("SELECT processing_status,payload#>'{openlupEvidence,providerOccurredAt}' AS provider_time FROM public.payment_provider_attempt_evidence WHERE settlement_intent_id=$1", [intent])).rows)
      .toEqual([{ processing_status: "received", provider_time: null }]);
  });
});

describe("off-session customer confirmation", () => {
  beforeAll(async () => {
    const row = (await env.runtime.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [subscriptionId])).rows[0];
    time = new Date(new Date(row.next_cycle_at).getTime() + 60_000).toISOString();
  });
  it("records the canonical SCA class on a finalized native attempt", async () => {
    fake.enqueue("create", { kind: "success", value: payment("pi_confirmation", "requires_action") });
    expect(await binding.services.run()).toMatchObject({ renewals: [{ status: "refused" }] });
    expect((await env.owner.query(`SELECT a.failure_class,a.next_action_kind FROM public.payment_provider_attempts a
      WHERE a.provider_attempt_id='pi_confirmation'`)).rows).toEqual([{ failure_class: "sca_required", next_action_kind: "sca_required" }]);
    const op = (await env.owner.query("SELECT id,operation_fingerprint FROM public.subscription_renewal_operations WHERE external_attempt_ref='pi_confirmation'")).rows[0];
    await expect(renewal.lifecycle.settlement.acknowledgeExternalAttempt({ operationId: op.id,
      operationFingerprint: op.operation_fingerprint, externalAttemptRef: "pi_other", acknowledgedAt: time }))
      .rejects.toThrow("commerce_renewal_attempt_ack_not_prepared");
    fake.assertDrained();
  });
});

describe("exact local-intent search after uncertain dispatch", () => {
  let fixture: Awaited<ReturnType<typeof renewalFixture>>, prepared: { settlementIntentId: string; orderId: string };
  beforeAll(async () => {
    fixture = await renewalFixture(env.owner, 10, 1, randomUUID(), true, rail.provider);
    await createPostgresPaymentMethodStore(env.runtime).upsert({ key: `method:${fixture.operation}`, clientId: fixture.client,
      subscriptionId: fixture.subscription, provider: rail.provider, methodKind: "card", customer: "cus_primary", reference: "pm_search",
      mandate: null, status: "active", active: true, expiresAt: null, consent: {}, payload: {} });
    await call(env.runtime, "fulfillment_reserve_subscription_renewal", [fixture.operation, fixture.token, 900, AT]);
    prepared = await call(env.runtime, "commerce_prepare_subscription_renewal", [fixture.operation, fixture.token, AT]);
    await rail.control.createIntent({ idempotencyKey: `search-intent:${fixture.operation}`, targetKind: "subscription_cycle",
      orderId: prepared.orderId, subscriptionId: fixture.subscription,
      subscriptionCycleId: (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [prepared.orderId])).rows[0].subscription_cycle_id,
      amountMinor: 200, currency: "XXX", metadata: {}, channelKey: rail.provider, at: AT });
    fake.enqueue("create", { kind: "timeout-after-dispatch" });
    await expect(rail.execute({ ...executionRequest(), attemptRef: `search:${fixture.operation}`, intentRef: prepared.settlementIntentId,
      orderRef: prepared.orderId, clientId: fixture.client, fingerprint: fixture.fingerprint, saveForFutureUse: false,
      purpose: "renewal-unattended", storedMethod: { reference: "pm_search", mandate: {} },
      providerIdempotencyKey: `search-provider:${fixture.operation}` })).rejects.toThrow("timeout-after-dispatch");
  });
  function selected(ids: string[], enabled = true) {
    return createPostgresProviderRenewalBinding({ enabled, channelKey: rail.provider, executor: env.runtime, withTransaction: transaction,
      paymentRail: rail, truth, now: () => time, codec: { ...codec,
        // This fixture retains the older correlated dialect; its logical cycle
        // is supplied by paid-history evidence, never inferred from a counter.
        decode: wire => ({ ...wire, cycle: fixture.snapshot.cycle, settlementChannelKey: rail.provider }) as unknown as ReturnType<typeof codec.decode> },
      settlement: db => createPostgresRenewalSettlementPort(db, codec, transaction),
      search: async request => { expect(request).toEqual({ localIntentId: prepared.settlementIntentId, limit: 2 }); return ids; } });
  }
  it("refuses unselected/unknown channels without provider calls", async () => {
    expect(selected([]).paymentRails.resolve("unknown")).toBeNull();
    expect(selected([], false).paymentRails.resolve(rail.provider)).toBeNull();
    const calls = requests.length;
    await expect(selected([], false).rail.execute({} as never)).rejects.toThrow("settlement_channel_not_configured");
    expect(requests).toHaveLength(calls);
  });
  it.each([{ ids: [] }, { ids: ["pi_found"] }, { ids: ["pi_first", "pi_second"] }])("keeps zero/one/two search matches bounded: $ids", async ({ ids }) => {
    const before = await rail.readAttempt(prepared.settlementIntentId), calls = requests.length;
    const result = selected(ids).rail.findExternalAttempt({ settlementIntentId: prepared.settlementIntentId });
    if (ids.length > 1) await expect(result).rejects.toThrow("subscription_renewal_provider_attempt_conflict");
    else expect(await result).toBe(ids[0] ?? null);
    expect(await rail.readAttempt(prepared.settlementIntentId)).toEqual(before); expect(requests).toHaveLength(calls);
  });
  it("opens attributed dunning on webhook-first failure and absorbs a later direct failure", async () => {
    const attempt = (await rail.readAttempt(prepared.settlementIntentId))!;
    await rail.control.finalizeProviderAttempt({ idempotencyKey: `search-finalize:${fixture.operation}`, paymentIntentId: prepared.settlementIntentId,
      paymentAttemptId: attempt.paymentAttempt.id, providerIdempotencyKey: `search-provider:${fixture.operation}`,
      providerRequestFingerprint: fixture.fingerprint, providerAttemptId: "pi_found", providerSessionId: "pi_found", attemptStatus: "processing",
      nextActionKind: null, requestPayload: attempt.requestPayload, responsePayload: { providerStatus: "processing" } });
    await call(env.runtime, "commerce_acknowledge_subscription_renewal_attempt", [fixture.operation, fixture.fingerprint, "pi_found", time]);
    expect((await rail.ingress.receive(signed("payment_intent.payment_failed", { id: "pi_found", amount: 200, currency: "xxx",
      metadata: { paymentIntentId: prepared.settlementIntentId }, last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" } }))).status).toBe(200);
    expect(await rail.control.applyPaymentResult({ idempotencyKey: `late-direct:${fixture.operation}`, paymentIntentId: prepared.settlementIntentId,
      paymentEventId: null, resultStatus: "failed", occurredAt: time, failureReason: "declined" })).toMatchObject({ kind: "ignored_duplicate_terminal_failure" });
    expect(await createPostgresRetryStore(env.runtime).read(fixture.operation)).toMatchObject({ retryAttempt: 1, state: "waiting", caseId: expect.any(String) });
    expect((await env.owner.query("SELECT count(*)::int n FROM public.subscription_dunning_cases WHERE subscription_id=$1", [fixture.subscription])).rows[0].n).toBe(1);
  });
  it("settles late success on that original attempt through the existing waiting-state recovery owner", async () => {
    const event = signed("payment_intent.succeeded", { id: "pi_found", amount: 200, amount_received: 200, currency: "xxx",
      metadata: { paymentIntentId: prepared.settlementIntentId } });
    expect(await rail.ingress.receive(event)).toMatchObject({ status: 200 });
    expect(await rail.ingress.receive(event)).toMatchObject({ status: 200, data: { replayed: true } });
    expect(await createPostgresRetryStore(env.runtime).read(fixture.operation)).toMatchObject({ state: "recovered", retryAttempt: 1 });
    fake.assertDrained();
  });
});

describe("reviewed native execution boundaries", () => {
  let f: Awaited<ReturnType<typeof renewalFixture>>, prepared: { settlementIntentId: string; orderId: string };
  let local: ReturnType<typeof createPostgresProviderPaymentRail>, selected: ReturnType<typeof createPostgresProviderRenewalBinding>;
  let primary: string;
  const namedRefusals: string[] = [];
  function compose(paymentRail = local) {
    const dialect = { ...codec, decode: (wire: Record<string, unknown>) => ({ ...wire, cycle: f.snapshot.cycle,
      settlementChannelKey: rail.provider }) as unknown as ReturnType<typeof codec.decode>,
      readback: (wire: Record<string, unknown>) => wire as unknown as ReturnType<typeof codec.readback> };
    return createPostgresProviderRenewalBinding({ enabled: true, channelKey: rail.provider, executor: env.runtime,
      withTransaction: transaction, paymentRail, codec: dialect, truth, now: () => time,
      settlement: db => createPostgresRenewalSettlementPort(db, dialect, transaction), search: async () => [] });
  }
  const input = () => ({ cycleIdempotencyKey: f.identity, executionIdempotencyKey: `review:${f.operation}`,
    externalIdempotencyKey: `review-provider:${f.operation}`, requestFingerprint: f.fingerprint,
    paymentIntentId: prepared.settlementIntentId, orderId: prepared.orderId, orderRef: prepared.orderId, clientId: f.client,
    amountMinor: 200, currency: "XXX", mode: "subscription" as const, flow: "off_session" as const,
    customerRef: "cus_primary", paymentMethodRef: primary, recurringModel: null, payer: null });
  async function state() {
    return (await env.owner.query(`SELECT jsonb_build_array(
      (SELECT to_jsonb(i) FROM public.commerce_settlement_intents i WHERE id=$1),
      (SELECT to_jsonb(o) FROM public.subscription_renewal_operations o WHERE id=$2),
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.payment_provider_attempts a WHERE settlement_intent_id=$1),
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY scope,idempotency_key) FROM public.payment_provider_receipts r WHERE metadata->>'paymentIntentId'=$1::text),
      (SELECT jsonb_agg(to_jsonb(o)) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=$2)) AS value`,
    [prepared.settlementIntentId, f.operation])).rows[0].value;
  }
  beforeEach(async () => {
    f = await renewalFixture(env.owner, 10, 1, randomUUID(), true, rail.provider); primary = `pm_review_${f.subscription}`;
    await createPostgresPaymentMethodStore(env.runtime).upsert({ key: `review-method:${f.subscription}`, clientId: f.client,
      subscriptionId: f.subscription, provider: rail.provider, methodKind: "card", customer: "cus_primary", reference: primary,
      mandate: null, status: "active", active: true, expiresAt: null, consent: {}, payload: {} });
    await call(env.runtime, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
    prepared = await call(env.runtime, "commerce_prepare_subscription_renewal", [f.operation, f.token, AT]);
    namedRefusals.length = 0;
    local = createPostgresProviderPaymentRail({ executor: env.runtime, adapter: rail.adapter, mode: rail.mode, truth,
      resolveMethodOwner: async () => null, resolveSavedMethodOwner: async () => null,
      composeWebhook: (event, control) => selected.composeWebhook(event, { ...control, async applyPaymentResult(request: Parameters<NonNullable<typeof control.applyPaymentResult>>[0]) {
        try { return await control.applyPaymentResult!(request); }
        catch (error) { namedRefusals.push((error as Error).message); throw error; }
      } }) });
    selected = compose();
  });
  describe.each([
    { kind: "inactive", reason: "payment_method_revoked" },
    { kind: "unrecorded", reason: "missing_provider_method_ref" },
    { kind: "foreign", reason: "payment_method_cross_client" },
    { kind: "customer", reason: "payment_method_invalid" },
  ])("addressed method $kind", ({ kind, reason }) => {
    let request: ReturnType<typeof input>;
    beforeEach(async () => {
      request = input();
      if (kind === "inactive") {
        const old = await createPostgresPaymentMethodStore(env.runtime).read(rail.provider, primary);
        await createPostgresPaymentMethodStore(env.runtime).upsert({ key: `replacement:${f.subscription}`, clientId: f.client,
          subscriptionId: f.subscription, provider: rail.provider, methodKind: "card", customer: "cus_primary", reference: `${primary}_new`,
          mandate: null, status: "active", active: true, expiresAt: null, consent: {}, payload: {} });
        await call(env.runtime, "payment_method_ref_deactivate", [`deactivate:${f.subscription}`, old!.id, "replaced", {}]);
      } else if (kind === "unrecorded") request.paymentMethodRef = `${primary}_absent`;
      else if (kind === "foreign") request.paymentMethodRef = "pm_replacement";
      else request.customerRef = "cus_wrong";
    });
    it("refuses before admission, mutation or provider I/O", async () => {
      const before = await state(), calls = requests.length;
      await expect(selected.rail.execute(request)).rejects.toThrow(reason);
      expect(requests).toHaveLength(calls); expect(await state()).toEqual(before);
    });
  });
  describe("original renewal without a recorded ref", () => {
    beforeEach(async () => { await env.owner.query("DELETE FROM public.payment_method_refs WHERE subscription_id=$1", [f.subscription]); });
    it("preserves the original dispatch path without inferring a recorded row", async () => {
      fake.enqueue("create", { kind: "success", value: { ...payment(`pi_${f.operation}`, "processing"), payment_method: primary } });
      expect(await selected.rail.execute(input())).toMatchObject({ status: "pending" });
      expect(requests.at(-1)).toMatchObject({ paymentMethod: primary, customer: "cus_primary" });
      expect((await env.owner.query("SELECT count(*)::int n FROM public.payment_method_refs WHERE subscription_id=$1", [f.subscription])).rows[0].n).toBe(0);
    });
  });
  describe("untimestamped native ingress", () => {
    let event: ReturnType<typeof signed>;
    beforeEach(async () => {
      await local.control.createIntent({ idempotencyKey: `${f.identity}:provider-intent`, targetKind: "subscription_cycle",
        orderId: prepared.orderId, subscriptionId: f.subscription,
        subscriptionCycleId: (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [prepared.orderId])).rows[0].subscription_cycle_id,
        amountMinor: 200, currency: "XXX", metadata: {}, channelKey: rail.provider, at: AT });
      event = signed("payment_intent.succeeded", { id: `pi_${f.operation}`, amount: 200, amount_received: 200,
        currency: "xxx", metadata: { paymentIntentId: prepared.settlementIntentId } }, `evt_${f.operation}`, null);
    });
    it("keeps native source and returned occurrence absent across receipt-time redelivery", async () => {
      expect(await local.ingress.receive(event)).toMatchObject({ status: 200 });
      const row = (await env.owner.query("SELECT * FROM public.payment_provider_attempt_evidence WHERE provider_event_id=$1", [`evt_${f.operation}`])).rows[0];
      expect(row.source_evidence.observedAt).toBeNull();
      expect(row.payload.openlupReceipt.receivedAt).toBe(event.receivedAt);
      const replay = await createPostgresPaymentWebhookControlPort(env.runtime, truth).ingestPaymentEvent({
        provider: rail.provider, providerEventId: row.provider_event_id, eventType: "payment.succeeded", providerPaymentId: row.provider_payment_id,
        paymentIntentId: prepared.settlementIntentId, amountMinor: 200, currency: "XXX", rawPayload: row.payload,
        occurredAt: new Date(Date.parse(event.receivedAt) + 60_000).toISOString() });
      expect(replay).toMatchObject({ replayed: true }); expect(replay.occurredAt).toBeUndefined();
      expect((await env.owner.query("SELECT source_evidence FROM public.payment_provider_attempt_evidence WHERE id=$1", [row.id])).rows[0].source_evidence).toEqual(row.source_evidence);
    });
  });
  describe("finalized SCA interruption", () => {
    beforeEach(async () => {
      fake.enqueue("create", { kind: "success", value: { ...payment(`pi_${f.operation}`, "requires_action"), payment_method: primary } });
      const interrupted = compose({ ...local, control: { ...local.control, async applyPaymentResult() { throw new Error("synthetic_before_failure_apply"); } } });
      await expect(interrupted.rail.execute(input())).rejects.toThrow("synthetic_before_failure_apply");
    });
    it("replays the persisted refusal once without provider readback or another dispatch", async () => {
      const before = fake.calls.length;
      const request = { settlementIntentId: prepared.settlementIntentId, orderId: prepared.orderId, subscriptionId: f.subscription,
        amountMinor: 200, currency: "XXX", externalAttemptRef: `pi_${f.operation}` };
      const untouched = await state();
      await expect(compose().rail.readOutcome({ ...request, externalAttemptRef: "pi_wrong" })).rejects.toThrow("subscription_renewal_provider_attempt_conflict");
      expect(await state()).toEqual(untouched);
      const first = await compose().rail.readOutcome(request);
      expect(first).toMatchObject({ status: "failed", disposition: "observed", reason: "off_session_sca_required" });
      const preparedInstantMatches = (await env.owner.query(`SELECT created_at=$2::timestamptz AS matches
        FROM public.payment_provider_attempts WHERE settlement_intent_id=$1`, [prepared.settlementIntentId, first.occurredAt])).rows[0].matches;
      expect(preparedInstantMatches).toBe(true);
      time = new Date(Date.parse(time) + 60_000).toISOString();
      expect(await compose().rail.readOutcome(request)).toMatchObject({ status: "failed", disposition: "observed",
        occurredAt: first.occurredAt, firstRecordedAt: first.firstRecordedAt, verifiedEvidenceRef: first.verifiedEvidenceRef });
      expect(fake.calls).toHaveLength(before);
      expect(await createPostgresRetryStore(env.runtime).read(f.operation)).toMatchObject({ retryAttempt: 1, caseId: expect.any(String) });
      expect((await env.owner.query("SELECT failure_class FROM public.payment_provider_attempts WHERE settlement_intent_id=$1",
        [prepared.settlementIntentId])).rows).toEqual([{ failure_class: "sca_required" }]);
      expect((await env.owner.query(`SELECT count(*)::int n FROM public.payment_dunning_case_attribution a
        JOIN public.subscription_dunning_cases c ON c.id=a.case_id WHERE c.subscription_id=$1`, [f.subscription])).rows[0].n).toBe(1);
    });
  });
  describe.each(["superseded", "unresolved"])("%s success delivery", kind => {
    let event: ReturnType<typeof signed>;
    beforeEach(async () => {
      fake.enqueue("create", { kind: "success", value: { ...payment(`pi_${f.operation}`, "processing"), payment_method: primary } });
      await selected.rail.execute(input());
      await local.control.applyPaymentResult({ idempotencyKey: `review-decline:${f.operation}`, paymentIntentId: prepared.settlementIntentId,
        paymentEventId: null, resultStatus: "failed", occurredAt: time, failureReason: "declined" });
      await local.control.prepareProviderAttempt({ idempotencyKey: `review-next:${f.operation}`, paymentIntentId: prepared.settlementIntentId,
        provider: rail.provider, providerIdempotencyKey: `review-next-provider:${f.operation}`, providerRequestFingerprint: f.fingerprint,
        providerFlow: "off_session_payment", paymentMethodRef: primary, requestPayload: {} });
      event = signed("payment_intent.succeeded", { id: kind === "superseded" ? `pi_${f.operation}` : `pi_unknown_${f.operation}`,
        amount: 200, amount_received: 200, currency: "xxx", metadata: { paymentIntentId: prepared.settlementIntentId } });
    });
    it("reaches exact-attempt refusal and ACK on every delivery with no business mutation", async () => {
      const before = await state(), calls = requests.length;
      expect(await local.ingress.receive(event)).toMatchObject({ status: 200, data: { skipped: "result_attempt_mismatch" } });
      expect(await local.ingress.receive(event)).toMatchObject({ status: 200, data: { skipped: "result_attempt_mismatch" } });
      expect(namedRefusals).toEqual([`payment_control_result_attempt_${kind === "superseded" ? "mismatch" : "unresolved"}`,
        `payment_control_result_attempt_${kind === "superseded" ? "mismatch" : "unresolved"}`]);
      expect(await state()).toEqual(before); expect(requests).toHaveLength(calls);
    });
  });
  describe("unresolved evidence redelivery after finalization", () => {
    let event: ReturnType<typeof signed>, attemptId: string;
    beforeEach(async () => {
      await local.control.createIntent({ idempotencyKey: `${f.identity}:provider-intent`, targetKind: "subscription_cycle",
        orderId: prepared.orderId, subscriptionId: f.subscription,
        subscriptionCycleId: (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [prepared.orderId])).rows[0].subscription_cycle_id,
        amountMinor: 200, currency: "XXX", metadata: {}, channelKey: rail.provider, at: AT });
      const attempt = await local.control.prepareProviderAttempt({ idempotencyKey: `early:${f.operation}`, paymentIntentId: prepared.settlementIntentId,
        provider: rail.provider, providerIdempotencyKey: `early-provider:${f.operation}`, providerRequestFingerprint: f.fingerprint,
        providerFlow: "off_session_payment", paymentMethodRef: primary, requestPayload: {} });
      attemptId = attempt.paymentAttemptId;
      event = signed("payment_intent.succeeded", { id: `pi_early_${f.operation}`, amount: 200, amount_received: 200,
        currency: "xxx", metadata: { paymentIntentId: prepared.settlementIntentId } }, `evt_early_${f.operation}`);
    });
    it("retains the unresolved ACK and immutable attribution after the same handle is finalized", async () => {
      const before = await state(), calls = fake.calls.length;
      const first = await local.ingress.receive(event);
      expect(first).toMatchObject({ status: 200, data: { skipped: "result_attempt_mismatch" } });
      expect(await state()).toEqual(before);
      const evidence = (await env.owner.query("SELECT * FROM public.payment_provider_attempt_evidence WHERE provider_event_id=$1",
        [`evt_early_${f.operation}`])).rows[0];
      expect(evidence.payment_attempt_id).toBeNull();
      await local.control.finalizeProviderAttempt({ idempotencyKey: `early-finalize:${f.operation}`, paymentIntentId: prepared.settlementIntentId,
        paymentAttemptId: attemptId, providerIdempotencyKey: `early-provider:${f.operation}`, providerRequestFingerprint: f.fingerprint,
        providerAttemptId: `pi_early_${f.operation}`, providerSessionId: `pi_early_${f.operation}`, attemptStatus: "processing",
        nextActionKind: null, requestPayload: {}, responsePayload: { providerStatus: "processing" } });
      expect((await local.readAttempt(prepared.settlementIntentId))!.paymentAttempt.providerAttemptId).toBe(`pi_early_${f.operation}`);
      const finalized = await state();
      expect(await local.ingress.receive(event)).toEqual(first);
      expect(await local.ingress.receive(event)).toEqual(first);
      expect(namedRefusals).toEqual(Array(3).fill("payment_control_result_attempt_unresolved"));
      expect(await state()).toEqual(finalized); expect(fake.calls).toHaveLength(calls);
      expect((await env.owner.query("SELECT * FROM public.payment_provider_attempt_evidence WHERE id=$1", [evidence.id])).rows[0]).toEqual(evidence);
    });
  });
});

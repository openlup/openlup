import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort } from "@openlup/platform/payments";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources(), at = "2032-01-01T12:00:00.000Z";
let source: JourneyInstallation, target: JourneyInstallation;
beforeAll(async () => { source = await resources.installation("provider-source"); target = await resources.installation("provider-target"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it("carries every provider relation and its cyclic active pointer byte-exactly, rejects a broken pointer and replays", async () => {
  const client = randomUUID(), sku = randomUUID(), order = randomUUID();
  await source.owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [sku, sku]);
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Example')", [sku, sku]);
  await source.owner.query(`WITH created AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor)
    VALUES($1,$2,'pending_payment','XXX',100) RETURNING id)
    INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT id,$3,1,1,100,100 FROM created`, [order, client, sku]);
  const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
  const port = createPostgresProviderPaymentControlPort(source.runtime, options);
  const intent = await port.createIntent({ idempotencyKey: `intent:${order}`, targetKind: "one_time_order", orderId: order,
    amountMinor: 100, currency: "XXX", metadata: {}, channelKey: "card_rail", at });
  const prepare = { idempotencyKey: `prepare:${order}`, paymentIntentId: intent.id, provider: "card_rail",
    providerIdempotencyKey: `provider:${order}`, providerRequestFingerprint: "a".repeat(64), providerFlow: "one_time_payment", requestPayload: {} };
  const first = await port.prepareProviderAttempt(prepare);
  await port.finalizeProviderAttempt({ idempotencyKey: `finalize:${order}`, paymentIntentId: intent.id, paymentAttemptId: first.paymentAttemptId,
    providerIdempotencyKey: prepare.providerIdempotencyKey, providerRequestFingerprint: prepare.providerRequestFingerprint,
    providerAttemptId: `payment_${order}`, providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} });
  const event = await createPostgresPaymentWebhookControlPort(source.runtime, options).ingestPaymentEvent({ provider: "card_rail",
    providerEventId: `event:${order}`, eventType: "payment.failed", providerPaymentId: `payment_${order}`, paymentIntentId: intent.id,
    amountMinor: 0, currency: "XXX", occurredAt: at, rawPayload: {} });
  await port.applyPaymentResult({ idempotencyKey: `apply:${order}`, paymentIntentId: intent.id, paymentEventId: event.paymentEventId,
    resultStatus: "failed", occurredAt: at, failureReason: "declined" });
  const second = await port.prepareProviderAttempt({ ...prepare, idempotencyKey: `retry:${order}`, providerIdempotencyKey: `provider-retry:${order}` });
  await source.owner.query(`UPDATE public.payment_provider_attempts SET response_payload=response_payload||'{"large":9007199254740993}'::jsonb WHERE id=$1`, [first.paymentAttemptId]);
  const before = await journeyCensus(source.owner), packet = await captureStoreJourney(source.owner, "provider-source");
  const freshTarget = await captureStoreJourney(target.owner, "provider-target"), pristine = await journeyCensus(target.owner);
  for (const table of ["payment_provider_states", "payment_provider_attempts", "payment_provider_attempt_evidence", "payment_provider_receipts", "payment_provider_transitions"] as const) {
    expect(packet.owned.find(value => value.table === table)?.rows).toEqual(before[table]); expect(before[table].length).toBeGreaterThan(0);
  }
  const broken = structuredClone(packet), state = broken.owned.find(value => value.table === "payment_provider_states")!;
  expect(state.rows[0]).toContain(`"active_attempt_id": "${second.paymentAttemptId}"`);
  state.rows[0] = state.rows[0].replace(/("active_attempt_id":\s*")[^"]+(")/u, `$1${randomUUID()}$2`);
  const { sha256: _old, ...body } = broken; broken.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await expect(restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: broken, freshTarget })).rejects.toMatchObject({ code: "target_conflict" });
  expect(await journeyCensus(target.owner)).toEqual(pristine);
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);
});

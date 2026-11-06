import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createNativeRenewalCodec, createPostgresPurchaseRenewalWriter, createPostgresRenewalStore } from "@openlup/platform/subscriptions";
import { assertJourneyRuntime, captureAndActivateJourney, draftStoreJourney, journeyCensus, journeyFacts,
  journeyPaidAt, journeyRpc, journeyScheduledAt, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("acceptance"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

// This joins real checkout, payment and activation ports. The earlier G2 witness
// characterizes renewal/retry mechanics; terminal public-run replay awaits its repair.
it("composes a native purchase, refuses unpaid activation, and drains its durable duty exactly once", async () => {
  const draft = await draftStoreJourney(store);
  const checkout = createPostgresNativeCheckoutPersistence(store.runtime);
  const beforePayment = await journeyCensus(store.owner);
  await expect(journeyRpc(store.runtime, "subscription_activate_from_captured_payment",
    [`unpaid:${draft.key}`, draft.orderId, "a".repeat(64)])).rejects.toThrow("subscription_activation_order_not_paid");
  expect(await journeyCensus(store.owner)).toEqual(beforePayment);
  const changed = structuredClone(draft.request);
  const context = changed.quoteSnapshot.quote.context;
  if (!context) throw new Error("Synthetic subscription quote context missing");
  context.promoCodes = ["synthetic-other"];
  await expect(checkout.createOrderDraft(changed, { clientId: draft.clientId }))
    .rejects.toMatchObject({ name: "CommerceOrderDraftConflictError", details: { code: "23505" } });
  expect(await journeyCensus(store.owner)).toEqual(beforePayment);

  const journey = await captureAndActivateJourney(store, draft);
  const writer = createPostgresPurchaseRenewalWriter(store.runtime);
  expect(await writer.pending()).toEqual([{ orderId: journey.orderId, subscriptionId: journey.subscriptionId, hasPurchaseFacts: true }]);
  const paid = await journeyCensus(store.owner);
  await expect(writer.register(journey.orderId, { ...journeyFacts, payerAccountRef: "sandbox:payer:002" }))
    .rejects.toThrow("purchase_conflict");
  expect(await journeyCensus(store.owner)).toEqual(paid);
  expect(await writer.complete(journey.orderId)).toEqual({ subscriptionId: journey.subscriptionId, replayed: false });
  const completed = await journeyCensus(store.owner);
  expect(await writer.complete(journey.orderId)).toEqual({ subscriptionId: journey.subscriptionId, replayed: true });
  expect(await checkout.createOrderDraft(draft.request, { clientId: draft.clientId }))
    .toEqual({ ...draft.created, orderDraft: { ...draft.created.orderDraft, replayed: true } });
  expect(await journeyRpc(store.runtime, "subscription_activate_from_captured_payment",
    [`activate:${draft.key}`, draft.orderId, journey.fingerprint])).toEqual({ ...journey.activation, replayed: true });
  expect(await journeyCensus(store.owner)).toEqual(completed);
  expect(await writer.pending()).toEqual([]);
  await assertJourneyRuntime(store.runtime);
  for (const table of ["subscription_renewal_attachments", "subscription_method_state_events"]) {
    await expect(store.runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
  }
  expect((await store.owner.query(`SELECT o.id,o.client_id,o.status,o.currency_code,o.total_amount_minor::text,
    i.amount_minor::text,i.currency_code AS settlement_currency,i.status AS settlement_status,
    to_char(i.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at
    FROM public.commerce_orders o JOIN public.commerce_settlement_intents i ON i.order_id=o.id`)).rows)
    .toEqual([{ id: journey.orderId, client_id: journey.clientId, status: "paid", currency_code: "XXX", total_amount_minor: "1027",
      amount_minor: "1027", settlement_currency: "XXX", settlement_status: "settled", settled_at: journeyPaidAt }]);
  expect((await store.owner.query(`SELECT s.sku,i.line_ordinal,i.quantity,i.unit_amount_minor::text,i.line_amount_minor::text
    FROM public.commerce_order_items i JOIN public.catalog_skus s ON s.id=i.sku_id ORDER BY i.line_ordinal`)).rows)
    .toEqual([{ sku: "JOURNEY-A", line_ordinal: 1, quantity: 2, unit_amount_minor: "137", line_amount_minor: "274" },
      { sku: "JOURNEY-B", line_ordinal: 2, quantity: 3, unit_amount_minor: "251", line_amount_minor: "753" }]);
  const renewal = createPostgresRenewalStore(store.runtime, createNativeRenewalCodec());
  const due = await renewal.listDue(10, "2026-09-29T12:01:00.000Z");
  expect(due).toHaveLength(1);
  expect(due[0]).toMatchObject({ subscriptionId: journey.subscriptionId, scheduledAt: journeyScheduledAt });
  const frozen = await renewal.buildCycleSnapshots(due[0]!);
  expect(frozen).toMatchObject({ subscriptionId: journey.subscriptionId, clientId: journey.clientId,
    scheduledAt: journeyScheduledAt, unattendedChargeAuthorizedAt: journeyPaidAt,
    templateSnapshot: { templateId: journeyFacts.templateId, cadenceDays: 28, lines: journeyFacts.lines },
    pricingSnapshot: { currency: "XXX", totalAmountMinor: 1027, shippingAmountMinor: 0 },
    cycle: { status: "correlated", logicalCycleNumber: 2 } });
}, 30_000);

import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createNativeRenewalCodec, createPostgresPurchaseRenewalWriter, createPostgresRenewalStore } from "@openlup/platform/subscriptions";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { assertJourneyRuntime, captureAndActivateJourney, captureStoreJourney, draftStoreJourney, journeyCensus, journeyFacts,
  journeyPaidAt, journeyRpc, journeyScheduledAt, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
let source: JourneyInstallation, target: JourneyInstallation;
beforeAll(async () => {
  source = await resources.installation("source");
  target = await resources.installation("target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

// connectedStoreTransfer already proves a writer-created renewal graph and,
// separately, a checkout receipt. This case joins checkout -> simulator attempt,
// observation and verified ingress -> activation/duty on ONE store before transfer.
// Final renewal execution/replay is added after the native renewal repair lands.
it("transfers one purchased store to a pristine database and continues its open activation duty through the restricted runtime", async () => {
  const pristine = await captureStoreJourney(target.owner, "journey-pristine-target");
  const ledger = (await target.owner.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position")).rows;
  expect((await target.owner.query(`SELECT (SELECT count(*)::int FROM public.commerce_orders) AS orders,
    (SELECT count(*)::int FROM public.subscriptions) AS subscriptions`)).rows).toEqual([{ orders: 0, subscriptions: 0 }]);
  const journey = await captureAndActivateJourney(source, await draftStoreJourney(source));
  const before = await journeyCensus(source.owner);
  const packet = await captureStoreJourney(source.owner, "journey-purchased-source");
  const carried = [...packet.compatible.tables, ...packet.owned];
  // Discover actual populated journey tables independently. An omitted populated
  // table must fail capture itself or this full-row comparison after restore.
  for (const [table, rows] of Object.entries(before)) if (rows.length) {
    const captured = carried.find(entry => entry.table === table);
    expect(captured, `capture omitted ${table}`).toBeDefined();
    expect([...captured!.rows].sort(), `capture changed ${table}`).toEqual([...rows].sort());
  }
  const restore = () => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine });
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: 0 });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restore()).toEqual({ captureSha256: packet.sha256, replayed: true, neutralizedHistoricalHoldNotifications: 0 });
  expect((await target.owner.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position")).rows).toEqual(ledger);
  await assertJourneyRuntime(target.runtime);
  expect((await target.owner.query(`SELECT a.order_id,a.subscription_id,a.state,
    to_char(a.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activated_at,
    to_char(s.next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS next_cycle_at,
    r.completed_at,r.purchase_facts FROM public.subscription_activations a
    JOIN public.subscriptions s ON s.id=a.subscription_id JOIN public.subscription_renewal_attachments r ON r.order_id=a.order_id`)).rows)
    .toEqual([{ order_id: journey.orderId, subscription_id: journey.subscriptionId, state: "active", activated_at: journeyPaidAt,
      next_cycle_at: journeyScheduledAt, completed_at: null, purchase_facts: journeyFacts }]);
  expect(await createPostgresNativeCheckoutPersistence(target.runtime).createOrderDraft(journey.request, { clientId: journey.clientId }))
    .toEqual({ ...journey.created, orderDraft: { ...journey.created.orderDraft, replayed: true } });
  expect(await journeyRpc(target.runtime, "subscription_activate_from_captured_payment",
    [`activate:${journey.key}`, journey.orderId, journey.fingerprint])).toEqual({ ...journey.activation, replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);

  const writer = createPostgresPurchaseRenewalWriter(target.runtime);
  expect(await writer.pending()).toEqual([{ orderId: journey.orderId, subscriptionId: journey.subscriptionId, hasPurchaseFacts: true }]);
  expect(await writer.complete(journey.orderId)).toEqual({ subscriptionId: journey.subscriptionId, replayed: false });
  const completed = await journeyCensus(target.owner);
  expect(await writer.complete(journey.orderId)).toEqual({ subscriptionId: journey.subscriptionId, replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(completed);
  expect(await writer.pending()).toEqual([]);
  expect((await target.owner.query(`SELECT t.currency_code,t.stock_source_key,t.settlement_channel_key,t.authorization_ref,
    to_char(t.unattended_charge_authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS authorized_at,
    l.line_ordinal,l.sku,l.quantity,l.unit_amount_minor::text FROM public.subscription_renewal_terms t
    JOIN public.subscription_renewal_term_lines l ON l.subscription_id=t.subscription_id ORDER BY l.line_ordinal`)).rows)
    .toEqual(journeyFacts.lines.map(line => ({ currency_code: "XXX", stock_source_key: journeyFacts.stockSourceKey,
      settlement_channel_key: "sandbox", authorization_ref: journeyFacts.authorizationRef, authorized_at: journeyPaidAt,
      line_ordinal: line.lineOrdinal, sku: line.sku, quantity: line.quantity, unit_amount_minor: String(line.unitAmountMinor) })));
  const renewal = createPostgresRenewalStore(target.runtime, createNativeRenewalCodec());
  const due = await renewal.listDue(10, "2026-09-29T12:01:00.000Z");
  expect(due).toHaveLength(1);
  expect(await renewal.buildCycleSnapshots(due[0]!)).toMatchObject({ subscriptionId: journey.subscriptionId,
    scheduledAt: journeyScheduledAt, unattendedChargeAuthorizedAt: journeyPaidAt,
    pricingSnapshot: { currency: "XXX", totalAmountMinor: 1027 }, orderSnapshot: { lines: journeyFacts.lines } });
  expect((await target.owner.query(`SELECT (SELECT count(*)::int FROM public.commerce_orders) AS orders,
    (SELECT count(*)::int FROM public.subscription_cycles) AS cycles,
    (SELECT count(*)::int FROM public.fulfillment_shipments) AS shipments,
    (SELECT count(*)::int FROM public.subscription_events WHERE event_type='subscription.activated') AS activations`)).rows)
    .toEqual([{ orders: 1, cycles: 1, shipments: 0, activations: 1 }]);
  expect(await journeyCensus(source.owner)).toEqual(before);
}, 60_000);

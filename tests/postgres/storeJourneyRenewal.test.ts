import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresPaidFulfillmentHandoffStore } from "@openlup/platform/fulfillment";
import { runOneAutomaticSubscriptionRenewal } from "@openlup/platform/subscriptions";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { assertJourneyRuntime, assertJourneyWithoutIntake, captureStoreJourney, composeJourneyRenewal, journeyCensus,
  journeyFacts, journeyPaidAt, journeyScheduledAt, journeySelection, prepareJourneyRenewal, storeJourneyResources } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const at = "2026-09-29T12:01:00.654321Z", later = "2026-09-29T13:01:00.654321Z";

it("executes the transferred paid subscription once and replays its terminal result without durable effects", async () => {
  const source = await resources.installation("renewal-source"), target = await resources.installation("renewal-target");
  await assertJourneyWithoutIntake(target);
  const pristine = await captureStoreJourney(target.owner, "renewal-pristine");
  const purchase = await prepareJourneyRenewal(source);
  const original = await composeJourneyRenewal(source, purchase.subscriptionId, "succeeded", at);
  const snapshot = await original.input.store.buildCycleSnapshots(original.due);
  expect(snapshot).toMatchObject({ scheduledAt: journeyScheduledAt, unattendedChargeAuthorizedAt: journeyPaidAt,
    pricingSnapshot: { totalAmountMinor: 1027, currency: "XXX" }, orderSnapshot: { lines: journeyFacts.lines } });
  const before = await journeyCensus(source.owner), packet = await captureStoreJourney(source.owner, "renewal-purchased");
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  const restored = await composeJourneyRenewal(target, purchase.subscriptionId, "succeeded", at);
  expect(restored.due).toEqual(original.due);
  expect(await restored.input.store.buildCycleSnapshots(restored.due)).toEqual(snapshot);
  const frozen = original.codec.withDestination!(snapshot, purchase.destination.destinationId);
  expect(frozen.orderSnapshot).toMatchObject({ shippingAddressRef: purchase.destination.destinationId,
    shippingQuoteRef: { kind: "zero_shipping", shippingAmountMinor: 0 } });
  const answers: unknown[] = [];
  for (const [store, composition] of [[source, original], [target, restored]] as const) {
    await assertJourneyRuntime(store.runtime);
    const result = await runOneAutomaticSubscriptionRenewal(composition.input, composition.due, at);
    expect(result).toMatchObject({ subscriptionId: purchase.subscriptionId, status: "succeeded", replayed: false, reason: null });
    const operation = (await composition.input.store.readRenewal(result.identityKey))!;
    expect(operation).toMatchObject({ state: "succeeded", cycleSnapshot: frozen, orderId: expect.any(String),
      settlementIntentId: expect.any(String), externalAttemptRef: expect.stringContaining("sandbox-renewal:") });
    expect(await createPostgresDestinationPort(store.runtime).read("order", operation.orderId!)).toEqual(purchase.destination);
    const paid = (await store.runtime.query("SELECT id FROM public.outbox_events WHERE event_type='commerce.order.paid' AND aggregate_id=$1", [operation.orderId])).rows;
    expect(paid).toHaveLength(1);
    const handoff = createPostgresPaidFulfillmentHandoffStore(store.runtime, "journey-parcel");
    const deliveryInput = { requestKey: `renewal-paid:${paid[0].id}`, orderRef: operation.orderId!, paidFactRef: String(paid[0].id) };
    const delivery = await handoff.ensureObligation(deliveryInput);
    expect(delivery).toEqual({ fulfillmentRef: expect.any(String), replayed: false });
    const effects = (await store.owner.query(`SELECT
      (SELECT count(*)::int FROM public.commerce_orders) AS orders,
      (SELECT count(*)::int FROM public.commerce_settlement_intents) AS intents,
      (SELECT count(*)::int FROM public.subscription_cycles) AS cycles,
      (SELECT count(*)::int FROM public.fulfillment_shipments) AS shipments,
      (SELECT count(*)::int FROM public.fulfillment_paid_handoffs) AS handoffs,
      (SELECT count(*)::int FROM public.subscription_renewal_operations) AS operations,
      (SELECT count(*)::int FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1) AS reservations,
      (SELECT count(*)::int FROM public.fulfillment_inventory_reservation_lines) AS held_lines,
      (SELECT status FROM public.commerce_settlement_intents WHERE id=$2) AS settlement,
      (SELECT status FROM public.subscription_cycles WHERE id=$3) AS cycle,
      (SELECT status FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1) AS reservation`,
      [operation.operationId, operation.settlementIntentId, operation.cycleId])).rows[0];
    expect(effects).toEqual({ orders: 2, intents: 2, cycles: 2, shipments: 1, handoffs: 1, operations: 1, reservations: 1, held_lines: 2,
      settlement: "settled", cycle: "paid", reservation: "consumed" });
    const terminal = await journeyCensus(store.owner);
    const digest = (rows: typeof terminal) => Object.fromEntries(Object.entries(rows).map(([table, values]) =>
      [table, { count: values.length, sha256: createHash("sha256").update(JSON.stringify(values)).digest("hex") }]));
    const replay = await runOneAutomaticSubscriptionRenewal(composition.input, composition.due, later);
    expect(replay).toEqual({ ...result, status: "terminal_replay", replayed: true });
    expect(replay.reason).not.toBe("subscription_renewal_claim_not_due");
    expect(await handoff.ensureObligation(deliveryInput)).toEqual({ ...delivery, replayed: true });
    expect(composition.executions()).toBe(1);
    expect(await composition.input.store.readRenewal(result.identityKey)).toEqual(operation);
    expect(await journeyCensus(store.owner)).toEqual(terminal);
    expect(digest(await journeyCensus(store.owner))).toEqual(digest(terminal));
    answers.push({ status: result.status, reason: result.reason, identityKey: result.identityKey, snapshot: operation.cycleSnapshot, effects });
  }
  expect(answers[1]).toEqual(answers[0]);
// Two-store joined cases measured at most 11 s; 90 s retains installation and loaded-host headroom.
}, 90_000);

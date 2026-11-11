import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresDeliveryAlignmentPort, createPostgresFulfillmentShipmentSpinePort, createPostgresPaidFulfillmentHandoffStore } from "@openlup/platform/fulfillment";
import { runOneAutomaticSubscriptionRenewal, withNativeDeliveryAlignmentRenewalAdmission } from "@openlup/platform/subscriptions";
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
}, 135_000);


it("retains a protected predecessor, extends the restored schedule on actual late arrival and renews only at that later instant", async () => {
  const source = await resources.installation("late-renewal-source"), target = await resources.installation("late-renewal-target");
  await assertJourneyWithoutIntake(target);
  const pristine = await captureStoreJourney(target.owner, "late-renewal-pristine"), purchase = await prepareJourneyRenewal(source);
  // Existing owner-only installation configuration and an undispatched predecessor
  // fixture; alignment admission, arrival and renewal all use the real runtime.
  await source.owner.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
  const predecessor = await createPostgresFulfillmentShipmentSpinePort(source.owner, { portKey: "journey-parcel" })
    .createShipment({ idempotencyKey: "journey-late-predecessor", orderId: purchase.orderId, requestedAt: journeyPaidAt });
  const offered = await composeJourneyRenewal(source, purchase.subscriptionId, "succeeded", at);
  const admission = { subscriptionId: purchase.subscriptionId, scheduledAt: journeyScheduledAt,
    scheduledInstant: offered.due.scheduledInstant, occurredAt: at } satisfies Parameters<ReturnType<typeof withNativeDeliveryAlignmentRenewalAdmission>["admitDeliveryAlignment"]>[0];
  expect(await withNativeDeliveryAlignmentRenewalAdmission(offered.input.store, source.runtime).admitDeliveryAlignment(admission))
    .toEqual({ allowed: false, state: "protected", reason: "delivery_alignment_protected", deferred: true });
  const before = await journeyCensus(source.owner), packet = await captureStoreJourney(source.owner, "late-renewal-protected");
  expect(before.subscription_delivery_alignment_cases).toHaveLength(1);
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  const deliveredAt = "2026-09-30T12:00:00.123456Z", extended = "2026-10-28T12:00:00.123456Z";
  const renewAt = "2026-10-28T12:01:00.654321Z", replayAt = "2026-10-28T13:01:00.654321Z";
  const arrival = { requestKey: "journey-late-arrival", parcelRef: predecessor.shipmentId,
    deliveredAt, evidenceRef: "evidence:journey-late-arrival" } satisfies Parameters<ReturnType<typeof createPostgresDeliveryAlignmentPort>["recordArrival"]>[0];
  const answers: unknown[] = [];
  for (const store of [source, target]) {
    await assertJourneyRuntime(store.runtime);
    expect((await store.runtime.query("SELECT public.subscription_delivery_alignment_get_mode() AS mode")).rows)
      .toEqual([{ mode: "auto_align" }]);
    expect((await store.owner.query("SELECT state,captured_mode,shipment_id FROM public.subscription_delivery_alignment_cases")).rows)
      .toEqual([{ state: "protected", captured_mode: "auto_align", shipment_id: predecessor.shipmentId }]);
    const pending = await composeJourneyRenewal(store, purchase.subscriptionId, "succeeded", at);
    expect(await withNativeDeliveryAlignmentRenewalAdmission(pending.input.store, store.runtime).admitDeliveryAlignment(admission))
      .toEqual({ allowed: false, state: "protected", reason: "delivery_alignment_protected", deferred: true });
    expect(await journeyCensus(store.owner)).toEqual(before);
    const alignment = createPostgresDeliveryAlignmentPort(store.runtime);
    expect(await alignment.recordArrival(arrival)).toEqual({ disposition: "aligned", nextCycleAt: "2026-10-28T12:00:00.123Z", replayed: false });
    const schedule = async () => (await store.owner.query(`SELECT status,
      to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS next
      FROM public.subscriptions WHERE id=$1`, [purchase.subscriptionId])).rows[0];
    expect(await schedule()).toEqual({ status: "active", next: extended });
    expect(Date.parse(extended)).toBeGreaterThan(Date.parse(journeyScheduledAt));
    const aligned = await journeyCensus(store.owner);
    expect(await alignment.recordArrival(arrival)).toEqual({ disposition: "aligned", nextCycleAt: "2026-10-28T12:00:00.123Z", replayed: true });
    expect(await journeyCensus(store.owner)).toEqual(aligned);
    await expect(withNativeDeliveryAlignmentRenewalAdmission(pending.input.store, store.runtime)
      .admitDeliveryAlignment({ ...admission, occurredAt: renewAt }))
      .rejects.toThrow(/^subscription_renewal_snapshot_not_found$/);
    expect(await pending.input.store.listDue(100, at)).toEqual([]);
    expect(pending.executions()).toBe(0);
    expect(aligned.commerce_orders).toHaveLength(1);
    expect(aligned.subscription_cycles).toHaveLength(1);
    expect(aligned.subscription_renewal_operations).toHaveLength(0);
    expect(aligned.fulfillment_inventory_reservations).toHaveLength(0);
    const composition = await composeJourneyRenewal(store, purchase.subscriptionId, "succeeded", renewAt);
    composition.input.store = withNativeDeliveryAlignmentRenewalAdmission(composition.input.store, store.runtime);
    expect(composition.due.scheduledAt).toBe(extended);
    const result = await runOneAutomaticSubscriptionRenewal(composition.input, composition.due, renewAt);
    expect(result).toMatchObject({ status: "succeeded", replayed: false, reason: null });
    expect(await schedule()).toEqual({ status: "active", next: "2026-11-25T12:00:00.123456Z" });
    const receipts = (await store.owner.query(`SELECT scheduled_at=$2::timestamptz AS exact,
      consumed_at IS NOT NULL AS consumed FROM public.subscription_delivery_alignment_admission_receipts
      WHERE subscription_id=$1`, [purchase.subscriptionId, extended])).rows;
    expect(receipts).toEqual([{ exact: true, consumed: true }]);
    const terminal = await journeyCensus(store.owner);
    expect(terminal.commerce_orders).toHaveLength(2);
    expect(terminal.subscription_cycles).toHaveLength(2);
    expect(terminal.subscription_renewal_operations).toHaveLength(1);
    expect(terminal.fulfillment_inventory_reservations).toHaveLength(1);
    expect(terminal.subscription_delivery_alignment_arrivals).toHaveLength(1);
    expect(await runOneAutomaticSubscriptionRenewal(composition.input, composition.due, replayAt))
      .toEqual({ ...result, status: "terminal_replay", replayed: true });
    expect(composition.executions()).toBe(1);
    expect(await journeyCensus(store.owner)).toEqual(terminal);
    answers.push({ scheduledAt: composition.due.scheduledAt, schedule: await schedule(), receipts,
      status: result.status, identityKey: result.identityKey });
  }
  expect(answers[1]).toEqual(answers[0]);
// The two-store renewal witness measured under 11 s; 90 s leaves headroom for real alignment and restore.
}, 135_000);

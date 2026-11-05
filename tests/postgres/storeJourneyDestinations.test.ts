import { afterAll, expect, it } from "vitest";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresFulfillmentShipmentSpinePort, createPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import { createPostgresPurchaseReservationPort, type PurchaseReservationInput } from "@openlup/platform/inventory";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { assertJourneyRuntime, assertJourneyWithoutIntake, captureAndActivateJourney, captureStoreJourney, draftStoreJourney,
  journeyCensus, journeyFacts, journeyPaidAt, journeyRpc, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const expires = "2026-09-01T12:30:00.123456Z", beforeExpiry = "2026-09-01T12:30:00.123455Z";

it("restores immutable destinations and exact purchase holds, then expires the same holds once", async () => {
  const source = await resources.installation("destinations-source"), target = await resources.installation("destinations-target");
  for (const store of [source, target]) await assertJourneyWithoutIntake(store);
  const pristine = await captureStoreJourney(target.owner, "destinations-pristine");
  const purchase = await captureAndActivateJourney(source, await draftStoreJourney(source));
  const registration = { idempotencyKey: "journey-destination", orderId: purchase.orderId, now: journeyPaidAt,
    address: { recipientName: "Synthetic Buyer", line1: "1 Synthetic Lane", city: "Synthetic", postalCode: "00000", country: "ZZ" } };
  const destination = await createPostgresDestinationPort(source.runtime).registerOrder(registration);
  expect(destination).toMatchObject({ clientId: purchase.clientId, revision: 1, address: registration.address });
  const stock = createPostgresFulfillmentStockSyncPort(source.runtime, { sourceKey: journeyFacts.stockSourceKey, readLocalInventoryStock: async () => [] });
  for (const line of journeyFacts.lines) await stock.recordProviderStockCurrent({ requestKey: `destination-stock:${line.sku}`, snapshot: {
    providerRef: "synthetic-stock", collectedAt: journeyPaidAt, sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot",
    skuRef: line.sku, totalQuantity: 100, forSaleQuantity: 100, reservedOrUnavailableQuantity: 0, syncRunId: "destination-stock" },
  inventoryClass: "sellable", lastSyncedAt: journeyPaidAt, staleAfter: "2027-01-01T00:00:00.000Z" });
  const items = (await source.owner.query("SELECT id,sku_id,quantity FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal", [purchase.orderId])).rows;
  const input: PurchaseReservationInput = { idempotencyKey: "journey-purchase-hold", orderId: purchase.orderId,
    stockSourceKey: journeyFacts.stockSourceKey, items: items.map(item => ({ orderItemId: item.id, skuId: item.sku_id, quantity: item.quantity })),
    paymentStatus: "succeeded", expiresAt: expires, now: journeyPaidAt, metadata: { fixture: "synthetic" } };
  const held = await createPostgresPurchaseReservationPort(source.runtime).reserveOrderItems(input);
  expect(held).toMatchObject({ status: "reserved", replayed: false,
    reservations: items.map(item => ({ orderItemId: item.id, reservationId: expect.any(String), status: "reserved", replayed: false })) });
  // Owner setup supplies an undispatched parcel for the read-only view witness;
  // destination/reservation commands and every continued read use the runtime.
  await source.owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('journey-parcel','3pl',true)");
  const parcel = await createPostgresFulfillmentShipmentSpinePort(source.owner, { portKey: "journey-parcel" })
    .createShipment({ idempotencyKey: "journey-parcel-create", orderId: purchase.orderId, requestedAt: journeyPaidAt });
  const before = await journeyCensus(source.owner);
  const packet = await captureStoreJourney(source.owner, "destination-holds");
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine })).toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  const budget = async (store: JourneyInstallation, at = journeyPaidAt) => Promise.all(journeyFacts.lines.map(line =>
    journeyRpc<{ hard_hold_quantity: number; available_quantity: number }>(store.runtime, "inventory_available_to_promise",
      [journeyFacts.stockSourceKey, line.sku, at, false])));
  const expectedHeld = journeyFacts.lines.map(line => ({ hard_hold_quantity: line.quantity, available_quantity: 100 - line.quantity }));
  const originalBudget = await budget(source);
  expect(originalBudget).toMatchObject(expectedHeld);
  for (const store of [source, target]) {
    await assertJourneyRuntime(store.runtime);
    const destinations = createPostgresDestinationPort(store.runtime), reservations = createPostgresPurchaseReservationPort(store.runtime);
    expect(await destinations.read("order", purchase.orderId)).toEqual(destination);
    expect(await destinations.registerOrder(registration)).toEqual(destination);
    expect(await journeyRpc(store.runtime, "commerce_view_shipment_destination", [parcel.shipmentId])).toEqual({ ...destination, pinned: false });
    expect(await reservations.reserveOrderItems(input)).toEqual({ ...held, replayed: true,
      reservations: held.reservations.map(row => ({ ...row, replayed: true })) });
    expect(await budget(store)).toEqual(originalBudget);
    expect((await store.owner.query("SELECT count(*)::int AS count FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1", [purchase.orderId])).rows)
      .toEqual([{ count: items.length }]);
    expect((await store.owner.query("SELECT count(*)::int AS count FROM public.commerce_destination_bindings WHERE shipment_id=$1", [parcel.shipmentId])).rows)
      .toEqual([{ count: 0 }]);
    expect(await journeyCensus(store.owner)).toEqual(before);
    await expect(destinations.registerOrder({ ...registration, address: { ...registration.address, line1: "Different Lane" } }))
      .rejects.toMatchObject({ code: "23505" });
    await expect(reservations.reserveOrderItems({ ...input, metadata: { fixture: "changed" } })).rejects.toMatchObject({ code: "23505" });
    expect(await journeyCensus(store.owner)).toEqual(before);
    expect(await reservations.expireReservations({ now: beforeExpiry })).toEqual({ contractVersion: "inventory.v0", expiredCount: 0 });
    expect(await journeyCensus(store.owner)).toEqual(before);
  }
  const results: unknown[] = [];
  for (const store of [source, target]) {
    const reservations = createPostgresPurchaseReservationPort(store.runtime);
    results.push(await reservations.expireReservations({ now: expires }));
    expect(results.at(-1)).toEqual({ contractVersion: "inventory.v0", expiredCount: items.length });
    expect(await budget(store, expires)).toMatchObject(journeyFacts.lines.map(() => ({ hard_hold_quantity: 0, available_quantity: 100 })));
    const expired = await journeyCensus(store.owner);
    expect(await reservations.expireReservations({ now: expires })).toEqual({ contractVersion: "inventory.v0", expiredCount: 0 });
    expect(await reservations.reserveOrderItems(input)).toEqual({ ...held, replayed: true,
      reservations: held.reservations.map(row => ({ ...row, status: "expired", replayed: true })) });
    expect(await createPostgresDestinationPort(store.runtime).read("order", purchase.orderId)).toEqual(destination);
    expect(await journeyCensus(store.owner)).toEqual(expired);
  }
  expect(results[1]).toEqual(results[0]);
  expect(await journeyCensus(target.owner)).toEqual(await journeyCensus(source.owner));
// The joined guest cases measured at most 10.1 s each for two stores; 90 s leaves loaded-host headroom.
}, 90_000);

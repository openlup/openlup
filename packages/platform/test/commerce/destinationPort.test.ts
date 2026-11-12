import { expect, it } from "vitest";
import { createPostgresDestinationPort, type DestinationDocument, type DestinationReadDocument } from "../../src/commerce/server/destinations/index.js";

it("preserves the destination routine contract and refuses invalid responses", async () => {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let rows: Record<string, unknown>[] = [{ result: { destinationId: "destination" } }];
  const port = createPostgresDestinationPort({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows };
  } });
  const address = { recipientName: "Example", line1: "Synthetic 1", city: "Example", postalCode: "00000", country: "XX" };
  const now = "2026-11-03T12:00:00.123456Z";
  const change = { actorId: "actor", clientId: "client", idempotencyKey: "change", subscriptionId: "subscription",
    newAddress: address, expectedVersion: 7, reason: "requested", now };
  expect(await port.registerOrder({ idempotencyKey: "register", orderId: "order", address, now })).toEqual(rows[0]!.result);
  expect(await port.read("shipment", "shipment")).toEqual(rows[0]!.result);
  expect(await port.changeShippingAddress(change)).toEqual(rows[0]!.result);
  expect(calls).toEqual([
    { sql: "SELECT public.commerce_register_order_destination($1,$2,$3,$4) AS result", values: ["register", "order", JSON.stringify(address), now] },
    { sql: "SELECT public.commerce_read_destination($1,$2) AS result", values: ["shipment", "shipment"] },
    { sql: "SELECT public.subscription_change_shipping_destination($1,$2,$3,$4,$5,$6,$7) AS result",
      values: ["actor", "client", "change", "subscription", JSON.stringify({ newAddress: address, reason: "requested" }), 7, now] },
  ]);
  for (rows of [[], [{ result: null }], [{ result: "invalid" }], [{ result: {} }, { result: {} }]]) {
    await expect(port.registerOrder({ idempotencyKey: "register", orderId: "order", address, now })).rejects.toThrow("commerce_destination_response_invalid");
    await expect(port.read("order", "order")).rejects.toThrow("commerce_destination_response_invalid");
    await expect(port.readWithSaved("order", "order")).rejects.toThrow("commerce_destination_response_invalid");
    await expect(port.changeShippingAddress(change)).rejects.toThrow("commerce_destination_response_invalid");
  }
});


it("keeps the existing typed reader and adds an explicitly saved-aware reader", async () => {
  const typed: DestinationDocument = { destinationId: "typed",revision: 1,clientId: "client",address: {
    recipientName: "Typed Recipient",line1: "Street 1",line2: null,city: "Example",postalCode: "12345",country: "ZZ",
    contactPhone: null,label: null,companyName: null,taxId: null,deliveryNotes: null,courierInstructions: null,
  } };
  let value: DestinationReadDocument = typed;
  const port = createPostgresDestinationPort({ query: async () => ({ rows: [{ result: value }] }) });
  const d = await port.read("order", "order");
  expect(d).toEqual(typed);
  value = { ...typed,address: { ...typed.address,savedAddressId: "saved",recipientName: null } };
  expect(await port.readWithSaved("order", "order")).toEqual(value);
  await expect(port.read("order", "order")).rejects.toThrow("commerce_destination_response_invalid");
});

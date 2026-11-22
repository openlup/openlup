import { expect, it } from "vitest";
import { z } from "zod";
import { createCheckoutCommandSchemas } from "@openlup/platform/commerce";
import type { CheckoutCommandV2 } from "@openlup/platform/commerce/contracts";
import { createCheckoutCommandV2Schema, destinationV2Capabilities } from "@openlup/platform/commerce/server/destinations";
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

const sku = z.literal("item");
const commandV1 = {
  version: "commerce.checkout_command.v1", idempotencyKey: " sample-key ", mode: "one_time",
  lines: [{ sku: "item", quantity: 1 }], currency: "XXX",
  customer: { firstName: " Example ", lastName: " Buyer ", email: " buyer@example.test ", phone: " 123456 " },
  shippingAddress: { street: "  Sample 1 ", postalCode: " 12345 ", city: " Sample ", country: " XX " },
};

it("checkout_v1_strict_bytes_unchanged", () => {
  const { checkoutCommandV1Schema } = createCheckoutCommandSchemas({ sku, paymentIntentStatus: z.string(), paymentAttemptStatus: z.string() });
  expect(JSON.stringify(checkoutCommandV1Schema.parse(commandV1))).toBe('{"version":"commerce.checkout_command.v1","idempotencyKey":"sample-key","mode":"one_time","lines":[{"sku":"item","quantity":1}],"customer":{"firstName":"Example","lastName":"Buyer","email":"buyer@example.test","phone":"123456"},"shippingAddress":{"street":"Sample 1","postalCode":"12345","city":"Sample","country":"XX"},"currency":"XXX"}');
  const result = checkoutCommandV1Schema.safeParse({ ...commandV1, shippingAddress: { ...commandV1.shippingAddress, line2: "2", subdivisionCode: "AA" } });
  expect(JSON.stringify(result.error?.issues)).toBe('[{"code":"unrecognized_keys","keys":["line2","subdivisionCode"],"path":["shippingAddress"],"message":"Unrecognized keys: \\"line2\\", \\"subdivisionCode\\""}]');
});

it("accepts a strict v2 destination with the incumbent checkout envelope", () => {
  const schema = createCheckoutCommandV2Schema({ sku });
  const shippingAddress = { line1: " Sample 1 ", line2: "2", subdivisionCode: "AA", postalCode: "12345", city: "Sample", countryCode: "XX" };
  const command: CheckoutCommandV2 = { ...commandV1, version: "commerce.checkout_command.v2", mode: "one_time", shippingAddress };
  expect(schema.parse(command)).toMatchObject({ idempotencyKey: "sample-key", customer: { firstName: "Example" }, shippingAddress });
  expect(schema.parse({ ...command, mode: "subscription", cadenceDays: 30 })).toMatchObject({ cadenceDays: 30 });
  const cases = [
    [commandV1, ["version"], "destination_dialect_invalid"],
    [{ ...command, shippingAddress: { ...shippingAddress, street: "Extra" } }, ["shippingAddress", "street"], "address_invalid_input"],
    [{ ...command, shippingAddress: { ...shippingAddress, line2: null } }, ["shippingAddress", "line2"], "address_invalid_input"],
    [{ ...command, shippingAddress: null }, ["shippingAddress"], "address_invalid_input"],
    [{ ...command, mode: "subscription" }, ["cadenceDays"], "address_invalid_input"],
    [{ ...command, cadenceDays: 30 }, ["cadenceDays"], "address_invalid_input"],
    [{ ...command, owner: "extra" }, ["owner"], "address_invalid_input"],
    [{ ...command, lines: [{ sku: "other", quantity: 1 }] }, ["lines", 0, "sku"], "address_invalid_input"],
  ] as const;
  for (const [input, path, refusalCode] of cases) {
    expect(schema.safeParse(input).error?.issues).toEqual([
      expect.objectContaining({ path, params: { refusalCode }, message: expect.stringMatching(/Submit|resubmit/) }),
    ]);
  }
});

it("discovers fresh destination issuance and saved address support independently", () => {
  expect(destinationV2Capabilities({ rail: "native", installed: true, issuanceEnabled: true })).toEqual({
    destinationAddressV2: { capability: "destinationAddressV2", supported: true, available: true },
    savedAddressV2: { capability: "savedAddressV2", supported: false, available: false, refusalCode: "destination_v2_unavailable" },
  });
  for (const state of [{}, { installed: true }, { installed: true, issuanceEnabled: false }, { issuanceEnabled: true }]) {
    expect(destinationV2Capabilities({ rail: "native", ...state }).destinationAddressV2).toEqual({
      capability: "destinationAddressV2", supported: true, available: false, refusalCode: "destination_v2_unavailable",
    });
  }
  const managed = destinationV2Capabilities({ rail: "managed", installed: true, issuanceEnabled: true });
  for (const [capability, state] of Object.entries(managed)) {
    expect(state).toEqual({ capability, supported: false, available: false, refusalCode: "destination_v2_unsupported_rail" });
  }
});

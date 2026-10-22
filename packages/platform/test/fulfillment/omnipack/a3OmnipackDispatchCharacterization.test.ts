import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildOmnipackDispatchCommand, buildOmnipackDispatchPayloadFromCandidate, buildSanitizedEvidence, stableDispatchHash } from "../../../src/fulfillment/omnipack/omnipackDispatchPayload.js";
import { candidate } from "./fixtures.js";

it("maps courier and locker commands with the service in both wire fields", () => {
  const input = candidate();
  expect(buildOmnipackDispatchPayloadFromCandidate(input)).toEqual({ orderNumber: "ORDER-1",
    items: [{ sku: "SKU-B", quantity: 2 }, { sku: "SKU-A", quantity: 1, lotNumber: "LOT-1", expirationDate: "2027-01-02" }],
    shippingDetails: { carrier: "EXAMPLE_COURIER", service: "EXAMPLE_COURIER", address: {
      name: "Example Recipient", street: "123 Example Street", city: "Example City", postCode: "10001", phone: "+12025550123", email: "recipient@example.test", country: "US" } },
  });
  input.deliveryContact!.selectedDelivery = { providerKind: "omnipack", carrierCode: "EXAMPLE", serviceCode: "EXAMPLE_LOCKER", deliveryKind: "parcel-locker", pickupPoint: { id: "POINT-1" } };
  expect(buildOmnipackDispatchPayloadFromCandidate(input).shippingDetails).toMatchObject({ carrier: "EXAMPLE_LOCKER", service: "EXAMPLE_LOCKER", pickUpPoint: "POINT-1" });
});
it("refuses a missing service, locker point or frozen delivery contact", () => {
  const input = candidate();
  input.deliveryContact!.selectedDelivery!.serviceCode = null;
  expect(() => buildOmnipackDispatchPayloadFromCandidate(input)).toThrow("omnipack_order_payload_missing_service");
  input.deliveryContact!.selectedDelivery = { providerKind: "omnipack", serviceCode: "EXAMPLE_LOCKER", deliveryKind: "parcel-locker" };
  expect(() => buildOmnipackDispatchPayloadFromCandidate(input)).toThrow("omnipack_order_payload_missing_pickup_point");
  input.deliveryContact = null;
  expect(() => buildOmnipackDispatchPayloadFromCandidate(input)).toThrow("omnipack_order_payload_missing_delivery_contact");
});
it("preserves the canonical hash witness and excludes recipient changes from persisted evidence", () => {
  expect(stableDispatchHash({ b: 2, nested: { y: 2, x: 1 }, a: 1 })).toBe(stableDispatchHash({ a: 1, nested: { x: 1, y: 2 }, b: 2 }));
  expect(stableDispatchHash({ items: ["A", "B"] })).not.toBe(stableDispatchHash({ items: ["B", "A"] }));
  const original = buildOmnipackDispatchCommand(candidate());
  const input = candidate(); input.deliveryContact!.contactEmail = "other@example.test"; input.deliveryContact!.line1 = "456 Example Street";
  const changed = buildOmnipackDispatchCommand(input);
  const itemInput = candidate(); itemInput.lines[0].quantity = 3;
  const serviceInput = candidate(); serviceInput.deliveryContact!.selectedDelivery!.serviceCode = "EXAMPLE_EXPRESS";
  const itemChanged = buildOmnipackDispatchCommand(itemInput);
  const serviceChanged = buildOmnipackDispatchCommand(serviceInput);
  // Frozen donor digests for these complete commands; serialize-once preserves all four.
  expect(original.requestFingerprint).toBe("cb7d16e1659b445e32ac98c866d0cda2a523c536f30c0d15eec546e1c9d5731c");
  expect(changed.requestFingerprint).toBe("aa9f1f3a0edd58d1fdea8ba54f473e81db6815d2c4002db360edeb15bb29bfef");
  expect(itemChanged.requestFingerprint).toBe("548b6a0eb508e0f40e072687d1857fd8cbe532735e7ea7d193848e76a351c3c3");
  expect(serviceChanged.requestFingerprint).toBe("9007962c5a4f583d80792d6b1b55cf707b4c73b7187f776bdde7be60fe12d4db");
  for (const commandInput of [candidate(), input, itemInput, serviceInput]) {
    expect(buildOmnipackDispatchCommand(commandInput)).toEqual(buildOmnipackDispatchCommand(commandInput));
  }
  expect(itemChanged.requestFingerprint).not.toBe(original.requestFingerprint);
  expect(serviceChanged.requestFingerprint).not.toBe(original.requestFingerprint);
  expect(original.sanitizedRequest).toEqual({ ...buildSanitizedEvidence(original.providerPayload), deliveryContactRevision: 1 });
  expect(JSON.stringify(original.sanitizedRequest)).not.toContain("recipient@example.test");
  expect(JSON.stringify(original.sanitizedRequest)).not.toContain("123 Example Street");
  expect(changed.sanitizedRequest).toEqual(original.sanitizedRequest);
  expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
  expect(original.requestFingerprint).toBe(createHash("sha256").update(original.body).digest("hex"));
});

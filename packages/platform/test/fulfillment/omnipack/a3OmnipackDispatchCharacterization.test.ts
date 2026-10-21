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
  expect(original.sanitizedRequest).toEqual({ ...buildSanitizedEvidence(original.providerPayload), deliveryContactRevision: 1 });
  expect(JSON.stringify(original.sanitizedRequest)).not.toContain("recipient@example.test");
  expect(JSON.stringify(original.sanitizedRequest)).not.toContain("123 Example Street");
  expect(changed.sanitizedRequest).toEqual(original.sanitizedRequest);
  expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
  expect(original.requestFingerprint).toBe(createHash("sha256").update(original.body).digest("hex"));
});

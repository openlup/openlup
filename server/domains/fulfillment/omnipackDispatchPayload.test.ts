import { describe, expect, it } from "vitest";
import type { OmnipackDispatchCandidate } from "./omnipackDispatchContracts.js";
import {
  buildOmnipackDispatchCommand,
  buildOmnipackDispatchPayloadFromCandidate,
  buildSanitizedEvidence,
  stableDispatchHash,
} from "./omnipackDispatchPayload.js";

describe("OmniPack dispatch payload", () => {
  it("builds the established provider payload from a candidate", () => {
    const payload = buildOmnipackDispatchPayloadFromCandidate(candidate());

    expect(payload).toEqual({
      orderNumber: "OPENLUP-1",
      items: [
        { sku: "SKU-B", quantity: 2 },
        { sku: "SKU-A", quantity: 1, lotNumber: "LOT-1", expirationDate: "2027-01-02" },
      ],
      shippingDetails: {
        carrier: "INPOST_COURIER_STANDARD",
        service: "INPOST_COURIER_STANDARD",
        address: {
          name: "Tomi Krzelewski",
          street: "Jaworowa 16/2",
          city: "Warszawa",
          postCode: "88-100",
          phone: "+486668670157",
          email: "customer@example.test",
          country: "PL",
        },
      },
    });
  });

  it("uses a stable fallback for the merchant order number", () => {
    const input = candidate();
    input.orderNumber = null;
    input.client.firstName = null;
    input.client.lastName = null;
    input.shippingAddress.label = "Office reception";

    expect(buildOmnipackDispatchPayloadFromCandidate(input)).toMatchObject({
      orderNumber: "order-1",
      shippingDetails: { address: { name: "Tomi Krzelewski" } },
    });
  });

  it("addresses the parcel to the recipient frozen on the order, not to the live client row", () => {
    // The reported defect: the buyer ordered for somebody else, then corrected
    // their own profile. Before the snapshot carried a recipient, that correction
    // re-addressed a parcel nobody re-addressed. It is also the operator case --
    // a recipient set through the OMS address command reached the snapshot and
    // stopped there.
    const input = candidate();
    if (!input.deliveryContact) throw new Error("fixture_delivery_contact_required");
    input.deliveryContact.recipientName = "Marzena Podgorna";

    expect(buildOmnipackDispatchPayloadFromCandidate(input).shippingDetails.address.name)
      .toBe("Marzena Podgorna");

    // ...and it stays that way once the client row says something else entirely.
    input.client.firstName = "Ela";
    input.client.lastName = "Podgorny";
    expect(buildOmnipackDispatchPayloadFromCandidate(input).shippingDetails.address.name)
      .toBe("Marzena Podgorna");
  });

  it("fails closed when a candidate was not normalized to a delivery contact", () => {
    const legacy = candidate();
    legacy.deliveryContact = null;
    expect(() => buildOmnipackDispatchPayloadFromCandidate(legacy))
      .toThrow("omnipack_order_payload_missing_delivery_contact");
  });

  it("keeps the persisted request evidence and fingerprint PII-free", () => {
    const original = buildOmnipackDispatchCommand(candidate());
    const changedCandidate = candidate();
    if (!changedCandidate.deliveryContact) throw new Error("fixture_delivery_contact_required");
    changedCandidate.deliveryContact.contactEmail = "different@example.test";
    changedCandidate.deliveryContact.line1 = "Changed street 99";
    const changed = buildOmnipackDispatchCommand(changedCandidate);

    expect(original.sanitizedRequest).toEqual({
      ...buildSanitizedEvidence(original.providerPayload),
      deliveryContactRevision: 1,
    });
    expect(original.sanitizedRequest).toMatchObject({
      provider: "omnipack",
      requestKind: "outbound_order",
      orderNumber: "OPENLUP-1",
      itemCount: 2,
      stockTruth: "external_stock_master_with_local_reservations",
      deliveryContactRevision: 1,
    });
    expect(JSON.stringify(original.sanitizedRequest)).not.toContain("customer@example.test");
    expect(JSON.stringify(original.sanitizedRequest)).not.toContain("Jaworowa");
    expect(changed.sanitizedRequest).toEqual(original.sanitizedRequest);
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
  });

  it("hashes record key order canonically but preserves meaningful array order", () => {
    expect(stableDispatchHash({ b: 2, nested: { y: 2, x: 1 }, a: 1 })).toBe(
      stableDispatchHash({ a: 1, nested: { x: 1, y: 2 }, b: 2 }),
    );
    expect(stableDispatchHash({ items: ["A", "B"] })).not.toBe(
      stableDispatchHash({ items: ["B", "A"] }),
    );
  });
});

function candidate(): OmnipackDispatchCandidate {
  const shippingAddress = {
    label: "Home",
    recipientName: null,
    line1: "Jaworowa 16/2",
    city: "Warszawa",
    postalCode: "88-100",
    country: "PL",
  };
  return {
    fulfillmentOrderId: "fulfillment-1",
    orderId: "order-1",
    orderNumber: "OPENLUP-1",
    status: "created",
    deliveryContact: {
      ...shippingAddress,
      schemaVersion: 1,
      source: "checkout_submission",
      revision: 1,
      recipientName: "Tomi Krzelewski",
      contactEmail: "customer@example.test",
      contactPhone: "+486668670157",
      line2: null,
      selectedDelivery: {
        providerKind: "omnipack",
        serviceCode: "INPOST_COURIER_STANDARD",
        deliveryKind: "courier",
      },
      deliveryInstructions: null,
      courierInstructions: null,
    },
    client: {
      email: "customer@example.test",
      firstName: "Tomi",
      lastName: "Krzelewski",
      phone: "+486668670157",
    },
    shippingAddress,
    deliverySelection: {
      providerKind: "omnipack",
      serviceCode: "INPOST_COURIER_STANDARD",
      deliveryKind: "courier",
    },
    lines: [
      { sku: "SKU-B", title: "B", quantity: 2, productSnapshot: { lotNumber: "  ", expiresAt: "" } },
      {
        sku: "SKU-A",
        title: "A",
        quantity: 1,
        productSnapshot: { lotCode: " LOT-1 ", expirationDate: " 2027-01-02 " },
      },
    ],
  };
}

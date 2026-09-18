import { describe, expect, it } from "vitest";
import {
  buildOmnipackOutboundOrderEvidence,
  buildOmnipackOutboundOrderPayload,
} from "../../_lib/omnipackOutboundOrderPayload.js";

describe("OmniPack outbound order payload mapper", () => {
  it("builds a courier POST /orders payload", () => {
    expect(buildOmnipackOutboundOrderPayload(baseInput())).toEqual({
      orderNumber: "OPENLUP-1001",
      items: [{ sku: "OPENLUP-TURKEY-800G", quantity: 2 }],
      shippingDetails: {
        carrier: "DPD_COURIER_STANDARD",
        service: "DPD_COURIER_STANDARD",
        address: {
          name: "Anna Kowalska",
          street: "Secretowa 1",
          city: "Warszawa",
          postCode: "00-001",
          phone: "+48123456789",
          email: "anna@example.test",
          country: "PL",
        },
      },
    });
  });

  it("builds a parcel-locker payload with pickUpPoint", () => {
    const payload = buildOmnipackOutboundOrderPayload({
      ...baseInput(),
      deliverySelection: {
        providerKind: "omnipack",
        kind: "parcel-locker",
        deliveryKind: "parcel-locker",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: {
          id: "WAW04A",
          name: "InPost WAW04A",
          address: { line1: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
        },
      },
    });

    expect(payload.shippingDetails).toMatchObject({
      carrier: "INPOST_LOCKER_STANDARD",
      service: "INPOST_LOCKER_STANDARD",
      pickUpPoint: "WAW04A",
    });
  });

  it("keeps multi-line lot evidence in the provider payload and sanitized request evidence", () => {
    const payload = buildOmnipackOutboundOrderPayload({
      ...baseInput(),
      items: [
        { sku: "OPENLUP-TURKEY-800G", quantity: 2, lotNumber: "LOT-1", expirationDate: "2027-01-31" },
        { sku: "OPENLUP-LAMB-800G", quantity: 1 },
      ],
    });

    expect(payload.items).toEqual([
      { sku: "OPENLUP-TURKEY-800G", quantity: 2, lotNumber: "LOT-1", expirationDate: "2027-01-31" },
      { sku: "OPENLUP-LAMB-800G", quantity: 1 },
    ]);
    expect(buildOmnipackOutboundOrderEvidence(payload)).toEqual({
      provider: "omnipack",
      requestKind: "outbound_order",
      orderNumber: "OPENLUP-1001",
      carrier: "DPD_COURIER_STANDARD",
      service: "DPD_COURIER_STANDARD",
      pickUpPoint: null,
      itemCount: 2,
      items: [
        { sku: "OPENLUP-TURKEY-800G", quantity: 2, lotNumber: "LOT-1", expirationDate: "2027-01-31" },
        { sku: "OPENLUP-LAMB-800G", quantity: 1, lotNumber: null, expirationDate: null },
      ],
      stockTruth: "external_stock_master_with_local_reservations",
    });
  });

  it("fails before provider calls when service evidence is missing", () => {
    expect(() => buildOmnipackOutboundOrderPayload({
      ...baseInput(),
      deliverySelection: { providerKind: "omnipack", kind: "courier", deliveryKind: "courier" },
    })).toThrow("omnipack_order_payload_missing_service");
    expect(() => buildOmnipackOutboundOrderPayload({
      ...baseInput(),
      deliverySelection: {
        providerKind: "omnipack",
        kind: "courier",
        deliveryKind: "courier",
        carrierCode: "DPD",
      },
    })).toThrow("omnipack_order_payload_missing_service");
  });

  it("fails parcel-locker dispatch without silently falling back to courier", () => {
    expect(() => buildOmnipackOutboundOrderPayload({
      ...baseInput(),
      deliverySelection: {
        providerKind: "omnipack",
        kind: "parcel-locker",
        deliveryKind: "parcel-locker",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: null,
      },
    })).toThrow("omnipack_order_payload_missing_pickup_point");
  });

  it("does not include recipient PII in sanitized evidence", () => {
    const payload = buildOmnipackOutboundOrderPayload(baseInput());
    const serialized = JSON.stringify(buildOmnipackOutboundOrderEvidence(payload));

    expect(serialized).not.toMatch(/Anna|Kowalska|anna@example\.test|\+48123456789|Secretowa|Warszawa|00-001/);
  });
});

function baseInput() {
  return {
    orderNumber: "OPENLUP-1001",
    deliverySelection: {
      providerKind: "omnipack",
      kind: "courier",
      deliveryKind: "courier",
      carrierKind: "dpd",
      carrierCode: "DPD",
      serviceCode: "DPD_COURIER_STANDARD",
    },
    recipient: { name: "Anna Kowalska", email: "anna@example.test", phone: "+48123456789" },
    address: { line1: "Secretowa 1", city: "Warszawa", postalCode: "00-001", country: "PL" },
    items: [{ sku: "OPENLUP-TURKEY-800G", quantity: 2 }],
  };
}

import { describe, expect, it } from "vitest";
import {
  buildOmnipackOutboundOrderEvidence,
  buildOmnipackOutboundOrderPayload,
  OmnipackOutboundOrderPayloadError,
} from "./omnipackOutboundOrderPayload.js";

describe("OmniPack outbound order payload helper", () => {
  it("builds provider payloads and keeps evidence free of recipient PII", () => {
    const payload = buildOmnipackOutboundOrderPayload({
      orderNumber: "OPENLUP-1001",
      deliverySelection: {
        providerKind: "omnipack",
        kind: "courier",
        carrierCode: "DPD",
        serviceCode: "DPD_COURIER_STANDARD",
      },
      recipient: { name: "Anna Kowalska", email: "anna@example.test", phone: "+48123456789" },
      address: { line1: "Secretowa 1", city: "Warszawa", postalCode: "00-001", country: "PL" },
      items: [{ sku: "OPENLUP-TURKEY-800G", quantity: 2 }],
    });

    expect(payload.shippingDetails).toMatchObject({ carrier: "DPD_COURIER_STANDARD", service: "DPD_COURIER_STANDARD" });
    expect(JSON.stringify(buildOmnipackOutboundOrderEvidence(payload))).not.toMatch(
      /Anna|Kowalska|anna@example\.test|\+48123456789|Secretowa|Warszawa|00-001/,
    );
  });

  it("passes through dictionary-driven carrier/service pairs for courier selections", () => {
    const payload = buildOmnipackOutboundOrderPayload({
      orderNumber: "OPENLUP-1002",
      deliverySelection: {
        providerKind: "omnipack",
        kind: "courier",
        carrierCode: "INPOST",
        serviceCode: "INPOST_COURIER_STANDARD",
      },
      recipient: { name: "Anna Kowalska", email: "anna@example.test", phone: "+48123456789" },
      address: { line1: "Secretowa 1", city: "Warszawa", postalCode: "00-001", country: "PL" },
      items: [{ sku: "OPENLUP-TURKEY-800G", quantity: 2 }],
    });

    expect(payload.shippingDetails).toMatchObject({
      carrier: "INPOST_COURIER_STANDARD",
      service: "INPOST_COURIER_STANDARD",
    });
    expect(payload.shippingDetails).not.toHaveProperty("pickUpPoint");
  });

  it("rejects InPost lockers without a selected pickup point", () => {
    expect(() => buildOmnipackOutboundOrderPayload({
      orderNumber: "OPENLUP-1003",
      deliverySelection: {
        providerKind: "omnipack",
        kind: "parcel-locker",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: null,
      },
      recipient: { name: "Anna Kowalska", email: "anna@example.test", phone: "+48123456789" },
      address: { line1: "Secretowa 1", city: "Warszawa", postalCode: "00-001", country: "PL" },
      items: [{ sku: "OPENLUP-TURKEY-800G", quantity: 2 }],
    })).toThrow(new OmnipackOutboundOrderPayloadError("omnipack_order_payload_missing_pickup_point"));
  });

  it("rejects missing shipping country instead of defaulting to PL", () => {
    expect(() => buildOmnipackOutboundOrderPayload({
      orderNumber: "OPENLUP-1004",
      deliverySelection: {
        providerKind: "omnipack",
        kind: "courier",
        carrierCode: "DHL",
        serviceCode: "DHL_COURIER_STANDARD",
      },
      recipient: { name: "Anna Kowalska", email: "anna@example.test", phone: "+48123456789" },
      address: { line1: "Secretowa 1", city: "Warszawa", postalCode: "00-001", country: "" },
      items: [{ sku: "OPENLUP-TURKEY-800G", quantity: 2 }],
    })).toThrow(new OmnipackOutboundOrderPayloadError("omnipack_order_payload_missing_address_country"));
  });
});

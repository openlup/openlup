import { describe, expect, it } from "vitest";
import {
  OMNIPACK_BATCH_EXPIRY_GROUP,
  OmnipackInboundPayloadError,
  buildOmnipackInboundPayload,
  type OmnipackInboundInput,
} from "./omnipackInboundPayload.js";

// A complete, valid base input; tests override single fields to assert each guard.
const BASE: OmnipackInboundInput = {
  sku: "OPENLUP-DOG-LAMB-CAN-400G",
  name: "openlup Dog Lamb Can 400g",
  ean: "5908121193005",
  quantity: 120,
  productGroup: OMNIPACK_BATCH_EXPIRY_GROUP,
  reference: "seed:fp:OPENLUP-DOG-LAMB-CAN-400G:120:LOT-2026",
  batch: { lotNumber: "LOT-2026", expirationDate: "2027-06-01" },
  supplier: "openlup",
  plannedDeliveryDate: "2026-07-01",
  trackingInfo: { carrier: "SEED", trackingNo: "SEED-LAMB" },
};

describe("buildOmnipackInboundPayload", () => {
  it("builds the full /shipments contract (shipmentNumber + supplier + plannedDeliveryDate + trackingInfo + items)", () => {
    expect(buildOmnipackInboundPayload(BASE)).toEqual({
      shipmentNumber: "seed:fp:OPENLUP-DOG-LAMB-CAN-400G:120:LOT-2026",
      supplier: "openlup",
      plannedDeliveryDate: "2026-07-01",
      trackingInfo: { carrier: "SEED", trackingNo: "SEED-LAMB" },
      items: [{
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        name: "openlup Dog Lamb Can 400g",
        ean: "5908121193005",
        quantity: 120,
        lotNumber: "LOT-2026",
        expirationDate: "2027-06-01",
      }],
    });
  });

  it("requires lotNumber + expirationDate for the BATCH_NR+EXP_DATE group", () => {
    expect(() => buildOmnipackInboundPayload({ ...BASE, batch: null })).toThrow(/batch_required_for_batch_group/);
  });

  it("omits batch fields for a STANDARD group", () => {
    const payload = buildOmnipackInboundPayload({ ...BASE, productGroup: "STANDARD", batch: null });
    expect(payload.items).toEqual([{ sku: BASE.sku, name: BASE.name, ean: BASE.ean, quantity: 120 }]);
  });

  it("requires the /shipments-mandatory fields (name, ean, supplier, plannedDeliveryDate, trackingInfo)", () => {
    expect(() => buildOmnipackInboundPayload({ ...BASE, name: " " })).toThrow(/missing_name/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, ean: "" })).toThrow(/missing_ean/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, supplier: "" })).toThrow(/missing_supplier/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, plannedDeliveryDate: "" })).toThrow(/missing_planned_delivery_date/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, trackingInfo: { carrier: "", trackingNo: "x" } })).toThrow(/missing_tracking_carrier/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, trackingInfo: { carrier: "c", trackingNo: " " } })).toThrow(/missing_tracking_no/);
  });

  it("rejects a non-positive or non-integer quantity (zero stock = no shipment, handled by the seed)", () => {
    expect(() => buildOmnipackInboundPayload({ ...BASE, quantity: 0 })).toThrow(/invalid_quantity/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, quantity: -3 })).toThrow(/invalid_quantity/);
    expect(() => buildOmnipackInboundPayload({ ...BASE, quantity: 1.5 })).toThrow(/invalid_quantity/);
  });

  it("rejects a missing reference (needed for idempotent re-posts)", () => {
    expect(() => buildOmnipackInboundPayload({ ...BASE, reference: " " })).toThrow(/missing_reference/);
  });
});

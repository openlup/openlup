import { describe, expect, it } from "vitest";
import {
  DELIVERY_SELECTION_CONTRACT_VERSION,
  deliveryOptionsResponseSchema,
  pickupPointValidationResponseSchema,
} from "./deliverySelectionContracts.js";

describe("delivery selection contracts", () => {
  it("accepts normalized OmniPack courier and InPost locker options", () => {
    expect(deliveryOptionsResponseSchema.parse({
      contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
      options: [
        {
          id: "inpost-locker-standard",
          kind: "parcel-locker",
          providerKind: "omnipack",
          carrierKind: "inpost",
          carrierCode: "INPOST_LOCKER_STANDARD",
          service: "inpost_locker_standard",
          serviceCode: "INPOST_LOCKER_STANDARD",
          label: "Paczkomat InPost",
          description: "Odbior w punkcie.",
          pickupPointRequired: true,
          addressRequired: false,
        },
        {
          id: "inpost-courier-standard",
          kind: "courier",
          providerKind: "omnipack",
          carrierKind: "inpost",
          carrierCode: "INPOST_COURIER_STANDARD",
          service: "inpost_courier_standard",
          serviceCode: "INPOST_COURIER_STANDARD",
          label: "Kurier InPost",
          description: "Dostawa pod adres.",
          pickupPointRequired: false,
          addressRequired: true,
        },
        {
          id: "dpd-courier-standard",
          kind: "courier",
          providerKind: "omnipack",
          carrierKind: "dpd",
          carrierCode: "DPD_COURIER_STANDARD",
          service: "dpd_courier_standard",
          serviceCode: "DPD_COURIER_STANDARD",
          label: "Kurier DPD",
          description: "Dostawa pod adres.",
          pickupPointRequired: false,
          addressRequired: true,
        },
      ],
    }).options).toHaveLength(3);
  });

  it("rejects OmniPack options where carrierCode differs from serviceCode", () => {
    const result = deliveryOptionsResponseSchema.safeParse({
      contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
      options: [
        {
          id: "dpd-courier-standard",
          kind: "courier",
          providerKind: "omnipack",
          carrierKind: "dpd",
          carrierCode: "DPD",
          service: "dpd_courier_standard",
          serviceCode: "DPD_COURIER_STANDARD",
          label: "Kurier DPD",
          description: "Dostawa pod adres.",
          pickupPointRequired: false,
          addressRequired: true,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("accepts the temporary DHL courier option", () => {
    expect(deliveryOptionsResponseSchema.parse({
      contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
      options: [
        {
          id: "dhl-courier-standard",
          kind: "courier",
          providerKind: "dhl",
          carrierKind: "dhl",
          carrierCode: "DHL",
          service: "dhl_courier_standard",
          serviceCode: "dhl_courier_standard",
          label: "Kurier DHL",
          description: "Dostawa pod adres.",
          pickupPointRequired: false,
          addressRequired: true,
        },
      ],
    }).options[0].carrierKind).toBe("dhl");
  });

  it("requires a pickup point when validation says valid", () => {
    const invalid = pickupPointValidationResponseSchema.safeParse({
      contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
      valid: true,
      pickupPoint: null,
    });

    expect(invalid.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { createStaticDeliverySelectionPort } from "./staticDeliverySelectionPort.js";

describe("static delivery selection port", () => {
  it("returns OmniPack-routed default delivery options", async () => {
    const port = createStaticDeliverySelectionPort();

    await expect(port.listOptions()).resolves.toMatchObject([
      {
        id: "inpost-locker-standard",
        kind: "parcel-locker",
        deliveryKind: "parcel-locker",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST_LOCKER_STANDARD",
        service: "inpost_locker_standard",
        serviceCode: "INPOST_LOCKER_STANDARD",
      },
      {
        id: "inpost-courier-standard",
        kind: "courier",
        deliveryKind: "courier",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST_COURIER_STANDARD",
        service: "inpost_courier_standard",
        serviceCode: "INPOST_COURIER_STANDARD",
      },
      {
        id: "dpd-courier-standard",
        kind: "courier",
        deliveryKind: "courier",
        providerKind: "omnipack",
        carrierKind: "dpd",
        carrierCode: "DPD_COURIER_STANDARD",
        service: "dpd_courier_standard",
        serviceCode: "DPD_COURIER_STANDARD",
      },
      {
        id: "dhl-courier-omnipack",
        kind: "courier",
        deliveryKind: "courier",
        providerKind: "omnipack",
        carrierKind: "dhl",
        carrierCode: "DHL_COURIER_STANDARD",
        service: "dhl_courier_standard",
        serviceCode: "DHL_COURIER_STANDARD",
      },
    ]);
  });

  it("keeps the direct DHL-only fallback isolated", async () => {
    const port = createStaticDeliverySelectionPort({ dhlOnly: true });

    await expect(port.listOptions()).resolves.toEqual([
      expect.objectContaining({
        id: "dhl-courier-standard",
        kind: "courier",
        deliveryKind: "courier",
        providerKind: "dhl",
        carrierKind: "dhl",
        carrierCode: "DHL",
        service: "dhl_courier_standard",
        serviceCode: "dhl_courier_standard",
      }),
    ]);
  });

  it("validates known pickup points without mutating static evidence", async () => {
    const port = createStaticDeliverySelectionPort();

    await expect(port.validatePickupPoint({ carrierKind: "inpost", pointId: " WAW01A " })).resolves.toMatchObject({
      id: "WAW01A",
      provider: "inpost",
      name: "Paczkomat WAW01A",
      address: { postalCode: "00-850", city: "Warszawa" },
    });
    await expect(port.validatePickupPoint({ carrierKind: "inpost", pointId: "missing" })).resolves.toBeNull();
  });
});

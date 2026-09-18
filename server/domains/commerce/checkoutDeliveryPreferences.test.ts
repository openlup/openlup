import { describe, expect, it } from "vitest";
import { checkoutDeliveryPreferenceInputs } from "./checkoutDeliveryPreferences.js";
import { CLIENT_ID, intent } from "./commerceCheckoutHandler.testFixtures.js";

describe("checkoutDeliveryPreferenceInputs", () => {
  it("writes subscription and any defaults from a subscription checkout locker selection", () => {
    const selectedDelivery = {
      kind: "parcel-locker" as const,
      deliveryKind: "parcel-locker" as const,
      providerKind: "omnipack" as const,
      providerRef: "WAW120H",
      carrierKind: "inpost",
      carrierCode: "INPOST",
      service: "inpost_locker_standard",
      serviceCode: "INPOST_LOCKER_STANDARD",
      pickupPoint: {
        id: "WAW120H",
        provider: "inpost",
        name: "Paczkomat WAW120H",
        address: { line1: "Lekka 3", postalCode: "01-909", city: "Warszawa", country: "PL" as const },
      },
    };

    expect(checkoutDeliveryPreferenceInputs({
      clientId: CLIENT_ID,
      checkoutKind: "subscription_initial",
      selectedDelivery,
    })).toEqual([
      expect.objectContaining({
        scope: "subscription",
        deliveryKind: "parcel-locker",
        carrierKind: "inpost",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: expect.objectContaining({ id: "WAW120H" }),
      }),
      expect.objectContaining({
        scope: "any",
        deliveryKind: "parcel-locker",
        carrierKind: "inpost",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: expect.objectContaining({ id: "WAW120H" }),
      }),
    ]);
  });

  it("writes one-time and any defaults from an InPost courier checkout selection", () => {
    expect(checkoutDeliveryPreferenceInputs({
      clientId: CLIENT_ID,
      checkoutKind: "one_time",
      selectedDelivery: {
        ...intent().selectedDelivery,
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        service: "inpost_courier_standard",
        serviceCode: "INPOST_COURIER_STANDARD",
      },
    })).toEqual([
      expect.objectContaining({
        scope: "one_time",
        deliveryKind: "courier",
        carrierKind: "inpost",
        serviceCode: "INPOST_COURIER_STANDARD",
        pickupPoint: null,
      }),
      expect.objectContaining({
        scope: "any",
        deliveryKind: "courier",
        carrierKind: "inpost",
        serviceCode: "INPOST_COURIER_STANDARD",
        pickupPoint: null,
      }),
    ]);
  });

  it("skips invalid parcel-locker selections without a pickup point", () => {
    expect(checkoutDeliveryPreferenceInputs({
      clientId: CLIENT_ID,
      checkoutKind: "subscription_initial",
      selectedDelivery: {
        ...intent("subscription").selectedDelivery,
        kind: "parcel-locker",
        deliveryKind: "parcel-locker",
        pickupPoint: null,
      },
    })).toEqual([]);
  });
});

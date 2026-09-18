import { describe, expect, it } from "vitest";
import { readDeliveryPreferences, type CustomerAccountReadStore } from "./customerSelfServiceReadModels.js";

function storeReturning(rows: Record<string, unknown>[]): CustomerAccountReadStore {
  return { readDeliveryPreferences: async () => rows } as unknown as CustomerAccountReadStore;
}

describe("readDeliveryPreferences", () => {
  it("maps a parcel-locker row to the canonical camelCase preference incl. pickupPoint", async () => {
    const result = await readDeliveryPreferences(
      storeReturning([
        {
          scope: "subscription",
          delivery_kind: "parcel-locker",
          provider_kind: "omnipack",
          carrier_kind: "inpost",
          carrier_code: "INPOST",
          service_code: "INPOST_LOCKER_STANDARD",
          pickup_point_id: "WAW01A",
          pickup_point_name: "Paczkomat WAW01A",
          pickup_point_address: { line1: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
          last_selected_at: "2026-06-08T10:00:00+00:00",
        },
      ]),
      "client-1",
    );

    expect(result).toEqual([
      {
        scope: "subscription",
        deliveryKind: "parcel-locker",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: {
          id: "WAW01A",
          name: "Paczkomat WAW01A",
          address: { line1: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
        },
        lastSelectedAt: "2026-06-08T10:00:00+00:00",
      },
    ]);
  });

  it("maps a courier row with no pickup point to pickupPoint:null", async () => {
    const [pref] = await readDeliveryPreferences(
      storeReturning([
        {
          scope: "one_time",
          delivery_kind: "courier",
          provider_kind: "omnipack",
          carrier_kind: "dpd",
          carrier_code: "DPD",
          service_code: "DPD_COURIER_STANDARD",
          pickup_point_id: null,
          pickup_point_name: null,
          pickup_point_address: null,
          last_selected_at: "2026-06-08T10:00:00+00:00",
        },
      ]),
      "client-1",
    );
    expect(pref.pickupPoint).toBeNull();
    expect(pref.deliveryKind).toBe("courier");
  });

  it("returns [] when the customer has no saved delivery preference", async () => {
    expect(await readDeliveryPreferences(storeReturning([]), "client-1")).toEqual([]);
  });
});

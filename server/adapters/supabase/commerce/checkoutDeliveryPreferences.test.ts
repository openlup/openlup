import { describe, expect, it, vi } from "vitest";
import { createSupabaseCheckoutDeliveryPreferenceStore } from "./checkoutDeliveryPreferences.js";
import { CLIENT_ID } from "../../../domains/commerce/commerceCheckoutHandler.testFixtures.js";

describe("createSupabaseCheckoutDeliveryPreferenceStore", () => {
  it("upserts checkout delivery defaults on client_id,scope", async () => {
    const db = fakeClient();
    const store = createSupabaseCheckoutDeliveryPreferenceStore(db.client);

    await store.upsertDeliveryPreference({
      clientId: CLIENT_ID,
      scope: "subscription",
      deliveryKind: "courier",
      providerKind: "omnipack",
      carrierKind: "inpost",
      carrierCode: "INPOST",
      serviceCode: "INPOST_COURIER_STANDARD",
      pickupPoint: null,
    });

    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({
      client_id: CLIENT_ID,
      scope: "subscription",
      delivery_kind: "courier",
      provider_kind: "omnipack",
      carrier_kind: "inpost",
      carrier_code: "INPOST",
      service_code: "INPOST_COURIER_STANDARD",
      pickup_point_id: null,
      source: "checkout",
    }), { onConflict: "client_id,scope" });
    expect(db.select).toHaveBeenCalledWith("id");
  });

  it("throws sanitized errors when the upsert fails", async () => {
    const db = fakeClient({ message: "db down" });
    const store = createSupabaseCheckoutDeliveryPreferenceStore(db.client);

    await expect(store.upsertDeliveryPreference({
      clientId: CLIENT_ID,
      scope: "any",
      deliveryKind: "courier",
      providerKind: "omnipack",
      carrierKind: "dpd",
      carrierCode: "DPD",
      serviceCode: "DPD_COURIER_STANDARD",
      pickupPoint: null,
    })).rejects.toThrow("db down");
  });
});

function fakeClient(error: { message?: string } | null = null) {
  const single = vi.fn().mockResolvedValue({ error });
  const select = vi.fn(() => ({ single }));
  const upsert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ upsert }));
  return {
    client: { from } as never,
    from,
    upsert,
    select,
    single,
  };
}

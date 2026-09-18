import { describe, expect, it } from "vitest";
import type { CustomerDeliveryPreferencesPort } from "./ports.js";

// ports.ts is a types-only port surface. Companion test pinning the new
// delivery-preferences port contract: list + upsert resolve to the preference
// shape (or null when no client is linked).
describe("CustomerDeliveryPreferencesPort contract", () => {
  it("accepts an implementation that lists + upserts delivery preferences", async () => {
    const port: CustomerDeliveryPreferencesPort = {
      async listDeliveryPreferences(userId) {
        return userId
          ? [{
              scope: "any",
              deliveryKind: "courier",
              providerKind: "omnipack",
              carrierKind: "dpd",
              carrierCode: "DPD",
              serviceCode: "DPD_COURIER_STANDARD",
              pickupPoint: null,
              lastSelectedAt: "2026-06-23T12:00:00.000+02:00",
            }]
          : null;
      },
      async upsertDeliveryPreference(_userId, input) {
        return {
          scope: input.scope,
          deliveryKind: input.deliveryKind,
          providerKind: input.providerKind,
          carrierKind: input.carrierKind,
          carrierCode: input.carrierCode,
          serviceCode: input.serviceCode,
          pickupPoint: input.pickupPoint,
          lastSelectedAt: "2026-06-23T12:00:00.000+02:00",
        };
      },
    };

    expect(await port.listDeliveryPreferences("user-1")).toHaveLength(1);
    expect(await port.listDeliveryPreferences("")).toBeNull();
    const upserted = await port.upsertDeliveryPreference("user-1", {
      scope: "any",
      deliveryKind: "courier",
      providerKind: "omnipack",
      carrierKind: "dpd",
      carrierCode: "DPD",
      serviceCode: "DPD_COURIER_STANDARD",
      pickupPoint: null,
    });
    expect(upserted).toMatchObject({ carrierKind: "dpd", pickupPoint: null });
  });
});

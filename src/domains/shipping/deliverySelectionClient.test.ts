import { describe, expect, it, vi } from "vitest";
import {
  DELIVERY_SELECTION_CONTRACT_VERSION,
} from "./deliverySelectionContracts.js";
import { getDeliveryOptions, validatePickupPoint } from "./deliverySelectionClient.js";

describe("delivery selection client", () => {
  it("reads delivery options from the shipping BFF", async () => {
    const fetcher = vi.fn(async () => response({
      ok: true,
      data: {
        contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
        options: [{
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
        }],
      },
    }));

    await expect(getDeliveryOptions({ fetcher })).resolves.toMatchObject({
      options: [{ id: "dpd-courier-standard", providerKind: "omnipack" }],
    });
    expect(fetcher).toHaveBeenCalledWith("/api/bff/shipping/delivery-options", expect.objectContaining({ method: "GET" }));
  });

  it("validates pickup points through the shipping BFF", async () => {
    const fetcher = vi.fn(async () => response({
      ok: true,
      data: {
        contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
        valid: true,
        pickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
      },
    }));

    await expect(validatePickupPoint({ pointId: "WAW01A", carrierKind: "inpost" }, { fetcher })).resolves.toMatchObject({
      valid: true,
      pickupPoint: { id: "WAW01A" },
    });
    expect(fetcher).toHaveBeenCalledWith("/api/bff/shipping/pickup-point-validation", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ pointId: "WAW01A", carrierKind: "inpost" }),
    }));
  });
});

function response(body: unknown): Response {
  return {
    status: 200,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

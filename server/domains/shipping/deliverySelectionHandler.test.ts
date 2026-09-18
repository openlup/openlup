import { describe, expect, it, vi } from "vitest";
import {
  createDeliveryOptionsHandler,
  createPickupPointValidationHandler,
} from "./deliverySelectionHandler.js";
import { createStaticDeliverySelectionPort } from "./staticDeliverySelectionPort.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";

describe("delivery selection handlers", () => {
  it("returns normalized delivery options", async () => {
    const res = response();
    await createDeliveryOptionsHandler(fakePort())({ method: "GET", headers: {}, query: {}, body: {} } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: { options: [{ id: "inpost-locker-standard", pickupPointRequired: true }] },
    });
  });

  it("returns only DHL courier from the static port in DHL-only mode", async () => {
    const options = await createStaticDeliverySelectionPort({ dhlOnly: true }).listOptions();

    expect(options).toEqual([
      expect.objectContaining({
        id: "dhl-courier-standard",
        kind: "courier",
        providerKind: "dhl",
        carrierKind: "dhl",
        carrierCode: "DHL",
        service: "dhl_courier_standard",
        serviceCode: "dhl_courier_standard",
        pickupPointRequired: false,
        addressRequired: true,
      }),
    ]);
  });

  it("returns OmniPack-routed InPost, DPD and DHL options by default", async () => {
    const options = await createStaticDeliverySelectionPort().listOptions();

    expect(options).toEqual([
      expect.objectContaining({
        id: "inpost-locker-standard",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST_LOCKER_STANDARD",
        serviceCode: "INPOST_LOCKER_STANDARD",
      }),
      expect.objectContaining({
        id: "inpost-courier-standard",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST_COURIER_STANDARD",
        serviceCode: "INPOST_COURIER_STANDARD",
      }),
      expect.objectContaining({
        id: "dpd-courier-standard",
        providerKind: "omnipack",
        carrierKind: "dpd",
        carrierCode: "DPD_COURIER_STANDARD",
        serviceCode: "DPD_COURIER_STANDARD",
      }),
      expect.objectContaining({
        id: "dhl-courier-omnipack",
        providerKind: "omnipack",
        carrierKind: "dhl",
        carrierCode: "DHL_COURIER_STANDARD",
        serviceCode: "DHL_COURIER_STANDARD",
      }),
    ]);
  });

  it("validates known pickup points without raw provider payloads", async () => {
    const res = response();
    await createPickupPointValidationHandler(fakePort())({
      method: "POST",
      headers: {},
      query: {},
      body: { pointId: "WAW01A", carrierKind: "inpost" },
    } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        valid: true,
        pickupPoint: {
          id: "WAW01A",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", city: "Warszawa" },
        },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("raw");
  });

  it("rejects invalid pickup point validation payloads", async () => {
    const res = response();
    await createPickupPointValidationHandler(fakePort())({
      method: "POST",
      headers: {},
      query: {},
      body: { pointId: "", carrierKind: "courier" },
    } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
  });
});

function fakePort(): DeliverySelectionPort {
  return {
    listOptions: vi.fn(async () => [{
      id: "inpost-locker-standard",
      kind: "parcel-locker" as const,
      deliveryKind: "parcel-locker" as const,
      providerKind: "omnipack" as const,
      carrierKind: "inpost" as const,
      carrierCode: "INPOST_LOCKER_STANDARD",
      service: "inpost_locker_standard" as const,
      serviceCode: "INPOST_LOCKER_STANDARD",
      label: "Paczkomat InPost",
      description: "Odbior w punkcie.",
      pickupPointRequired: true,
      addressRequired: false,
    }]),
    validatePickupPoint: vi.fn(async () => ({
      id: "WAW01A",
      provider: "inpost" as const,
      name: "Paczkomat WAW01A",
      address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" as const },
    })),
  };
}

function response() {
  const res = {
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

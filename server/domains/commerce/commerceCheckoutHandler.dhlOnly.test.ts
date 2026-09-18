import { describe, expect, it, vi } from "vitest";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import {
  createPorts,
  createResponse,
  intent,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

describe("commerce checkout BFF handler DHL-only delivery", () => {
  it("fails closed before provisioning when DHL-only checkout receives a stale parcel-locker delivery", async () => {
    const res = createResponse();
    const ports = {
      ...createPorts(),
      dhlOnlyDeliveryEnabled: () => true,
    };
    const staleIntent = {
      ...intent(),
      selectedDelivery: {
        kind: "parcel-locker",
        providerKind: "omnipack",
        providerRef: "WAW01A",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        service: "inpost_locker_standard",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
      },
    };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: staleIntent }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "BAD_REQUEST",
          details: expect.objectContaining({ reason: "dhl_only_delivery_required" }),
        }),
      }),
    );
    expect(vi.mocked(ports.persistencePort.persistIntent)).not.toHaveBeenCalled();
  });

  it("allows DHL courier delivery when DHL-only checkout is enabled", async () => {
    const res = createResponse();
    const ports = {
      ...createPorts(),
      dhlOnlyDeliveryEnabled: () => true,
    };
    const dhlIntent = {
      ...intent(),
      selectedDelivery: {
        kind: "courier",
        providerKind: "dhl",
        providerRef: null,
        carrierKind: "dhl",
        carrierCode: "DHL",
        service: "dhl_courier_standard",
        serviceCode: "dhl_courier_standard",
        pickupPoint: null,
      },
    };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: dhlIntent }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(ports.persistencePort.persistIntent)).toHaveBeenCalledTimes(1);
  });

  it("rejects OmniPack courier routing when DHL-only checkout is enabled", async () => {
    const res = createResponse();
    const ports = {
      ...createPorts(),
      dhlOnlyDeliveryEnabled: () => true,
    };
    const omnipackCourierIntent = {
      ...intent(),
      selectedDelivery: {
        kind: "courier",
        providerKind: "omnipack",
        providerRef: null,
        carrierKind: "dpd",
        carrierCode: "DPD",
        service: "dpd_courier_standard",
        serviceCode: "DPD_COURIER_STANDARD",
        pickupPoint: null,
      },
    };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: omnipackCourierIntent }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "BAD_REQUEST",
          details: expect.objectContaining({ reason: "dhl_only_delivery_required" }),
        }),
      }),
    );
    expect(vi.mocked(ports.persistencePort.persistIntent)).not.toHaveBeenCalled();
  });
});

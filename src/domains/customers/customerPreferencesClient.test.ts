import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import {
  getCustomerDeliveryPreferences,
  getCustomerPaymentPreferences,
  upsertCustomerDeliveryPreference,
  upsertCustomerPaymentPreference,
} from "./customerPreferencesClient";

const PREFERENCES = {
  contractVersion: "customer.preferences.v1" as const,
  preferences: [
    {
      scope: "subscription" as const,
      methodKind: "card" as const,
      lastSelectedAt: "2026-06-08T10:00:00+00:00",
    },
  ],
};

describe("customer payment preferences client", () => {
  beforeEach(() => {
    requestBff.mockReset();
  });

  it("GETs customer preferences with the customer bearer token", async () => {
    requestBff.mockResolvedValue(PREFERENCES);

    await expect(getCustomerPaymentPreferences("access-token-123")).resolves.toEqual(PREFERENCES);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/preferences");
    expect(options.method).toBe("GET");
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });

  it("PATCHes a sanitized preference body with the customer bearer token", async () => {
    const response = {
      contractVersion: "customer.preferences.v1" as const,
      preference: PREFERENCES.preferences[0],
    };
    requestBff.mockResolvedValue(response);

    await expect(
      upsertCustomerPaymentPreference("access-token-123", {
        scope: "subscription",
        methodKind: "blik",
      }),
    ).resolves.toEqual(response);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/preferences");
    expect(options.method).toBe("PATCH");
    expect(options.body).toEqual({ scope: "subscription", methodKind: "blik" });
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });

  it("rejects invalid payment preferences before the BFF request", async () => {
    expect(() =>
      upsertCustomerPaymentPreference("access-token-123", {
        scope: "subscription",
        methodKind: "cash",
      } as never),
    ).toThrow();

    expect(requestBff).not.toHaveBeenCalled();
  });
});

const DELIVERY = {
  contractVersion: "customer.delivery_preferences.v1" as const,
  preferences: [
    {
      scope: "subscription" as const,
      deliveryKind: "parcel-locker" as const,
      providerKind: "omnipack" as const,
      carrierKind: "inpost",
      carrierCode: "INPOST",
      serviceCode: "INPOST_LOCKER_STANDARD",
      pickupPoint: { id: "WAW01A", name: "Paczkomat WAW01A", address: null },
      lastSelectedAt: "2026-06-08T10:00:00+00:00",
    },
  ],
};

describe("customer delivery preferences client", () => {
  beforeEach(() => {
    requestBff.mockReset();
  });

  it("GETs delivery preferences from the delivery-preferences path with the bearer token", async () => {
    requestBff.mockResolvedValue(DELIVERY);

    await expect(getCustomerDeliveryPreferences("access-token-123")).resolves.toEqual(DELIVERY);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/delivery-preferences");
    expect(options.method).toBe("GET");
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });

  it("PATCHes a delivery preference body to the delivery-preferences path", async () => {
    const response = {
      contractVersion: "customer.delivery_preferences.v1" as const,
      preference: DELIVERY.preferences[0],
    };
    requestBff.mockResolvedValue(response);
    const body = {
      scope: "subscription" as const,
      deliveryKind: "parcel-locker" as const,
      providerKind: "omnipack" as const,
      carrierKind: "inpost",
      carrierCode: "INPOST",
      serviceCode: "INPOST_LOCKER_STANDARD",
      pickupPoint: { id: "WAW01A", name: "Paczkomat WAW01A", address: null },
    };

    await expect(upsertCustomerDeliveryPreference("access-token-123", body)).resolves.toEqual(response);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/delivery-preferences");
    expect(options.method).toBe("PATCH");
    expect(options.body).toEqual(body);
  });

  it("rejects invalid delivery preferences before the BFF request", async () => {
    expect(() =>
      upsertCustomerDeliveryPreference("access-token-123", {
        scope: "subscription",
        deliveryKind: "parcel-locker",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: null,
      }),
    ).toThrow("parcel-locker preference requires a pickupPoint");

    expect(requestBff).not.toHaveBeenCalled();
  });
});

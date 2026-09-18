import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerDeliveryPreference } from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerDeliveryPreferencesPort } from "./ports.js";
import { createCustomerDeliveryPreferencesHandler } from "./customerDeliveryPreferencesHandler.js";

const COURIER: CustomerDeliveryPreference = {
  scope: "any",
  deliveryKind: "courier",
  providerKind: "omnipack",
  carrierKind: "dpd",
  carrierCode: "DPD",
  serviceCode: "DPD_COURIER_STANDARD",
  pickupPoint: null,
  lastSelectedAt: "2026-06-23T12:00:00.000+02:00",
};

const LOCKER: CustomerDeliveryPreference = {
  scope: "subscription",
  deliveryKind: "parcel-locker",
  providerKind: "omnipack",
  carrierKind: "inpost",
  carrierCode: "INPOST",
  serviceCode: "INPOST_LOCKER_STANDARD",
  pickupPoint: {
    id: "WAW01A",
    name: "Paczkomat WAW01A",
    address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
  },
  lastSelectedAt: "2026-06-23T12:00:00.000+02:00",
};

describe("customer delivery preferences handler", () => {
  it("returns customer-scoped delivery preferences", async () => {
    const port = createPort({ list: [COURIER, LOCKER] });
    const res = createResponse();

    await createHandler({ port })(request("GET"), res);

    expect(port.listDeliveryPreferences).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { contractVersion: "customer.delivery_preferences.v1", preferences: [COURIER, LOCKER] },
    });
  });

  it("upserts a courier preference", async () => {
    const port = createPort({ upsert: COURIER });
    const res = createResponse();

    await createHandler({ port })(
      request("PATCH", {
        scope: "any",
        deliveryKind: "courier",
        providerKind: "omnipack",
        carrierKind: "dpd",
        carrierCode: "DPD",
        serviceCode: "DPD_COURIER_STANDARD",
      }),
      res,
    );

    expect(port.upsertDeliveryPreference).toHaveBeenCalledWith("user-1", expect.objectContaining({
      scope: "any",
      deliveryKind: "courier",
      carrierKind: "dpd",
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects a parcel-locker preference without a pickup point, missing sessions, and unlinked customers", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ upsert: LOCKER }) })(
      request("PATCH", {
        scope: "subscription",
        deliveryKind: "parcel-locker",
        providerKind: "omnipack",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
      }),
      invalid,
    );

    const unauthorized = createResponse();
    await createHandler({
      port: createPort({ list: [COURIER] }),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createHandler({ port: createPort({ list: null }) })(request("GET"), forbidden);

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps failures and unsupported methods to BFF errors", async () => {
    const authFailed = createResponse();
    await createHandler({ port: createPort({ list: [COURIER] }), auth: new Error("auth down") })(request("GET"), authFailed);

    const failed = createResponse();
    await createHandler({ port: createPort({ list: new Error("DB down") }) })(request("GET"), failed);

    const method = createResponse();
    await createHandler({ port: createPort({ list: [COURIER] }) })(request("POST"), method);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET, PATCH");
    expect(method.status).toHaveBeenCalledWith(405);
  });
});

function createHandler({
  port,
  auth = { ok: true, userId: "user-1" },
}: {
  port: CustomerDeliveryPreferencesPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerDeliveryPreferencesHandler({
    preferencesPort: port,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createPort(result: {
  list?: CustomerDeliveryPreference[] | null | Error;
  upsert?: CustomerDeliveryPreference | null | Error;
}): CustomerDeliveryPreferencesPort {
  return {
    listDeliveryPreferences: vi.fn().mockImplementation(async () => {
      if (result.list instanceof Error) throw result.list;
      return "list" in result ? result.list : [];
    }),
    upsertDeliveryPreference: vi.fn().mockImplementation(async () => {
      if (result.upsert instanceof Error) throw result.upsert;
      return "upsert" in result ? result.upsert : COURIER;
    }),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

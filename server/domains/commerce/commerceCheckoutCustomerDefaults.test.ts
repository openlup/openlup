import { describe, expect, it, vi } from "vitest";

import { CUSTOMER_DEFAULTS_SNAPSHOT_VERSION } from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import {
  readCheckoutCustomerDefaults,
  readCheckoutCustomerDefaultsOrRespond,
} from "./commerceCheckoutCustomerDefaults.js";
import { createResponse } from "./commerceCheckoutHandler.testFixtures.js";

describe("readCheckoutCustomerDefaults", () => {
  it("returns null when the optional defaults port is not configured", async () => {
    await expect(
      readCheckoutCustomerDefaults({
        port: undefined,
        clientId: "client-1",
        checkoutKind: "subscription_initial",
        recordStage: async <T>(operation: () => Promise<T>) => operation(),
      }),
    ).resolves.toBeNull();
  });

  it("loads and validates the customer defaults snapshot through the observed stage", async () => {
    const snapshot = {
      version: CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
      clientId: "11111111-1111-4111-8111-111111111111",
      payment: {
        available: true,
        scope: "subscription",
        methodKind: "card",
        source: "customer_payment_preferences",
        applied: false,
      },
      addresses: {
        hasDefaultShippingAddress: true,
        defaultShippingAddressId: "22222222-2222-4222-8222-222222222222",
        hasDefaultBillingAddress: false,
        defaultBillingAddressId: null,
        hasDefaultOrdererProfile: false,
        defaultOrdererProfileId: null,
        hasDeliveryNotes: true,
        hasCourierInstructions: false,
        source: "customer_address_profiles",
        applied: false,
      },
      redactedFields: ["shipping_address", "delivery_notes"],
    } as const;
    const getCustomerDefaultsSnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
    });
    let recordStageCalls = 0;
    const recordStage = async <T>(operation: () => Promise<T>): Promise<T> => {
      recordStageCalls += 1;
      return operation();
    };

    await expect(
      readCheckoutCustomerDefaults({
        port: { getCustomerDefaultsSnapshot },
        clientId: "11111111-1111-4111-8111-111111111111",
        checkoutKind: "subscription_initial",
        recordStage,
      }),
    ).resolves.toEqual(snapshot);
    expect(recordStageCalls).toBe(1);
    expect(getCustomerDefaultsSnapshot).toHaveBeenCalledWith({
      clientId: "11111111-1111-4111-8111-111111111111",
      checkoutKind: "subscription_initial",
    });
  });
});

describe("readCheckoutCustomerDefaultsOrRespond", () => {
  it("reads null without a port and answers nothing", async () => {
    const res = createResponse();

    await expect(readCheckoutCustomerDefaultsOrRespond({
      res,
      port: undefined,
      clientId: "client-1",
      checkoutKind: "one_time",
      recordStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toEqual({ kind: "read", snapshot: null });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("answers 503 and reports responded when the port throws", async () => {
    const res = createResponse();

    await expect(readCheckoutCustomerDefaultsOrRespond({
      res,
      port: { getCustomerDefaultsSnapshot: vi.fn().mockRejectedValue(new Error("defaults down")) },
      clientId: "client-1",
      checkoutKind: "subscription_initial",
      recordStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toEqual({ kind: "responded" });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Checkout customer defaults read failed",
        details: { feature: "checkout", stage: "customer_defaults" },
      },
    });
  });
});

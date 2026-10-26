import { describe, expect, it, vi } from "vitest";

import { CUSTOMER_DEFAULTS_SNAPSHOT_VERSION } from "../../src/commerce/index.js";
import { z } from "zod";
import { createCustomerDefaultsSnapshotSchemas } from "../../src/commerce/index.js";
import { readCheckoutCustomerDefaults as read } from "../../src/commerce/server/index.js";
const schema = createCustomerDefaultsSnapshotSchemas({ paymentPreferenceScopeSchema: z.literal("subscription"), paymentMethodKindSchema: z.literal("card") }).commerceCustomerDefaultsSnapshotSchema;
const readCheckoutCustomerDefaults = (input: Parameters<typeof read<z.output<typeof schema>>>[0]) => read(input, schema);

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

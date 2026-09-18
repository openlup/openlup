import { describe, expect, it } from "vitest";
import {
  CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
  commerceCustomerDefaultsSnapshotSchema,
} from "./customerDefaultsSnapshotContracts.js";

describe("commerce customer defaults snapshot contracts", () => {
  it("accepts hidden default hints without copying customer PII or address payloads", () => {
    const snapshot = commerceCustomerDefaultsSnapshotSchema.parse({
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
        hasDefaultOrdererProfile: true,
        defaultOrdererProfileId: "33333333-3333-4333-8333-333333333333",
        hasDeliveryNotes: true,
        hasCourierInstructions: false,
        source: "customer_address_profiles",
        applied: false,
      },
      redactedFields: ["contact", "shipping_address", "delivery_notes"],
    });

    expect(snapshot.payment.applied).toBe(false);
    expect(snapshot.addresses.hasDeliveryNotes).toBe(true);
  });

  it("rejects raw contact, address, provider and payment fields at any depth", () => {
    const base = {
      version: CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
      clientId: "11111111-1111-4111-8111-111111111111",
      payment: {
        available: false,
        scope: null,
        methodKind: null,
        source: "customer_payment_preferences",
        applied: false,
      },
      addresses: {
        hasDefaultShippingAddress: false,
        defaultShippingAddressId: null,
        hasDefaultBillingAddress: false,
        defaultBillingAddressId: null,
        hasDefaultOrdererProfile: false,
        defaultOrdererProfileId: null,
        hasDeliveryNotes: false,
        hasCourierInstructions: false,
        source: "customer_address_profiles",
        applied: false,
      },
      redactedFields: [],
    };

    for (const extra of [
      { email: "buyer@example.com" },
      { addresses: { ...base.addresses, postalCode: "00-001" } },
      { payment: { ...base.payment, card: "4111111111111111" } },
      { nested: { providerPayload: { raw: true } } },
      { nested: { courierInstructions: "Leave at door" } },
    ]) {
      expect(
        commerceCustomerDefaultsSnapshotSchema.safeParse({ ...base, ...extra }).success,
      ).toBe(false);
    }
  });
});

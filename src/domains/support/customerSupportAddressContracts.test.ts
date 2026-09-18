import { describe, expect, it } from "vitest";

import { customerSupportCommandRequestSchema } from "./customerSupportCommandContracts.js";

/**
 * The exclusion between the two ways to name a destination is structural, not a
 * cross-field rule: two closed object shapes, neither admitting the other's key.
 * These cases are what proves the structure actually excludes, because the union
 * would still typecheck if one of the shapes stopped being closed - and a payload
 * carrying both keys would then reach an authority that answers it with a raised
 * 22023 instead of a validation error the console can render beside the field.
 */
const base = {
  action: "apply_subscription_action",
  subscriptionId: "subscription-1",
  subscriptionAction: "change_shipping_address",
  expectedVersion: 3,
  idempotencyKey: "support-address-0001",
} as const;

const newAddress = {
  recipientName: "Recipient",
  line1: "Street 1",
  postalCode: "00-001",
  city: "Town",
  country: "XX",
} as const;

describe("naming where the next parcel goes", () => {
  it("accepts an address the subscriber already saved", () => {
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, payload: { shippingAddressId: "address-1" },
    }).success).toBe(true);
  });

  it("accepts one taken down during the call, with the optional fields", () => {
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, payload: { newAddress: { ...newAddress, line2: "Flat 3", contactPhone: "+48111222333" }, reason: "customer moved" },
    }).success).toBe(true);
  });

  it("refuses both at once, which is the shape no console can compose", () => {
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, payload: { shippingAddressId: "address-1", newAddress },
    }).success).toBe(false);
  });

  it("refuses a new address missing a field the address table requires", () => {
    for (const missing of ["recipientName", "line1", "postalCode", "city", "country"] as const) {
      const partial: Record<string, unknown> = { ...newAddress };
      delete partial[missing];
      expect(customerSupportCommandRequestSchema.safeParse({ ...base, payload: { newAddress: partial } }).success).toBe(false);
    }
  });

  // Whitespace is not a street. The authority trims and then length-checks, so a
  // blank that reached it would be a malformed command rather than a field error.
  it("refuses a blank street", () => {
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, payload: { newAddress: { ...newAddress, line1: "   " } },
    }).success).toBe(false);
  });

  it("refuses a key the address shape does not declare", () => {
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, payload: { newAddress: { ...newAddress, pickupPointId: "POINT-1" } },
    }).success).toBe(false);
  });

  // The cycle verbs keep their own payload untouched, and it stays closed against
  // the address keys, so the union widened the vocabulary without blurring it.
  it("keeps the reschedule payload separate from the address payload", () => {
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, subscriptionAction: "slide_next_cycle",
      payload: { newNextCycleAt: "2026-09-30T00:00:00.000Z", slideMinDays: 1 },
    }).success).toBe(true);
    expect(customerSupportCommandRequestSchema.safeParse({
      ...base, subscriptionAction: "slide_next_cycle",
      payload: { newNextCycleAt: "2026-09-30T00:00:00.000Z", shippingAddressId: "address-1" },
    }).success).toBe(false);
  });
});

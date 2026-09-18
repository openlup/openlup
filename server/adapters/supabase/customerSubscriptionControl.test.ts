import { describe, expect, it, vi } from "vitest";
import { createSupabaseCustomerSubscriptionControlPort } from "./customerSubscriptionControl.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION = "33333333-3333-4333-8333-333333333333";
const VARIANT = "44444444-4444-4444-8444-444444444444";

describe("managed customer subscription-control projection", () => {
  it("maps only the neutral lifecycle, line and recurring-total fields", async () => {
    const clientMaybeSingle = vi.fn(async () => ({ data: { id: CLIENT }, error: null }));
    const subscriptionOrder = vi.fn(async () => ({
      data: [{
        id: SUBSCRIPTION,
        status: "active",
        cadence_days: 28,
        next_cycle_at: "2026-12-01T12:00:00.000Z",
        edit_window_hours: 72,
        template_version: 3,
      }],
      error: null,
    }));
    const lineOrder = vi.fn(async () => ({
      data: [{
        subscription_id: SUBSCRIPTION,
        variant_id: VARIANT,
        qty: 2,
        sort_order: 0,
        is_addon: false,
        frozen_quote_line: { unitPrice: { amountMinor: 1200, currency: "PLN" } },
      }],
      error: null,
    }));
    const customerClient = {
      from: vi.fn((table: string) => table === "clients"
        ? { select: () => ({ eq: () => ({ maybeSingle: clientMaybeSingle }) }) }
        : { select: () => ({ eq: () => ({ order: subscriptionOrder }) }) }),
    };
    const serviceClient = {
      from: vi.fn(() => ({ select: () => ({ in: () => ({ order: lineOrder }) }) })),
    };
    const port = createSupabaseCustomerSubscriptionControlPort({
      customerClient: customerClient as never,
      serviceClient: serviceClient as never,
    });

    await expect(port.getSnapshot(USER)).resolves.toEqual({
      contractVersion: "customer.subscription_control.v1",
      subscriptions: [{
        subscriptionId: SUBSCRIPTION,
        status: "active",
        cadenceDays: 28,
        nextCycleAt: "2026-12-01T12:00:00.000Z",
        editCutoffAt: "2026-11-28T12:00:00.000Z",
        templateVersion: 3,
        recurringTotal: { amountMinor: 2400, currency: "PLN" },
        lines: [{ variantId: VARIANT, quantity: 2, isAddon: false, sortOrder: 0 }],
      }],
    });
    expect(customerClient.from).toHaveBeenCalledWith("clients");
    expect(customerClient.from).toHaveBeenCalledWith("subscriptions");
    expect(serviceClient.from).toHaveBeenCalledWith("subscription_lines");
  });

  it("returns null before managed account reads when the principal is unlinked", async () => {
    const serviceClient = { from: vi.fn() };
    const customerClient = {
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) }) }),
      })),
    };
    const port = createSupabaseCustomerSubscriptionControlPort({
      customerClient: customerClient as never,
      serviceClient: serviceClient as never,
    });
    await expect(port.getSnapshot(USER)).resolves.toBeNull();
    expect(serviceClient.from).not.toHaveBeenCalled();
  });
});

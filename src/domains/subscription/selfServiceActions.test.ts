import { describe, expect, it } from "vitest";
import { previewSubscriptionSelfServiceAction } from "./subscriptionEngine.js";
import {
  SUBSCRIPTION_PRICE_AGREEMENT_POLICY,
  subscriptionActionRequiresAcceptedQuote,
  subscriptionActionRequiresChargeTimingConfirmation,
  subscriptionSelfServiceActionImpacts,
  subscriptionSelfServiceActionSchema,
} from "./contracts.js";
import { makeSubscription, now } from "./subscriptionEngineTestHelpers.js";

describe("subscription self-service 2.0 contracts", () => {
  it("validates structured pause, cancel, and addon quantity actions", () => {
    const pause = subscriptionSelfServiceActionSchema.parse({
      action: "pause",
      idempotencyKey: "pause-idem-0001",
      subscriptionId: "00000000-0000-0000-0000-000000000001",
      pausePreset: "2_weeks",
    });
    const cancel = subscriptionSelfServiceActionSchema.parse({
      action: "cancel",
      idempotencyKey: "cancel-idem-0001",
      subscriptionId: "00000000-0000-0000-0000-000000000001",
      survey: { reasonCode: "too_expensive", acceptedSaveOfferId: "save-10" },
      saveOffer: { offerId: "save-10", kind: "pause", accepted: true },
    });
    const addon = subscriptionSelfServiceActionSchema.parse({
      action: "update_addon_quantity",
      idempotencyKey: "addon-idem-0001",
      subscriptionId: "00000000-0000-0000-0000-000000000001",
      variantId: "00000000-0000-0000-0000-000000000002",
      qty: 3,
    });
    const address = subscriptionSelfServiceActionSchema.parse({
      action: "change_shipping_address",
      idempotencyKey: "address-idem-0001",
      subscriptionId: "00000000-0000-0000-0000-000000000001",
      shippingAddressId: "00000000-0000-0000-0000-000000000003",
    });

    expect(pause).toMatchObject({ action: "pause", pausePreset: "2_weeks" });
    expect(cancel).toMatchObject({ action: "cancel", survey: { reasonCode: "too_expensive" } });
    expect(addon).toMatchObject({ action: "update_addon_quantity", qty: 3 });
    expect(address).toMatchObject({ action: "change_shipping_address" });
  });

  it("classifies quote and charge-timing sensitive actions for server-side guards", () => {
    expect(subscriptionActionRequiresAcceptedQuote("update_recipe_mix")).toBe(true);
    expect(subscriptionActionRequiresAcceptedQuote("update_bundle")).toBe(true);
    expect(subscriptionActionRequiresAcceptedQuote("resize_bundle")).toBe(true);
    expect(subscriptionActionRequiresAcceptedQuote("change_shipping_address")).toBe(false);
    expect(subscriptionActionRequiresChargeTimingConfirmation("order_now")).toBe(true);
    expect(subscriptionActionRequiresChargeTimingConfirmation("pause")).toBe(false);
    expect(subscriptionSelfServiceActionImpacts("update_package_template")).toEqual(["price", "contents"]);
    expect(subscriptionSelfServiceActionImpacts("resize_bundle")).toEqual(["price", "contents"]);
    expect(subscriptionSelfServiceActionImpacts("reactivate")).toEqual(["status", "charge_timing"]);
  });

  it("validates generic bundle actions and rejects malformed constraints", () => {
    expect(subscriptionSelfServiceActionSchema.parse({
        action: "update_bundle",
        idempotencyKey: "bundle-update-1",
        subscriptionId: "00000000-0000-0000-0000-000000000001",
        coreLines: [{ variantId: "00000000-0000-0000-0000-000000000002", qty: 4 }],
        compositionConstraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
        acceptedQuoteHash: "a".repeat(64),
    })).toMatchObject({
      action: "update_bundle",
      coreLines: [{ isAddon: false }],
    });

    expect(subscriptionSelfServiceActionSchema.parse({
      action: "resize_bundle",
        idempotencyKey: "bundle-resize-1",
        subscriptionId: "00000000-0000-0000-0000-000000000001",
        resizeLever: { kind: "planLength", value: 14 },
        cadenceDays: 14,
        compositionConstraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
        acceptedQuoteHash: "b".repeat(64),
      })).toMatchObject({ action: "resize_bundle", cadenceDays: 14 });

    expect(() =>
      subscriptionSelfServiceActionSchema.parse({
        action: "update_bundle",
        idempotencyKey: "bundle-update-envelope",
        subscriptionId: "00000000-0000-0000-0000-000000000001",
        coreLines: [{ variantId: "00000000-0000-0000-0000-000000000002", qty: 4 }],
        compositionConstraint: { kind: "petfood.kcal", version: 1, data: { value: 14 } },
        acceptedQuoteHash: "c".repeat(64),
      }),
    ).toThrow();

    expect(() =>
      subscriptionSelfServiceActionSchema.parse({
        action: "update_bundle",
        idempotencyKey: "bundle-update-bad",
        subscriptionId: "00000000-0000-0000-0000-000000000001",
        coreLines: [{ variantId: "00000000-0000-0000-0000-000000000002", qty: 4 }],
        acceptedQuoteHash: "c".repeat(64),
      }),
    ).toThrow();
  });
});

describe("subscription self-service 2.0 previews", () => {
  it("previews timed pause with a durable pause window policy", () => {
    const result = previewSubscriptionSelfServiceAction({
      subscription: makeSubscription(),
      now,
      action: {
        action: "pause",
        idempotencyKey: "pause-idem-0001",
        subscriptionId: "sub_123",
        pausePreset: "2_weeks",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultingStatus: "paused",
        pauseWindow: { preset: "2_weeks", startsAt: now, endsAt: "2026-06-18T10:00:00.000Z" },
        priceAgreementPolicy: SUBSCRIPTION_PRICE_AGREEMENT_POLICY,
      },
    });
  });

  it("rolls a lapsed paused subscription forward on resume preview", () => {
    const result = previewSubscriptionSelfServiceAction({
      subscription: makeSubscription({ status: "paused", nextCycleAt: "2026-05-01T10:00:00.000Z" }),
      now,
      action: { action: "resume", idempotencyKey: "resume-idem-1", subscriptionId: "sub_123" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { resultingStatus: "active", resultingNextCycleAt: "2026-06-12T10:00:00.000Z" },
    });
  });

  it("fails closed when future-cycle mutations would touch a locked cycle", () => {
    const result = previewSubscriptionSelfServiceAction({
      subscription: makeSubscription(),
      now,
      hasLockedUpcomingCycle: true,
      action: { action: "skip_next_cycle", idempotencyKey: "skip-idem-1", subscriptionId: "sub_123" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "locked_cycle" } });
  });

  it("previews addon quantity edits as future unlocked template changes", () => {
    const subscription = makeSubscription({
      template: {
        ...makeSubscription().template,
        lines: [
          ...makeSubscription().template.lines,
          { variant_id: "addon-1", qty: 1, sort_order: 3, is_addon: true },
        ],
      },
    });

    const result = previewSubscriptionSelfServiceAction({
      subscription,
      now: "2026-06-08T09:00:00.000Z",
      action: {
        action: "update_addon_quantity",
        idempotencyKey: "addon-idem-1",
        subscriptionId: "sub_123",
        variantId: "addon-1",
        qty: 4,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultingTemplateVersion: 2,
        effects: ["template_updates", "price_locks_until_next_edit"],
      },
    });
  });

  it("previews shipping address changes without changing template pricing", () => {
    const result = previewSubscriptionSelfServiceAction({
      subscription: makeSubscription(),
      now,
      hasOpenDunningCase: true,
      action: {
        action: "change_shipping_address",
        idempotencyKey: "address-idem-1",
        subscriptionId: "sub_123",
        shippingAddressId: "00000000-0000-0000-0000-000000000003",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultingStatus: "active",
        resultingTemplateVersion: 1,
        effects: ["shipping_address_changes", "future_unlocked_cycles_only"],
      },
    });
  });

  it("blocks shipping address changes once the upcoming cycle is locked", () => {
    const result = previewSubscriptionSelfServiceAction({
      subscription: makeSubscription(),
      now,
      hasLockedUpcomingCycle: true,
      action: {
        action: "change_shipping_address",
        idempotencyKey: "address-idem-1",
        subscriptionId: "sub_123",
        shippingAddressId: "00000000-0000-0000-0000-000000000003",
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "locked_cycle" } });
  });
});

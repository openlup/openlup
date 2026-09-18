import { describe, expect, it } from "vitest";
import type { Bundle } from "@openlup/core/bundle";
import {
  createInitialSubscriptionCheckoutModel, pauseSubscription, planSubscriptionCycle, resumeSubscription, swapTemplateLine,
  type SubscriptionEngineResult, type SubscriptionTemplateSnapshot,
} from "@openlup/core/subscription";
import { createNullCompositionRulesPort } from "./nullAdapters.js";
import { stubBrand } from "./stubBrand.js";

const template: SubscriptionTemplateSnapshot = {
  cadence_days: 14,
  currency: stubBrand.currency,
  region_code: stubBrand.regionCode,
  edit_window_hours: 24,
  size_constraint: { kind: "fixed.catalog", requiredCoreQty: 2 },
  lines: [
    { variant_id: "core-alpha", qty: 1, sort_order: 1, is_addon: false },
    { variant_id: "core-beta", qty: 1, sort_order: 2, is_addon: false },
  ],
};
const pricingSnapshot = {
  currency: stubBrand.currency,
  totalGrossMinor: 4200,
  lines: [
    { sku: "core-alpha", qty: 1, unitGrossMinor: 2100 },
    { sku: "core-beta", qty: 1, unitGrossMinor: 2100 },
  ],
};
function unwrap<T>(result: SubscriptionEngineResult<T>): T {
  if (result.ok === false) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

describe("subscription + bundle standalone smoke", () => {
  it("runs a neutral subscription lifecycle and bundle composition in memory", async () => {
    const initial = unwrap(createInitialSubscriptionCheckoutModel({
      subscriptionId: "sub-core-smoke",
      clientRef: "client-core-smoke",
      template,
      paymentMethodRef: "pm-core-smoke",
      paymentMethodKind: "card",
      firstCycleAt: "2026-08-01T10:00:00.000Z",
      now: "2026-07-01T10:00:00.000Z",
      pricingSnapshot,
      idempotencyKey: "core-smoke-initial",
      timezone: stubBrand.timezone,
    }));
    const edited = unwrap(swapTemplateLine({
      subscription: initial.subscription,
      fromVariantId: "core-beta",
      toVariantId: "core-gamma",
      now: "2026-07-15T10:00:00.000Z",
    }));
    const paused = unwrap(pauseSubscription({
      subscription: edited.subscription,
      now: "2026-07-16T10:00:00.000Z",
      reason: "operator_pause",
    }));
    const resumed = unwrap(resumeSubscription({
      subscription: paused.subscription,
      now: "2026-07-17T10:00:00.000Z",
    }));
    const cycle = unwrap(planSubscriptionCycle({
      subscription: resumed.subscription,
      cycleNumber: 2,
      now: "2026-07-18T10:00:00.000Z",
      pricingSnapshot,
      idempotencyKey: "core-smoke-cycle-2",
    }));

    expect(initial.events.map((event) => event.eventType)).toEqual([
      "subscription.created",
      "subscription.cycle_planned",
      "subscription.payment_requested",
    ]);
    expect(edited.subscription.template.lines.map((line) => line.variant_id)).toContain("core-gamma");
    expect(paused.subscription.status).toBe("paused");
    expect(resumed.subscription.status).toBe("active");
    expect(cycle.cycle.status).toBe("payment_pending");

    const port = createNullCompositionRulesPort();
    const acceptedBundle: Bundle = {
      coreLines: [
        { variantId: "core-alpha", qty: 1, isAddon: false },
        { variantId: "core-gamma", qty: 1, isAddon: false },
      ],
      addonLines: [{ variantId: "addon-delta", qty: 1, isAddon: true }],
      constraint: { kind: "fixed.catalog", version: 1, data: { requiredCoreQty: 2, rejectedVariantId: "core-rejected" } },
    };
    const rejectedBundle: Bundle = {
      ...acceptedBundle,
      coreLines: [{ variantId: "core-rejected", qty: 2, isAddon: false }],
    };

    await expect(port.validateComposition(acceptedBundle)).resolves.toEqual({ ok: true });
    await expect(port.validateComposition(rejectedBundle)).resolves.toMatchObject({
      ok: false,
      code: "variant_rejected",
    });
    const resizedBundle = await port.resizeComposition({
      coreLines: acceptedBundle.coreLines,
      constraint: acceptedBundle.constraint,
      lever: { kind: "requiredCoreQty", value: 3 },
    });

    expect(resizedBundle).toMatchObject({
      coreLines: [
        { variantId: "core-alpha", qty: 2, isAddon: false },
        { variantId: "core-gamma", qty: 1, isAddon: false },
      ],
    });
    expect(resizedBundle).not.toBeNull();
    if (!resizedBundle) return;
    await expect(port.validateComposition({
      coreLines: resizedBundle.coreLines,
      addonLines: acceptedBundle.addonLines,
      constraint: resizedBundle.constraint,
    })).resolves.toEqual({ ok: true });
  });

});

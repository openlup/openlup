import type {
  EngineSubscription,
  SubscriptionEngineResult,
  SubscriptionTemplateSnapshot,
} from "../src/subscription/index.js";

export const now = "2026-06-04T10:00:00.000Z";
export const firstCycleAt = "2026-06-10T10:00:00.000Z";
export const primaryVariantId = "core-alpha-400";
export const secondaryVariantId = "core-beta-400";
export const replacementVariantId = "core-gamma-400";
export const addonVariantId = "addon-delta-50";

export const baseTemplate: SubscriptionTemplateSnapshot = {
  cadence_days: 14,
  currency: "USD",
  region_code: "EXAMPLE",
  edit_window_hours: 24,
  size_constraint: { kind: "unit_count", target: 14 },
  lines: [
    { variant_id: primaryVariantId, qty: 7, sort_order: 1, is_addon: false },
    { variant_id: secondaryVariantId, qty: 7, sort_order: 2, is_addon: false },
  ],
};

export const pricingSnapshot = {
  currency: "USD",
  totalGrossMinor: 18760,
  lines: [
    { sku: primaryVariantId, qty: 7, unitGrossMinor: 1340 },
    { sku: secondaryVariantId, qty: 7, unitGrossMinor: 1340 },
  ],
};

export function makeSubscription(overrides: Partial<EngineSubscription> = {}): EngineSubscription {
  return {
    id: "sub-example",
    clientRef: "client-example",
    status: "active",
    template: baseTemplate,
    templateVersion: 1,
    nextCycleAt: firstCycleAt,
    paymentMethodRef: "pm-example",
    paymentMethodKind: "card",
    timezone: "UTC",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function unwrap<T>(result: SubscriptionEngineResult<T>): T {
  if (result.ok === false) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

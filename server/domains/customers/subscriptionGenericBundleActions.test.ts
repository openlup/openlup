import { describe, expect, it } from "vitest";

import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import { CustomerSubscriptionActionConflictError } from "./customerSubscriptionActionHandler.js";
import { resolveSubscriptionBundleActionProtocol } from "./subscriptionGenericBundleActions.js";

const SUB = "33333333-3333-4333-8333-333333333333";
const V1 = "44444444-4444-4444-8444-444444444441";
const V2 = "44444444-4444-4444-8444-444444444442";
const HASH = "a".repeat(64);

describe("resolveSubscriptionBundleActionProtocol", () => {
  it("rejects raw generic bundle actions while the rollout flag is off", () => {
    expect(() =>
      resolveSubscriptionBundleActionProtocol({
        action: "update_bundle",
        idempotencyKey: "generic-off-1",
        subscriptionId: SUB,
        coreLines: [{ variantId: V1, qty: 4, isAddon: false }],
        compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
        acceptedQuoteHash: HASH,
      } as CustomerSubscriptionActionRequest, false),
    ).toThrow(CustomerSubscriptionActionConflictError);
  });

  it("keeps legacy actions unchanged while the rollout flag is off", () => {
    const input = {
      action: "update_recipe_mix",
      idempotencyKey: "legacy-off-1",
      subscriptionId: SUB,
      recipes: [{ variantId: V1, qty: 4 }],
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest;

    expect(resolveSubscriptionBundleActionProtocol(input, false)).toBe(input);
  });

  it("maps legacy recipe mix to a clean generic update_bundle protocol action", () => {
    expect(resolveSubscriptionBundleActionProtocol({
      action: "update_recipe_mix",
      idempotencyKey: "legacy-mix-1",
      subscriptionId: SUB,
      recipes: [{ variantId: V1, qty: 4 }],
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest, true)).toEqual({
      action: "update_bundle",
      idempotencyKey: "legacy-mix-1",
      subscriptionId: SUB,
      coreLines: [{ variantId: V1, qty: 4 }],
      expectedTemplateVersion: undefined,
      acceptedQuoteHash: HASH,
      protocolSourceAction: "update_recipe_mix",
    });
  });

  it("maps package-template edits to update_bundle with addon replacement intent", () => {
    expect(resolveSubscriptionBundleActionProtocol({
      action: "update_package_template",
      idempotencyKey: "legacy-package-1",
      subscriptionId: SUB,
      planDays: 21,
      recipes: [{ variantId: V1, qty: 6 }],
      addons: [{ variantId: V2, qty: 2 }],
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest, true)).toMatchObject({
      action: "update_bundle",
      cadenceDays: 21,
      coreLines: [{ variantId: V1, qty: 6 }],
      addonLines: [{ variantId: V2, qty: 2, isAddon: true }],
      protocolSourceAction: "update_package_template",
    });
  });

  it("maps legacy resize actions to resize_bundle without leaking legacy field names", () => {
    expect(resolveSubscriptionBundleActionProtocol({
      action: "update_plan_length",
      idempotencyKey: "legacy-plan-1",
      subscriptionId: SUB,
      planDays: 14,
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest, true)).toEqual({
      action: "resize_bundle",
      idempotencyKey: "legacy-plan-1",
      subscriptionId: SUB,
      cadenceDays: 14,
      resizeLever: { kind: "planLength", value: 14 },
      expectedTemplateVersion: undefined,
      acceptedQuoteHash: HASH,
      protocolSourceAction: "update_plan_length",
    });
  });

  it("maps legacy portion mode to a structured resize lever", () => {
    expect(resolveSubscriptionBundleActionProtocol({
      action: "set_portion_mode",
      idempotencyKey: "legacy-portion-1",
      subscriptionId: SUB,
      portionMode: "topper",
      acceptedQuoteHash: HASH,
    } as CustomerSubscriptionActionRequest, true)).toEqual({
      action: "resize_bundle",
      idempotencyKey: "legacy-portion-1",
      subscriptionId: SUB,
      resizeLever: { kind: "portionMode", value: { portionMode: "topper" } },
      expectedTemplateVersion: undefined,
      acceptedQuoteHash: HASH,
      protocolSourceAction: "set_portion_mode",
    });
  });

});

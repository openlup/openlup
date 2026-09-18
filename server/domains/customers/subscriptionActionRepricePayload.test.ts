import { describe, expect, it, vi } from "vitest";

import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import type { SubscriptionRepricer } from "./subscriptionRepricePort.js";
import { withSubscriptionRepricePayload } from "./subscriptionActionRepricePayload.js";

const SUB = "5b000000-0000-0000-0000-0000000000c3";
const HASH = "a".repeat(64);

describe("withSubscriptionRepricePayload", () => {
  it("leaves payload unchanged when no repricer is configured", async () => {
    const payload = { reason: "customer_request" };

    await expect(withSubscriptionRepricePayload(undefined, {
      action: "pause",
      idempotencyKey: "pause-no-reprice",
      subscriptionId: "33333333-3333-4333-8333-333333333333",
      pausePreset: "2_weeks",
    }, payload)).resolves.toBe(payload);
  });

  it("injects line-edit quote rows required by the DB drift lock", async () => {
    const repricedLines = [
      { lineId: "line-1", quoteLine: { sku: "BEEF", quantity: 2 } },
    ];
    const repriceForEdit = vi.fn(async () => ({
      quoteHash: HASH,
      expectedTemplateVersion: 4,
      repricedLines,
    }));

    const payload = await withSubscriptionRepricePayload(
      { repriceForEdit } as unknown as SubscriptionRepricer,
      {
        action: "swap_recipe",
        subscriptionId: SUB,
        idempotencyKey: "idem-swap-1",
        fromVariantId: "variant-lamb",
        toVariantId: "variant-beef",
        acceptedQuoteHash: HASH,
      } as CustomerSubscriptionActionRequest,
      {
        fromVariantId: "variant-lamb",
        toVariantId: "variant-beef",
        acceptedQuoteHash: HASH,
      },
    );

    expect(repriceForEdit).toHaveBeenCalledWith({
      subscriptionId: SUB,
      action: "swap_recipe",
      payload: {
        fromVariantId: "variant-lamb",
        toVariantId: "variant-beef",
        acceptedQuoteHash: HASH,
      },
    });
    expect(payload).toMatchObject({
      fromVariantId: "variant-lamb",
      toVariantId: "variant-beef",
      acceptedQuoteHash: HASH,
      expectedTemplateVersion: 4,
      repricedLines,
    });
  });

  it("maps recipe-set addon quote rows to repricedLines for apply", async () => {
    const recipeLines = [
      { variantId: "variant-lamb", qty: 7, quoteLine: { sku: "LAMB" } },
    ];
    const addonLines = [
      { lineId: "addon-1", quoteLine: { sku: "SNACK", quantity: 1 } },
    ];
    const repriceRecipeSet = vi.fn(async () => ({
      quoteHash: HASH,
      expectedTemplateVersion: 5,
      recipeLines,
      addonLines,
    }));

    const payload = await withSubscriptionRepricePayload(
      { repriceRecipeSet } as unknown as SubscriptionRepricer,
      {
        action: "update_plan_length",
        subscriptionId: SUB,
        idempotencyKey: "idem-plan-1",
        planDays: 14,
        acceptedQuoteHash: HASH,
      } as CustomerSubscriptionActionRequest,
      {
        planDays: 14,
        acceptedQuoteHash: HASH,
      },
    );

    expect(repriceRecipeSet).toHaveBeenCalledWith({
      subscriptionId: SUB,
      action: "update_plan_length",
      payload: {
        planDays: 14,
        acceptedQuoteHash: HASH,
      },
    });
    expect(payload).toMatchObject({
      planDays: 14,
      acceptedQuoteHash: HASH,
      expectedTemplateVersion: 5,
      recipeLines,
      repricedLines: addonLines,
    });
    expect(payload).not.toHaveProperty("addonLines");
  });

  it("injects generic bundle quote rows and verbatim composition constraint for apply", async () => {
    const compositionConstraint = {
      kind: "feeding_days",
      value: 14,
      dailyKcalOverride: 300,
      futureScalar: "preserve-me",
      futureNested: { flags: [true, false], note: null },
    };
    const recipeLines = [
      { variantId: "variant-lamb", qty: 4, quoteLine: { sku: "LAMB" } },
    ];
    const addonLines = [
      { lineId: "addon-1", quoteLine: { sku: "SNACK", quantity: 1 } },
    ];
    const repriceRecipeSet = vi.fn(async () => ({
      quoteHash: HASH,
      expectedTemplateVersion: 7,
      recipeLines,
      addonLines,
      rewriteAddonLines: false,
      compositionConstraint,
    }));

    const payload = await withSubscriptionRepricePayload(
      { repriceRecipeSet } as unknown as SubscriptionRepricer,
      {
        action: "resize_bundle",
        subscriptionId: SUB,
        idempotencyKey: "idem-resize-bundle-1",
        resizeLever: { kind: "planLength", value: 14 },
        compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
        acceptedQuoteHash: HASH,
      } as CustomerSubscriptionActionRequest,
      {
        resizeLever: { kind: "planLength", value: 14 },
        acceptedQuoteHash: HASH,
      },
    );

    expect(repriceRecipeSet).toHaveBeenCalledWith({
      subscriptionId: SUB,
      action: "resize_bundle",
      payload: {
        resizeLever: { kind: "planLength", value: 14 },
        acceptedQuoteHash: HASH,
      },
      sourceAction: undefined,
    });
    expect(payload).toMatchObject({
      coreLines: recipeLines,
      repricedLines: addonLines,
      compositionConstraint,
      acceptedQuoteHash: HASH,
      expectedTemplateVersion: 7,
    });
    expect(payload.compositionConstraint).toEqual(compositionConstraint);
    expect(payload).not.toHaveProperty("compositionConstraint.data");
    expect(payload).not.toHaveProperty("recipeLines");
    expect(payload).not.toHaveProperty("cadenceDays");
  });

  it("overwrites a package-template update_bundle with the quote's effective cadence", async () => {
    const repriceRecipeSet = vi.fn(async () => ({
      quoteHash: HASH,
      expectedTemplateVersion: 7,
      recipeLines: [{ variantId: "variant-lamb", qty: 30, quoteLine: { sku: "LAMB" } }],
      addonLines: [],
      rewriteAddonLines: true,
      compositionConstraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
      cadenceDays: 30,
    }));

    const payload = await withSubscriptionRepricePayload(
      { repriceRecipeSet } as unknown as SubscriptionRepricer,
      {
        action: "update_bundle",
        subscriptionId: SUB,
        idempotencyKey: "idem-package-bundle-1",
        coreLines: [{ variantId: "variant-lamb", qty: 30, isAddon: false }],
        addonLines: [],
        cadenceDays: 14,
        acceptedQuoteHash: HASH,
        protocolSourceAction: "update_package_template",
      } as never,
      { cadenceDays: 14, acceptedQuoteHash: HASH },
    );

    expect(payload).toMatchObject({
      cadenceDays: 30,
      compositionConstraint: { kind: "feeding_days", value: 14 },
      expectedTemplateVersion: 7,
    });
  });

  it("injects package-template line snapshots and totals required by the DB drift lock", async () => {
    const recipeLines = [
      { variantId: "variant-lamb", qty: 6, quoteLine: { sku: "LAMB" } },
    ];
    const addonLines = [
      { variantId: "variant-snack", qty: 2, quoteLine: { sku: "SNACK" } },
    ];
    const currentRecurringPrice = { amountMinor: 9999, currency: "PLN" };
    const newRecurringPrice = { amountMinor: 12300, currency: "PLN" };
    const delta = { amountMinor: 2301, currency: "PLN" };
    const previewPackageEdit = vi.fn(async () => ({
      quoteHash: HASH,
      expectedTemplateVersion: 6,
      recipeLines,
      addonLines,
      currentRecurringPrice,
      newRecurringPrice,
      delta,
      cadenceDays: 30,
    }));

    const payload = await withSubscriptionRepricePayload(
      { previewPackageEdit } as unknown as SubscriptionRepricer,
      {
        action: "update_package_template",
        subscriptionId: SUB,
        idempotencyKey: "idem-package-1",
        planDays: 21,
        recipes: [{ variantId: "variant-lamb", qty: 6 }],
        addons: [{ variantId: "variant-snack", qty: 2 }],
        acceptedQuoteHash: HASH,
      } as CustomerSubscriptionActionRequest,
      {
        planDays: 21,
        recipes: [{ variantId: "variant-lamb", qty: 6 }],
        addons: [{ variantId: "variant-snack", qty: 2 }],
        acceptedQuoteHash: HASH,
      },
    );

    expect(previewPackageEdit).toHaveBeenCalledWith({
      subscriptionId: SUB,
      payload: {
        planDays: 21,
        recipes: [{ variantId: "variant-lamb", qty: 6 }],
        addons: [{ variantId: "variant-snack", qty: 2 }],
        acceptedQuoteHash: HASH,
      },
    });
    expect(payload).toMatchObject({
      planDays: 30,
      nominalPlanDays: 21,
      acceptedQuoteHash: HASH,
      expectedTemplateVersion: 6,
      recipeLines,
      addonLines,
      currentRecurringPrice,
      newRecurringPrice,
      delta,
    });
  });
});

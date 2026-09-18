import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerSubscriptionPreviewResponse } from "../../../src/domains/customers/subscriptionFacadeContracts.js";

import { attachSubscriptionPreviewQuote } from "./customerSubscriptionPreviewQuoteLedger.js";
import { CustomerSubscriptionActionConflictError } from "../../domains/customers/customerSubscriptionActionHandler.js";

describe("attachSubscriptionPreviewQuote", () => {
  it("does not record a quote when the action is blocked", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const repriceForEdit = vi.fn();
    const response = previewResponse("update_addon_quantity");

    await attachSubscriptionPreviewQuote({
      userId: "user-1",
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: { repriceForEdit } as never,
      action: {
        action: "update_addon_quantity",
        subscriptionId: "5b000000-0000-0000-0000-000000000001",
      },
      canApply: false,
      nextCycleAt: "2026-09-01T00:00:00.000Z",
      response,
    });

    expect(repriceForEdit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(response.preview.quoteHash).toBeUndefined();
  });

  it("records line-edit quote snapshots and annotates the preview response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-1" } }, error: null }));
    const repricedLines = [
      { lineId: "33333333-3333-4333-8333-333333333333", quoteLine: { sku: "SNACK", quantity: 2 } },
    ];
    const response = previewResponse("update_addon_quantity");

    try {
      await attachSubscriptionPreviewQuote({
        userId: "user-1",
        serviceClient: { rpc } as unknown as SupabaseClient,
        subscriptionRepricer: {
          repriceForEdit: vi.fn(async () => ({
            quoteHash: "b".repeat(64),
            expectedTemplateVersion: 4,
            repricedLines,
          })),
        } as never,
        action: {
          action: "update_addon_quantity",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          variantId: "22222222-2222-4222-8222-222222222222",
          qty: 2,
        },
        canApply: true,
        nextCycleAt: "2026-09-01T00:00:00.000Z",
        response,
      });

      expect(response.preview.quoteHash).toBe("b".repeat(64));
      expect(response.preview.quoteExpiresAt).toBe("2026-07-10T10:15:00.000Z");
      expect(rpc).toHaveBeenCalledWith(
        "customer_self_service_record_subscription_quote_preview",
        expect.objectContaining({
          p_auth_user_id: "user-1",
          p_action: "update_addon_quantity",
          p_quote_snapshot: { repricedLines },
          p_totals: {},
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records generic bundle quote snapshots without leaking internal protocol source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-2" } }, error: null }));
    const recipeLines = [
      { variantId: "22222222-2222-4222-8222-222222222222", qty: 4, quoteLine: { sku: "LAMB" } },
    ];
    const addonLines = [
      { lineId: "33333333-3333-4333-8333-333333333333", quoteLine: { sku: "SNACK" } },
    ];
    const response = previewResponse("update_bundle");

    try {
      await attachSubscriptionPreviewQuote({
        userId: "user-1",
        serviceClient: { rpc } as unknown as SupabaseClient,
        subscriptionRepricer: {
          repriceRecipeSet: vi.fn(async () => ({
            quoteHash: "c".repeat(64),
            expectedTemplateVersion: 4,
            recipeLines,
            addonLines,
            cadenceDays: 30,
            compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
          })),
        } as never,
        action: {
          action: "update_bundle",
          protocolSourceAction: "update_recipe_mix",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          coreLines: [{ variantId: "22222222-2222-4222-8222-222222222222", qty: 4 }],
        },
        canApply: true,
        nextCycleAt: "2026-09-01T00:00:00.000Z",
        response,
      });

      expect(rpc).toHaveBeenCalledWith(
        "customer_self_service_record_subscription_quote_preview",
        expect.objectContaining({
          p_action: "update_bundle",
          p_request_payload: {
            action: "update_bundle",
            subscriptionId: "5b000000-0000-0000-0000-000000000001",
            coreLines: [{ variantId: "22222222-2222-4222-8222-222222222222", qty: 4 }],
            cadenceDays: 30,
          },
          p_quote_snapshot: {
            recipeLines,
            addonLines,
            compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
          },
        }),
      );
      expect(response.preview.quoteHash).toBe("c".repeat(64));
    } finally {
      vi.useRealTimers();
    }
  });

  it("quote-locks effective cadence separately from the nominal legacy package plan", async () => {
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-3" } }, error: null }));
    const recipeLines = [
      { variantId: "22222222-2222-4222-8222-222222222222", qty: 30, quoteLine: { sku: "LAMB" } },
    ];
    const currentRecurringPrice = { amountMinor: 3000, currency: "PLN" };
    const newRecurringPrice = { amountMinor: 3000, currency: "PLN" };
    const response = previewResponse("update_package_template");

    await attachSubscriptionPreviewQuote({
      userId: "user-1",
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: {
        previewPackageEdit: vi.fn(async () => ({
          quoteHash: "d".repeat(64),
          expectedTemplateVersion: 4,
          recipeLines,
          addonLines: [],
          cadenceDays: 30,
          currentRecurringPrice,
          newRecurringPrice,
          delta: { amountMinor: 0, currency: "PLN" },
        })),
      } as never,
      action: {
        action: "update_package_template",
        subscriptionId: "5b000000-0000-0000-0000-000000000001",
        planDays: 14,
        recipes: [{ variantId: "22222222-2222-4222-8222-222222222222", qty: 30 }],
        addons: [],
      },
      canApply: true,
      nextCycleAt: "2026-09-01T00:00:00.000Z",
      response,
    });

    expect(rpc).toHaveBeenCalledWith(
      "customer_self_service_record_subscription_quote_preview",
      expect.objectContaining({
        p_action: "update_package_template",
        p_request_payload: expect.objectContaining({
          planDays: 30,
          nominalPlanDays: 14,
        }),
      }),
    );
  });

  it("maps a package-edit repricer failure (e.g. missing dailyKcalOverride, zero price agreements) to a client-actionable 4xx instead of a raw 5xx", async () => {
    // Regression for OBS-2: a subscription with no subscription_price_agreements row
    // (never had a package edit applied) and an incomplete size_constraint throws
    // subscription_reprice_missing_daily_kcal deep in the repricer. Previously this
    // propagated as an opaque Error, which the BFF handler swallowed into a scary
    // UPSTREAM_UNAVAILABLE 503 instead of the same BAD_REQUEST mapping the apply path
    // already applies (subscriptionActionErrorMapping.ts).
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const response = previewResponse("update_package_template");

    await expect(
      attachSubscriptionPreviewQuote({
        userId: "user-1",
        serviceClient: { rpc } as unknown as SupabaseClient,
        subscriptionRepricer: {
          previewPackageEdit: vi.fn(async () => {
            throw new Error("subscription_reprice_missing_daily_kcal");
          }),
        } as never,
        action: {
          action: "update_package_template",
          subscriptionId: "5b000000-0000-0000-0000-000000000001",
          planDays: 28,
          recipes: [],
          addons: [],
        },
        canApply: true,
        nextCycleAt: "2026-09-01T00:00:00.000Z",
        response,
      }),
    ).rejects.toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

function previewResponse(action: string): CustomerSubscriptionPreviewResponse {
  return {
    preview: {
      subscriptionId: "5b000000-0000-0000-0000-000000000001",
      action,
      canApply: true,
      blockedReason: null,
      nextCycleAt: "2026-09-01T00:00:00.000Z",
      editCutoffAt: "2026-08-31T00:00:00.000Z",
      templateVersion: 4,
    },
  };
}

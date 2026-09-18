import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordSubscriptionQuotePreview } from "./subscriptionQuotePreviewLedger.js";

describe("recordSubscriptionQuotePreview", () => {
  it("records a quote preview through the service-role RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { quotePreview: { id: "quote-1" } }, error: null }));

    await recordSubscriptionQuotePreview({ rpc } as unknown as SupabaseClient, {
      userId: "user-1",
      subscriptionId: "sub-1",
      action: "update_package_template",
      quoteHash: "a".repeat(64),
      templateVersion: 3,
      quoteExpiresAt: "2026-07-10T10:15:00.000Z",
      requestPayload: { action: "update_package_template" },
      quoteSnapshot: { recipeLines: [] },
      totals: { newRecurringPrice: { amountMinor: 6200, currency: "PLN" } },
    });

    expect(rpc).toHaveBeenCalledWith("customer_self_service_record_subscription_quote_preview", {
      p_auth_user_id: "user-1",
      p_subscription_id: "sub-1",
      p_action: "update_package_template",
      p_quote_hash: "a".repeat(64),
      p_template_version: 3,
      p_quote_expires_at: "2026-07-10T10:15:00.000Z",
      p_request_payload: { action: "update_package_template" },
      p_quote_snapshot: { recipeLines: [] },
      p_totals: { newRecurringPrice: { amountMinor: 6200, currency: "PLN" } },
      p_metadata: {
        source: "customer_subscription_preview",
        contractVersion: "customer.subscription_quote_preview.v1",
      },
    });
  });

  it("throws when the quote preview RPC rejects", async () => {
    const error = new Error("customer_self_service_stale_edit");
    const rpc = vi.fn(async () => ({ data: null, error }));

    await expect(recordSubscriptionQuotePreview({ rpc } as unknown as SupabaseClient, {
      userId: "user-1",
      subscriptionId: "sub-1",
      action: "update_package_template",
      quoteHash: "a".repeat(64),
      templateVersion: 3,
      quoteExpiresAt: "2026-07-10T10:15:00.000Z",
      requestPayload: {},
      quoteSnapshot: {},
      totals: {},
    })).rejects.toBe(error);
  });
});

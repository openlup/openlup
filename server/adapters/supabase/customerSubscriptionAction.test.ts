import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import { applyCustomerSubscriptionAction } from "./customerSubscriptionAction.js";

const SUB = "5b000000-0000-0000-0000-0000000000c3";
const USER_ID = "user-1";

describe("applyCustomerSubscriptionAction", () => {
  it("does not call the subscription writer when strict catalog repricing refuses", async () => {
    const rpc = vi.fn();
    const subscriptionRepricer = {
      repriceForEdit: vi.fn(async () => {
        throw new Error("catalog_authority_changed");
      }),
    };

    await expect(applyCustomerSubscriptionAction({
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: subscriptionRepricer as never,
      genericBundleActionsEnabled: false,
      userId: USER_ID,
      input: {
        action: "add_addon",
        subscriptionId: SUB,
        idempotencyKey: "subscription-action-add-addon-refusal",
        variantId: "archived-addon",
        qty: 1,
        acceptedQuoteHash: "accepted-hash",
      } as CustomerSubscriptionActionRequest,
    })).rejects.toBeDefined();

    expect(subscriptionRepricer.repriceForEdit).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a validated subscription action into the self-service RPC", async () => {
    const response = {
      contractVersion: "customer.self_service.v1",
      subscriptionAction: {
        subscriptionId: SUB,
        action: "pause",
        status: "applied",
        subscriptionStatus: "paused",
        nextCycleAt: null,
        templateVersion: 2,
        eventId: "11110000-0000-0000-0000-000000000001",
      },
    };
    const rpc = vi.fn(async () => ({ data: response, error: null }));

    await expect(
      applyCustomerSubscriptionAction({
        serviceClient: { rpc } as unknown as SupabaseClient,
        genericBundleActionsEnabled: false,
        userId: USER_ID,
        input: {
          action: "pause",
          subscriptionId: SUB,
          idempotencyKey: "subscription-action-pause-1",
          pausePreset: "2_weeks",
        } as CustomerSubscriptionActionRequest,
      }),
    ).resolves.toBe(response);

    expect(rpc).toHaveBeenCalledWith("customer_self_service_apply_subscription_action", {
      p_auth_user_id: USER_ID,
      p_idempotency_key: "subscription-action-pause-1",
      p_subscription_id: SUB,
      p_action: "pause",
      p_payload: { pausePreset: "2_weeks" },
      p_requested_at: expect.any(String),
    });
  });
});

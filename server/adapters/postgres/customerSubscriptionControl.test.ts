import { describe, expect, it, vi } from "vitest";
import { CustomerSubscriptionActionConflictError } from "../../domains/customers/customerSubscriptionActionHandler.js";
import { createPostgresCustomerSubscriptionControlPort } from "./customerSubscriptionControl.js";

const SUBSCRIPTION_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const QUOTE = "a".repeat(64);
const action = {
  action: "update_bundle" as const,
  idempotencyKey: "bundle-edit-123",
  subscriptionId: SUBSCRIPTION_ID,
  coreLines: [{ variantId: VARIANT_ID, qty: 2, isAddon: false as const }],
  addonLines: [],
  compositionConstraint: { kind: "fixed" },
  cadenceDays: 28,
  expectedTemplateVersion: 3,
};

describe("Postgres customer subscription control adapter", () => {
  it("maps the neutral preview request to one fixed actor routine", async () => {
    const response = {
      preview: {
        subscriptionId: SUBSCRIPTION_ID,
        action: "update_bundle",
        canApply: true,
        blockedReason: null,
        nextCycleAt: "2026-12-01T12:00:00.000Z",
        editCutoffAt: "2026-11-28T12:00:00.000Z",
        templateVersion: 3,
        quoteHash: QUOTE,
        quoteExpiresAt: "2026-08-13T12:15:00.000Z",
        currentTotal: { amountMinor: 1000, currency: "PLN" },
        newTotal: { amountMinor: 1200, currency: "PLN" },
        delta: { amountMinor: 200, currency: "PLN" },
        catalogAvailability: { status: "available", blockedReason: null },
      },
    };
    const rpc = vi.fn(async () => ({ data: response, error: null }));
    const port = createPostgresCustomerSubscriptionControlPort({ rpc });

    await expect(port.previewAction(USER_ID, { subscriptionAction: action }))
      .resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("customer_subscription_preview_bundle_as_actor", {
      p_subscription_id: SUBSCRIPTION_ID,
      p_idempotency_key: "bundle-edit-123",
      p_core_lines: JSON.stringify(action.coreLines),
      p_addon_lines: "[]",
      p_composition_constraint: JSON.stringify(action.compositionConstraint),
      p_cadence_days: 28,
      p_expected_template_version: 3,
    });
  });

  it("requires an accepted quote before apply and maps a replay response", async () => {
    const replay = {
      contractVersion: "customer.self_service.v1",
      subscriptionAction: {
        subscriptionId: SUBSCRIPTION_ID,
        action: "update_bundle",
        status: "replayed",
        subscriptionStatus: "active",
        nextCycleAt: "2026-12-01T12:00:00.000Z",
        templateVersion: 4,
        eventId: "44444444-4444-4444-8444-444444444444",
      },
    };
    const rpc = vi.fn(async () => ({ data: replay, error: null }));
    const port = createPostgresCustomerSubscriptionControlPort({ rpc });
    await expect(port.applyAction(USER_ID, action)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "subscription_edit_quote_required" },
    });
    expect(rpc).not.toHaveBeenCalled();

    await expect(port.applyAction(USER_ID, { ...action, acceptedQuoteHash: QUOTE }))
      .resolves.toEqual(replay);
    expect(rpc).toHaveBeenCalledWith(
      "customer_subscription_apply_bundle_as_actor",
      expect.objectContaining({ p_accepted_quote_hash: QUOTE }),
    );
  });

  it("refuses unsupported actions before SQL and maps bounded rail conflicts", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "subscription_edit_idempotency_conflict" },
    }));
    const port = createPostgresCustomerSubscriptionControlPort({ rpc });
    await expect(port.applyAction(USER_ID, {
      action: "resume",
      idempotencyKey: "resume-12345",
      subscriptionId: SUBSCRIPTION_ID,
    })).rejects.toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect(rpc).not.toHaveBeenCalled();

    await expect(port.previewAction(USER_ID, { subscriptionAction: action }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "subscription_edit_idempotency_conflict" },
      });
  });
});

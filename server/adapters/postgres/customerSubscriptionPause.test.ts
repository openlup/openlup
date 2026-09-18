import { describe, expect, it, vi } from "vitest";
import { CustomerSubscriptionActionConflictError } from "../../domains/customers/customerSubscriptionActionHandler.js";
import { createPostgresCustomerSubscriptionPausePort } from "./customerSubscriptionPause.js";

const SUBSCRIPTION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

describe("Postgres customer subscription pause adapter", () => {
  it("calls only the fixed-action actor wrapper and translates its platform response", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        contractVersion: "platform.subscription.lifecycle.v1",
        subscriptionAction: {
          subscriptionId: SUBSCRIPTION_ID,
          action: "pause",
          status: "applied",
          subscriptionStatus: "paused",
          nextCycleAt: "2026-09-01T12:00:00.000Z",
          eventId: "33333333-3333-4333-8333-333333333333",
        },
      },
      error: null,
    }));
    const port = createPostgresCustomerSubscriptionPausePort({ rpc });

    await expect(port.applyAction(USER_ID, {
      action: "pause",
      idempotencyKey: "pause-key-123",
      subscriptionId: SUBSCRIPTION_ID,
      pausePreset: "2_weeks",
      reason: "Holiday",
    })).resolves.toEqual({
      contractVersion: "customer.self_service.v1",
      subscriptionAction: {
        subscriptionId: SUBSCRIPTION_ID,
        action: "pause",
        status: "applied",
        subscriptionStatus: "paused",
        nextCycleAt: "2026-09-01T12:00:00.000Z",
        templateVersion: null,
        eventId: "33333333-3333-4333-8333-333333333333",
      },
    });
    expect(rpc).toHaveBeenCalledWith("customer_subscription_pause_as_actor", {
      p_subscription_id: SUBSCRIPTION_ID,
      p_idempotency_key: "pause-key-123",
      p_pause_preset: "2_weeks",
      p_reason: "Holiday",
    });
  });

  it("defaults the legacy pause shape to indefinite", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const port = createPostgresCustomerSubscriptionPausePort({ rpc });

    await expect(port.applyAction(USER_ID, {
      action: "pause",
      idempotencyKey: "pause-key-legacy",
      subscriptionId: SUBSCRIPTION_ID,
    })).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("customer_subscription_pause_as_actor", {
      p_subscription_id: SUBSCRIPTION_ID,
      p_idempotency_key: "pause-key-legacy",
      p_pause_preset: "indefinite",
      p_reason: null,
    });
  });

  it.each([
    [{ action: "resume", idempotencyKey: "resume-key-123", subscriptionId: SUBSCRIPTION_ID }, "node_postgres_pause_only"],
    [{
      action: "pause", idempotencyKey: "pause-key-survey", subscriptionId: SUBSCRIPTION_ID,
      pausePreset: "indefinite", survey: { reasonCode: "too_expensive" },
    }, "node_postgres_pause_metadata_unsupported"],
    [{
      action: "pause", idempotencyKey: "pause-key-offer", subscriptionId: SUBSCRIPTION_ID,
      pausePreset: "indefinite",
      saveOffer: { offerId: "pause-first", kind: "pause", accepted: true },
    }, "node_postgres_pause_metadata_unsupported"],
  ] as const)("refuses unsupported input before database work", async (input, reason) => {
    const rpc = vi.fn();
    const port = createPostgresCustomerSubscriptionPausePort({ rpc });

    const rejection = await port.applyAction(USER_ID, input).catch((error) => error);
    expect(rejection).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect(rejection).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid customer subscription action request",
      details: { reason },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps known lifecycle errors and leaves unknown failures upstream", async () => {
    const known = createPostgresCustomerSubscriptionPausePort({
      rpc: vi.fn(async () => ({ data: null, error: { message: "subscription_lifecycle_invalid_transition" } })),
    });
    await expect(known.applyAction(USER_ID, {
      action: "pause", idempotencyKey: "pause-key-known", subscriptionId: SUBSCRIPTION_ID,
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Customer subscription action is not allowed",
      details: { reason: "customer_subscription_transition_conflict" },
    });

    const raw = { message: "database_connection_lost" };
    const unknown = createPostgresCustomerSubscriptionPausePort({
      rpc: vi.fn(async () => ({ data: null, error: raw })),
    });
    await expect(unknown.applyAction(USER_ID, {
      action: "pause", idempotencyKey: "pause-key-unknown", subscriptionId: SUBSCRIPTION_ID,
    })).rejects.toBe(raw);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createSubscriptionDunningStorePort } from "./dunningStore.js";
describe("createSubscriptionDunningStorePort", () => {
  it("maps the claim token and fences durable completion with that token", async () => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === "subscription_dunning_claim_batch"
        ? [{
            id: "notice-1", notification_kind: "payment_failed",
            template_slug: "subscription-payment-failed-1", recipient_ref: "client-1", retry_attempt: 1,
            payload: { claimToken: "claim-1", amountMinor: 12999, currency: "USD" },
          }]
        : true,
      error: null,
    }));
    const store = createSubscriptionDunningStorePort({ rpc });
    await expect(store.claimBatch(25, 300, 6)).resolves.toEqual([
      expect.objectContaining({ id: "notice-1", claimToken: "claim-1" }),
    ]);
    await store.markSent("notice-1", "claim-1", "captured:notice-1");
    expect(rpc).toHaveBeenLastCalledWith("subscription_dunning_mark_sent", {
      p_id: "notice-1",
      p_claim_token: "claim-1",
      p_delivery_id: "captured:notice-1",
    });
  });

  // W3: `nextRetryAt` has always been persisted at insert and never read out.
  // This pins the extraction, plus the two columns the copy now needs.
  it("lifts the scheduled retry instant and subscription out of the claimed row", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        id: "notice-1",
        notification_kind: "payment_failed",
        template_slug: "subscription-payment-failed-1",
        recipient_ref: "client-1",
        subscription_id: "sub-1",
        retry_attempt: 2,
        payload: {
          claimToken: "claim-1",
          amountMinor: 12999,
          currency: "USD",
          nextRetryAt: "2026-08-11T09:00:00+00:00",
        },
      }],
      error: null,
    }));
    const store = createSubscriptionDunningStorePort({ rpc });
    await expect(store.claimBatch(25, 300, 6)).resolves.toEqual([
      expect.objectContaining({
        subscriptionId: "sub-1",
        nextRetryAt: "2026-08-11T09:00:00+00:00",
      }),
    ]);
  });

  it("keeps a legacy row claimable when the payload carries no retry instant", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        id: "notice-1",
        notification_kind: "payment_failed",
        template_slug: "subscription-payment-failed-1",
        recipient_ref: "client-1",
        retry_attempt: 1,
        payload: { claimToken: "claim-1", nextRetryAt: 1723370400 },
      }],
      error: null,
    }));
    const store = createSubscriptionDunningStorePort({ rpc });
    await expect(store.claimBatch(25, 300, 6)).resolves.toEqual([
      expect.objectContaining({ id: "notice-1", subscriptionId: null, nextRetryAt: null }),
    ]);
  });

  it("rejects a stale completion result", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
    const store = createSubscriptionDunningStorePort({ rpc });
    await expect(
      store.markResult("notice-1", "stale", "queued", "retry", "2026-08-01T11:00:00Z"),
    ).rejects.toThrow("dunning_mark_result_fenced");
  });
});

describe("createSubscriptionDunningStorePort — case id projection", () => {
  // The claim RPC is `RETURNS SETOF subscription_dunning_notifications`, so the
  // case id has always been in the returned row with no reader. The cause read
  // keys on it; this pins the projection so it cannot silently go missing.
  it("lifts the case id out of the claimed row", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        id: "notice-1",
        case_id: "case-9",
        notification_kind: "payment_failed",
        template_slug: "subscription-payment-failed-1",
        recipient_ref: "client-1",
        payload: { claimToken: "claim-1" },
      }],
      error: null,
    }));
    await expect(createSubscriptionDunningStorePort({ rpc }).claimBatch(25, 300, 6)).resolves.toEqual([
      expect.objectContaining({ caseId: "case-9" }),
    ]);
  });

  it("maps a row with no usable case id to null rather than dropping the notice", async () => {
    // A notice that cannot be attributed to a case still has to be SENT; it just
    // states no cause. Dropping it would trade a missing sentence for a missing
    // email.
    const rpc = vi.fn(async () => ({
      data: [{
        id: "notice-1",
        case_id: 7,
        notification_kind: "payment_failed",
        template_slug: "subscription-payment-failed-1",
        recipient_ref: "client-1",
        payload: { claimToken: "claim-1" },
      }],
      error: null,
    }));
    await expect(createSubscriptionDunningStorePort({ rpc }).claimBatch(25, 300, 6)).resolves.toEqual([
      expect.objectContaining({ id: "notice-1", caseId: null }),
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createSupabaseSubscriptionWinbackPort } from "./subscriptionWinback.js";

describe("createSupabaseSubscriptionWinbackPort", () => {
  it("lists due winback subscriptions through the stable RPC payload", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          subscription_id: "sub_1",
          client_id: "client_1",
          ended_at: "2026-06-20T00:00:00.000Z",
          pet_id: "pet_1",
        },
        { subscription_id: null, client_id: "client_bad" },
      ],
      error: null,
    }));
    const port = createSupabaseSubscriptionWinbackPort({ rpc, from: vi.fn() } as never);

    await expect(port.listDueForWinback(100)).resolves.toEqual([
      {
        subscriptionId: "sub_1",
        clientId: "client_1",
        endedAt: "2026-06-20T00:00:00.000Z",
        subjectReference: "pet_1",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("subscription_list_due_for_winback", { p_limit: 100 });
  });

  it("records a sent email dedupe event after the caller sends successfully", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const port = createSupabaseSubscriptionWinbackPort({
      rpc: vi.fn(),
      from: vi.fn(() => ({ insert })),
    } as never);

    await expect(port.recordMessageAccepted("sub_1", "2026-06-20T00:00:00.000Z")).resolves.toBe("recorded");
    expect(insert).toHaveBeenCalledWith({
      subscription_id: "sub_1",
      event_type: "subscription.winback.email_sent",
      idempotency_key: "winback:sub_1:2026-06-20T00:00:00.000Z",
      payload: { channel: "email", source: "subscription-winback", endedAt: "2026-06-20T00:00:00.000Z" },
    });
  });

  it("maps subscription_events unique conflicts to deduped", async () => {
    const insert = vi.fn(async () => ({ error: { code: "23505", message: "duplicate" } }));
    const port = createSupabaseSubscriptionWinbackPort({
      rpc: vi.fn(),
      from: vi.fn(() => ({ insert })),
    } as never);

    await expect(port.recordMessageAccepted("sub_1", "2026-06-20T00:00:00.000Z")).resolves.toBe("deduped");
  });
});

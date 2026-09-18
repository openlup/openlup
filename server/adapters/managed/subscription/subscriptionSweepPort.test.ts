import { describe, expect, it, vi } from "vitest";
import {
  createManagedSubscriptionSweepPort,
} from "./subscriptionSweepPort.js";

describe("createManagedSubscriptionSweepPort", () => {
  it("calls the sweep RPC with stable idempotency and maps swept rows", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { sweep: { swept: [
        { subscriptionId: "sub_1", orderId: "ord_1" },
        { subscriptionId: "sub_2", orderId: null },
      ] } },
      error: null,
    });

    await expect(
      createManagedSubscriptionSweepPort({ rpc }).sweep({ olderThan: "2026-01-01T00:00:00.000Z", limit: 50 }),
    ).resolves.toEqual([
      { subscriptionId: "sub_1", orderId: "ord_1" },
      { subscriptionId: "sub_2", orderId: null },
    ]);
    expect(rpc).toHaveBeenCalledWith("subscription_sweep_unpaid_provisional", {
      p_idempotency_prefix: "subscription-sweep-run",
      p_older_than: "2026-01-01T00:00:00.000Z",
      p_limit: 50,
    });
  });

  it("drops malformed swept rows instead of leaking invalid identifiers", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { sweep: { swept: [
        { subscriptionId: "sub_1", orderId: 42 },
        { subscriptionId: "", orderId: "ord_2" },
        null,
      ] } },
      error: null,
    });

    await expect(
      createManagedSubscriptionSweepPort({ rpc }).sweep({ olderThan: "2026-01-01T00:00:00.000Z", limit: 50 }),
    ).resolves.toEqual([{ subscriptionId: "sub_1", orderId: null }]);
  });

  it("prefixes RPC failures for the cron error mapper", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(
      createManagedSubscriptionSweepPort({ rpc }).sweep({ olderThan: "2026-01-01T00:00:00.000Z", limit: 50 }),
    ).rejects.toThrow("rpc_sweep: permission denied");
  });
});

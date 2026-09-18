import { describe, expect, it, vi } from "vitest";

import { createCommerceOmsPortViaGateway } from "./omsPortViaGateway.js";
import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";

// A fake gateway whose asService hands the work a stub OMS supabase client and records the call.
function fakeGateway(client: unknown): { gateway: DataGatewayPort; asService: ReturnType<typeof vi.fn> } {
  const asService = vi.fn(async (work: (c: unknown) => Promise<unknown>) => work(client));
  const gateway: DataGatewayPort = {
    asService: asService as unknown as DataGatewayPort["asService"],
    asActor: vi.fn() as unknown as DataGatewayPort["asActor"],
  };
  return { gateway, asService };
}

// Minimal CommerceOmsSupabaseClient stub: every from()/rpc() returns empty so the real OMS read
// queries run without throwing. listOrders with an empty queue returns immediately (no .from call).
function emptyOmsClient() {
  const builder: Record<string, unknown> = {};
  const chain = new Proxy(builder, {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable at the builder level except terminals
      if (prop === "maybeSingle" || prop === "range") {
        return () => Promise.resolve({ data: null, error: null, count: 0 });
      }
      return () => chain;
    },
  });
  return {
    from: () => chain,
    rpc: () => Promise.resolve({ data: { ok: true }, error: null }),
  };
}

describe("createCommerceOmsPortViaGateway", () => {
  it("runs OMS reads inside gateway.asService (elevated) without changing query behavior", async () => {
    const { gateway, asService } = fakeGateway(emptyOmsClient());
    const port = createCommerceOmsPortViaGateway(gateway);

    // Empty-queue list short-circuits in the read query; assert it routes through asService.
    const result = await port.listOrders({ page: 1, pageSize: 20 } as never);
    expect(result).toBeTruthy();
    expect(asService).toHaveBeenCalledTimes(1);
  });

  it("routes hold mutations through asService too", async () => {
    const { gateway, asService } = fakeGateway(emptyOmsClient());
    const port = createCommerceOmsPortViaGateway(gateway);

    await port.createHold({
      idempotencyKey: "k",
      orderId: "o",
      reason: "fraud_review",
      actorUserId: "u",
    } as never);

    expect(asService).toHaveBeenCalledTimes(1);
  });

  it("exposes the full read + hold port surface", () => {
    const { gateway } = fakeGateway(emptyOmsClient());
    const port = createCommerceOmsPortViaGateway(gateway);
    expect(typeof port.listOrders).toBe("function");
    expect(typeof port.getOrderDetail).toBe("function");
    expect(typeof port.createHold).toBe("function");
    expect(typeof port.releaseHold).toBe("function");
    expect(typeof port.addNote).toBe("function");
    expect(typeof port.updateShippingAddress).toBe("function");
    expect(typeof port.markRefunded).toBe("function");
    expect(typeof port.cancelOrder).toBe("function");
  });
});

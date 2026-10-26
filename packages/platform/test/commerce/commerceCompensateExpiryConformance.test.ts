import { afterEach, describe, expect, it, vi } from "vitest";
import { createPorts, createResponse, intent, request, createCommerceCheckoutHandler } from "./checkoutTestFixtures.js";
import { createCheckoutCompensationRpcAdapter } from "../../src/commerce/server/index.js";

afterEach(() => vi.restoreAllMocks());
function fixture(error: Error) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const calls: Array<[string, Record<string, unknown>]> = [];
  // Models the reservation port's observed readback only. SQL owns atomicity.
  let reserved = true;
  const ports = createPorts();
  const cancellations = createCheckoutCompensationRpcAdapter({
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: name === "commerce_cancel_abandoned_checkout" ? { cancelled: true } : false, error: null };
    },
  });
  ports.compensationPort = {
    releaseOrderReservations: vi.fn(async input => {
      if (!reserved) return { releasedCount: 0 };
      reserved = false;
      calls.push(["release", { ...input }]);
      return { releasedCount: 1 };
    }),
    cancelAbandonedOrder: vi.fn(cancellations.cancelAbandonedOrder),
    cancelUnstartedPromotionOrder: vi.fn(cancellations.cancelUnstartedPromotionOrder),
  };
  vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(error);
  const run = async () => {
    const res = createResponse();
    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent(), paymentProvider: "hidden_rehearsal" }), res);
    return vi.mocked(res.json).mock.calls.at(-1)?.[0];
  };
  return { calls, ports, run };
}
describe("commerce compensation and expiry conformance", () => {
  it("composes repeated stock refusal with once-only observed reservation release", async () => {
    const f = fixture(new Error("Inventory reservation conflict"));
    for (let replay = 0; replay < 2; replay++) {
      expect(await f.run()).toMatchObject({ error: { details: { reason: "stock_unavailable" } } });
    }
    expect(f.calls.map(([name]) => name)).toEqual(["release", "commerce_cancel_unstarted_promotion_order",
      "commerce_cancel_abandoned_checkout", "commerce_cancel_unstarted_promotion_order", "commerce_cancel_abandoned_checkout"]);
    expect(f.calls[0][1]).toMatchObject({ reason: "checkout_orchestration_failed" });
    expect(f.ports.compensationPort.releaseOrderReservations).toHaveBeenCalledTimes(2);
  });
  it("compensates deterministic pre-dispatch failure without inventing a payment result", async () => {
    const f = fixture(new Error("payment intent persistence failed before dispatch"));
    expect(await f.run()).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(f.calls.map(([name]) => name)).toEqual(["release", "commerce_cancel_unstarted_promotion_order", "commerce_cancel_abandoned_checkout"]);
    expect(f.ports.runtimePort.applyPaymentResult).not.toHaveBeenCalled();
    expect(f.calls.at(-1)?.[1].p_reason).toBe("checkout_orchestration_failed_before_provider_dispatch");
  });
});

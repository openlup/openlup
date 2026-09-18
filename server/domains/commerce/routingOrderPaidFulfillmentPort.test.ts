import { describe, expect, it, vi } from "vitest";
import {
  createRoutingOrderPaidFulfillmentPort,
  type OrderFulfillmentProviderKindReader,
} from "./routingOrderPaidFulfillmentPort.js";
import type { OrderPaidFulfillmentPort } from "./outboxOrderPaidFulfillmentPorts.js";

function port(label: string): OrderPaidFulfillmentPort {
  return {
    ensureFulfilledFromPaidOrder: vi.fn(async () => ({
      kind: "completed" as const,
      detail: { via: label },
    })),
  };
}

function reader(value: string | null | (() => never)): OrderFulfillmentProviderKindReader {
  return {
    readSelectedProviderKind: vi.fn(async () => {
      if (typeof value === "function") return value();
      return value;
    }),
  };
}

const args = { orderUuid: "order-1", outboxEventId: "evt-1", signal: new AbortController().signal };

describe("createRoutingOrderPaidFulfillmentPort", () => {
  it("routes an omnipack-selected order to the omnipack port", async () => {
    const omnipack = port("omnipack");
    const fallback = port("simulator");
    const routing = createRoutingOrderPaidFulfillmentPort({
      reader: reader("omnipack"),
      routes: { omnipack },
      fallback,
    });

    const result = await routing.ensureFulfilledFromPaidOrder(args);

    expect(result).toMatchObject({ detail: { via: "omnipack" } });
    expect(omnipack.ensureFulfilledFromPaidOrder).toHaveBeenCalledWith(args);
    expect(fallback.ensureFulfilledFromPaidOrder).not.toHaveBeenCalled();
  });

  it("falls back when the order carries no delivery selection", async () => {
    const omnipack = port("omnipack");
    const fallback = port("simulator");
    const routing = createRoutingOrderPaidFulfillmentPort({
      reader: reader(null),
      routes: { omnipack },
      fallback,
    });

    const result = await routing.ensureFulfilledFromPaidOrder(args);

    expect(result).toMatchObject({ detail: { via: "simulator" } });
    expect(omnipack.ensureFulfilledFromPaidOrder).not.toHaveBeenCalled();
  });

  it("falls back when the selected providerKind has no registered route", async () => {
    const fallback = port("simulator");
    const routing = createRoutingOrderPaidFulfillmentPort({
      reader: reader("inpost"),
      routes: { omnipack: port("omnipack") },
      fallback,
    });

    expect(await routing.ensureFulfilledFromPaidOrder(args)).toMatchObject({ detail: { via: "simulator" } });
    expect(fallback.ensureFulfilledFromPaidOrder).toHaveBeenCalledOnce();
  });

  it("snoozes instead of falling back when a fail-closed provider has no registered route", async () => {
    const fallback = port("simulator");
    const routing = createRoutingOrderPaidFulfillmentPort({
      reader: reader("omnipack"),
      routes: {},
      failClosedProviderKinds: ["omnipack"],
      failClosedReasons: { omnipack: "omnipack_selected_but_not_ready:omnipack_dispatch_disabled" },
      fallback,
    });

    const result = await routing.ensureFulfilledFromPaidOrder(args);

    expect(result).toMatchObject({
      kind: "snooze",
      reason: "omnipack_selected_but_not_ready:omnipack_dispatch_disabled",
    });
    expect(fallback.ensureFulfilledFromPaidOrder).not.toHaveBeenCalled();
  });

  it("truncates long fail-closed reasons", async () => {
    const routing = createRoutingOrderPaidFulfillmentPort({
      reader: reader("omnipack"),
      routes: {},
      failClosedProviderKinds: ["omnipack"],
      failClosedReasons: { omnipack: `omnipack_selected_but_not_ready:${"x".repeat(400)}` },
      fallback: port("simulator"),
    });

    const result = await routing.ensureFulfilledFromPaidOrder(args);

    expect(result.kind).toBe("snooze");
    expect("reason" in result ? result.reason.length : 0).toBeLessThanOrEqual(303);
  });

  it("returns retryable (does not silently fall back) when the reader throws", async () => {
    const fallback = port("simulator");
    const routing = createRoutingOrderPaidFulfillmentPort({
      reader: reader(() => {
        throw new Error("db down");
      }),
      routes: { omnipack: port("omnipack") },
      fallback,
    });

    const result = await routing.ensureFulfilledFromPaidOrder(args);

    expect(result).toMatchObject({ kind: "retryable" });
    expect(result).toHaveProperty("reason", expect.stringContaining("routing_provider_read_failed"));
    expect(fallback.ensureFulfilledFromPaidOrder).not.toHaveBeenCalled();
  });
});

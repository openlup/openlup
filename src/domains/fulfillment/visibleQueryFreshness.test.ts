import { describe, expect, it, vi } from "vitest";
import {
  FULFILLMENT_VISIBLE_REFRESH_MS,
  isBlockingVisibleQueryError,
  visibleFulfillmentRefreshInterval,
} from "./types.js";

describe("visible fulfillment query freshness", () => {
  it("refreshes a visible recoverable fulfillment every ten seconds", () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(visibleFulfillmentRefreshInterval(["exception"])).toBe(FULFILLMENT_VISIBLE_REFRESH_MS);
    expect(visibleFulfillmentRefreshInterval(["packed"])).toBe(FULFILLMENT_VISIBLE_REFRESH_MS);
  });

  it("stops while hidden and after every durable fulfillment is terminal", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(visibleFulfillmentRefreshInterval(["exception"])).toBe(false);
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(visibleFulfillmentRefreshInterval(["delivered", "cancelled"])).toBe(false);
    expect(visibleFulfillmentRefreshInterval([null, undefined])).toBe(false);
  });

  it("shows read errors only when there is no last good query data", () => {
    expect(isBlockingVisibleQueryError(true, undefined)).toBe(true);
    expect(isBlockingVisibleQueryError(true, { orderId: "order-1" })).toBe(false);
    expect(isBlockingVisibleQueryError(false, undefined)).toBe(false);
  });
});

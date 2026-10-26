import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseOfferAvailabilityPort, createSupabaseOfferAvailabilityPortFromClient } from "./offerAvailability.js";

const STOCK_PROVIDER = "omnipack";

const binding = vi.hoisted(() => {
  const port = { getAvailability: vi.fn() };
  return { port, create: vi.fn<(...args: Parameters<typeof import("@openlup/platform/commerce/server").createOfferAvailabilityPort>) => typeof port>(() => port) };
});
vi.mock("@openlup/platform/commerce/server", () => ({ createOfferAvailabilityPort: binding.create }));
beforeEach(() => vi.clearAllMocks());

describe("reference availability binding", () => {
  it("delegates the client, clock and threshold with only the selected provider policy", () => {
    const client = { from: vi.fn() }, now = () => new Date(0);
    expect(createSupabaseOfferAvailabilityPort(client as never, { now, lowStockThreshold: 7 })).toBe(binding.port);
    expect(binding.create).toHaveBeenCalledExactlyOnceWith(client, { now, lowStockThreshold: 7, isStockProvider: expect.any(Function) });
    const predicate = binding.create.mock.calls[0]?.[1].isStockProvider;
    expect(predicate(STOCK_PROVIDER)).toBe(true);
    expect(predicate("other")).toBe(false);
    expect(predicate(STOCK_PROVIDER.toUpperCase())).toBe(false);
  });
  it("keeps generated SDK narrowing at the reference boundary", () => {
    const query = {}, from = vi.fn(() => query);
    expect(createSupabaseOfferAvailabilityPortFromClient({ from } as unknown as Parameters<typeof createSupabaseOfferAvailabilityPortFromClient>[0])).toBe(binding.port);
    expect(binding.create).toHaveBeenCalledOnce();
    expect(binding.create.mock.calls[0]?.[0].from("inventory_balances")).toBe(query);
    expect(from).toHaveBeenCalledExactlyOnceWith("inventory_balances");
  });
});

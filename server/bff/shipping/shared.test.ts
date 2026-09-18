import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createHiddenDeliverySelectionRoute,
  createHiddenPickupPointSearchRoute,
} from "./shared.js";

vi.mock("./deliverySelectionFactory.js", () => ({
  createValidatedDeliverySelectionPort: vi.fn(() => ({
    listOptions: vi.fn(async () => []),
    validatePickupPoint: vi.fn(async () => null),
  })),
}));
vi.mock("./pickupPointSearchFactory.js", () => ({
  createPickupPointSearchPort: vi.fn(() => ({ searchPickupPoints: vi.fn(async () => []) })),
}));

describe("hidden delivery-selection shared routes", () => {
  it("composes the delivery-selection port and delegates to the handler factory", async () => {
    const inner = vi.fn(async () => undefined);
    const factory = vi.fn(() => inner);
    const req = { method: "GET" } as unknown as VercelRequest;
    const res = {} as unknown as VercelResponse;

    await createHiddenDeliverySelectionRoute(factory)(req, res);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(req, res);
  });

  it("composes the pickup-point-search port and delegates to the handler factory", async () => {
    const inner = vi.fn(async () => undefined);
    const factory = vi.fn(() => inner);
    const req = { method: "POST" } as unknown as VercelRequest;
    const res = {} as unknown as VercelResponse;

    await createHiddenPickupPointSearchRoute(factory)(req, res);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(req, res);
  });

});

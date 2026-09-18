import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import { createAdminShippingRateHandler } from "./adminShippingRateHandler.js";

describe("admin shipping rate handler", () => {
  it("returns the flat shipping rate on GET", async () => {
    const res = response();
    const dataPort = port({ getShippingFlatMinor: vi.fn().mockResolvedValue(1490) });

    await createAdminShippingRateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(dataPort.getShippingFlatMinor).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ shippingFlatMinor: 1490 }),
      }),
    );
  });

  it("sets the flat shipping rate via the RPC port and records the audit", async () => {
    const res = response();
    const dataPort = port({ setShippingFlatMinor: vi.fn().mockResolvedValue(undefined) });

    await createAdminShippingRateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { shippingFlatMinor: 1990 }), res);

    expect(dataPort.setShippingFlatMinor).toHaveBeenCalledWith(1990);
    expect(dataPort.recordPromotionAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "shipping_rate_change",
        promotionId: "shipping_flat_minor",
        newValue: { shippingFlatMinor: 1990 },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: expect.objectContaining({ updated: true }) }),
    );
  });

  it("rejects an out-of-range rate with BAD_REQUEST", async () => {
    const res = response();
    const dataPort = port({ setShippingFlatMinor: vi.fn() });

    await createAdminShippingRateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { shippingFlatMinor: 200000 }), res);

    expect(dataPort.setShippingFlatMinor).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

function port(overrides: Record<string, unknown>): AdminPromotionsDataPort {
  return {
    listPromotions: vi.fn(),
    updatePromotion: vi.fn(),
    listSubscriptionBand: vi.fn(),
    setSubscriptionBandPercent: vi.fn(),
    getShippingFlatMinor: vi.fn(),
    setShippingFlatMinor: vi.fn(),
    recordPromotionAudit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AdminPromotionsDataPort;
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as VercelRequest;
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function authorize(
  result:
    | { ok: true; userId: string; role: "admin"; isMachineActor: boolean }
    | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } = {
    ok: true,
    userId: "admin-user-1",
    role: "admin",
    isMachineActor: false,
  },
) {
  return vi.fn().mockResolvedValue(result);
}

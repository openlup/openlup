import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import { createAdminCatalogPriceHandler } from "./adminCatalogPriceHandler.js";

describe("admin catalog price handler", () => {
  it("authenticates then fences the legacy price route without invoking its RPC port", async () => {
    const res = response();
    const dataPort = port({ setCatalogPrice: vi.fn().mockResolvedValue(undefined) });
    const authorizeAdmin = authorize();

    await createAdminCatalogPriceHandler({
      dataPort,
      authorizeAdmin,
    })(request("POST", { sku: "opaque:venison.v1", unitPriceMinor: 1690 }), res);

    expect(authorizeAdmin).toHaveBeenCalledOnce();
    expect(dataPort.setCatalogPrice).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "FORBIDDEN",
          details: { reason: "legacy_catalog_mutation_fenced" },
        }),
      }),
    );
  });

  it("returns the same stable refusal before parsing an invalid legacy body", async () => {
    const res = response();
    const dataPort = port({ setCatalogPrice: vi.fn() });

    await createAdminCatalogPriceHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { sku: "opaque:venison.v1", unitPriceMinor: 999999 }), res);

    expect(dataPort.setCatalogPrice).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("405s a non-POST method", async () => {
    const res = response();
    const dataPort = port({ setCatalogPrice: vi.fn() });

    await createAdminCatalogPriceHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(dataPort.setCatalogPrice).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });
});

function port(overrides: Record<string, unknown>): AdminPromotionsDataPort {
  return {
    listPromotions: vi.fn(),
    updatePromotion: vi.fn(),
    listSubscriptionBand: vi.fn(),
    setSubscriptionBandPercent: vi.fn(),
    setCatalogPrice: vi.fn(),
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

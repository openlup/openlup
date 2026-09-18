import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminSubscriptionBandEntry } from "../../../src/domains/commerce/adminPromotionsContracts.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import { createAdminSubscriptionBandHandler } from "./adminSubscriptionBandHandler.js";

describe("admin subscription band handler", () => {
  it("returns the per-SKU band with the uniform current percent", async () => {
    const res = response();
    const dataPort = port({ listSubscriptionBand: vi.fn().mockResolvedValue(entries()) });

    await createAdminSubscriptionBandHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ currentPercent: 10 }),
      }),
    );
  });

  it("reports a null current percent when SKUs diverge", async () => {
    const res = response();
    const mixed: AdminSubscriptionBandEntry[] = [
      ...entries(),
      { variantId: "v2", sku: "B", oneTimeMinor: 1490, subscriptionMinor: 1400, percent: 6 },
    ];
    const dataPort = port({ listSubscriptionBand: vi.fn().mockResolvedValue(mixed) });

    await createAdminSubscriptionBandHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentPercent: null }) }),
    );
  });

  it("authenticates then fences the legacy subscription-band write without invoking its RPC port", async () => {
    const res = response();
    const dataPort = port({
      setSubscriptionBandPercent: vi
        .fn()
        .mockResolvedValue({ updatedSkuCount: 6, appliedPercent: 12 }),
    });
    const authorizeAdmin = authorize();

    await createAdminSubscriptionBandHandler({
      dataPort,
      authorizeAdmin,
    })(request("POST", { percent: 12 }), res);

    expect(authorizeAdmin).toHaveBeenCalledOnce();
    expect(dataPort.setSubscriptionBandPercent).not.toHaveBeenCalled();
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

  it("returns the same stable refusal before parsing an invalid legacy POST body", async () => {
    const res = response();
    const dataPort = port({ setSubscriptionBandPercent: vi.fn() });

    await createAdminSubscriptionBandHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { percent: 150 }), res);

    expect(dataPort.setSubscriptionBandPercent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

function entries(): AdminSubscriptionBandEntry[] {
  return [{ variantId: "v1", sku: "A", oneTimeMinor: 1490, subscriptionMinor: 1340, percent: 10 }];
}

function port(overrides: Record<string, unknown>): AdminPromotionsDataPort {
  return {
    listPromotions: vi.fn(),
    updatePromotion: vi.fn(),
    listSubscriptionBand: vi.fn(),
    setSubscriptionBandPercent: vi.fn(),
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

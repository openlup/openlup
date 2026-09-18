import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminPromotion } from "../../../src/domains/commerce/adminPromotionsContracts.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import {
  createAdminPromotionUpdateHandler,
  createAdminPromotionsListHandler,
} from "./adminPromotionsHandler.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";

describe("admin promotions handlers", () => {
  it("returns the promotion list through the shared envelope", async () => {
    const res = response();
    const dataPort = port({ listPromotions: vi.fn().mockResolvedValue([promotion()]) });

    await createAdminPromotionsListHandler({ dataPort, authorizeAdmin: authorize() })(
      request("GET"),
      res,
    );

    expect(dataPort.listPromotions).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects non-admin reads before touching the port", async () => {
    const res = response();
    const dataPort = port({ listPromotions: vi.fn() });

    await createAdminPromotionsListHandler({
      dataPort,
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("GET"), res);

    expect(dataPort.listPromotions).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });


  it("updates a promotion and writes a required audit row", async () => {
    const res = response();
    const dataPort = port({
      updatePromotion: vi.fn().mockResolvedValue(undefined),
      recordPromotionAudit: vi.fn().mockResolvedValue(undefined),
    });

    await createAdminPromotionUpdateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { id: "p1", updates: { discountValue: 15 } }), res);

    expect(dataPort.updatePromotion).toHaveBeenCalledWith("p1", { discountValue: 15 });
    expect(dataPort.recordPromotionAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "promo_update", promotionId: "p1" }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("classifies a status-only edit as a status-change audit action", async () => {
    const res = response();
    const dataPort = port({
      updatePromotion: vi.fn().mockResolvedValue(undefined),
      recordPromotionAudit: vi.fn().mockResolvedValue(undefined),
    });

    await createAdminPromotionUpdateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { id: "p1", updates: { status: "paused" } }), res);

    expect(dataPort.recordPromotionAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "promo_status_change" }),
    );
  });

  it("rejects an empty update payload with BAD_REQUEST", async () => {
    const res = response();
    const dataPort = port({ updatePromotion: vi.fn() });

    await createAdminPromotionUpdateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { id: "p1", updates: {} }), res);

    expect(dataPort.updatePromotion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // Bug fix 1 (Wave 4.5): a structured RPC RAISE surfaces its real code instead of
  // the old blanket `catch { UPSTREAM_UNAVAILABLE }` flattening every failure.
  it("maps a structured update RPC error to its real code, not a flat 502", async () => {
    const res = response();
    const dataPort = port({
      updatePromotion: vi.fn().mockRejectedValue(new DomainRpcError("42501", "forbidden")),
    });

    await createAdminPromotionUpdateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { id: "p1", updates: { discountValue: 15 } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Bug fix 2 (Wave 4.5): the audit is required, not best-effort-swallowed — an
  // audit failure fails the request rather than vanishing.
  it("fails the request when the required audit write fails", async () => {
    const res = response();
    const dataPort = port({
      updatePromotion: vi.fn().mockResolvedValue(undefined),
      recordPromotionAudit: vi.fn().mockRejectedValue(new Error("audit_down")),
    });

    await createAdminPromotionUpdateHandler({
      dataPort,
      authorizeAdmin: authorize(),
    })(request("POST", { id: "p1", updates: { discountValue: 15 } }), res);

    expect(dataPort.recordPromotionAudit).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function promotion(): AdminPromotion {
  return {
    id: "p1",
    code: "WELCOME10",
    name: "Welcome 10%",
    triggerType: "coupon_code",
    discountType: "percentage",
    semanticBenefit: { kind: "percentage", valuePercent: 10 },
    systemManaged: false,
    readOnly: false,
    v2Mirror: null,
    appliesToKind: "order_total",
    stackingRule: "exclusive",
    eligibility: {},
    validFrom: "2026-06-01T00:00:00+00:00",
    validTo: null,
    status: "active",
    regionAvailability: ["PL"],
    redemptionLimitGlobal: null,
    redemptionLimitPerCustomer: null,
  };
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

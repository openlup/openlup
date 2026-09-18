import { describe, expect, it, vi, beforeEach } from "vitest";

import { requestBff } from "@/lib/bff/client";

import {
  getAdminPromotions,
  getAdminSubscriptionBand,
  setAdminSubscriptionBand,
  updateAdminPromotion,
} from "./adminPromotionsClient";

vi.mock("@/lib/bff/client", () => ({
  requestBff: vi.fn().mockResolvedValue({ ok: true }),
}));

const mockedRequestBff = vi.mocked(requestBff);

beforeEach(() => {
  mockedRequestBff.mockClear();
});

describe("adminPromotionsClient", () => {
  it("GETs the promotions list with a bearer token", async () => {
    await getAdminPromotions("admin-token");
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/promotions/list");
    expect(options?.method).toBe("GET");
    expect((options?.headers as Headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("POSTs a promotion update with the request body", async () => {
    await updateAdminPromotion("admin-token", { id: "p1", updates: { discountValue: 15 } });
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/promotions/update");
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual({ id: "p1", updates: { discountValue: 15 } });
  });

  it("GETs the subscription band", async () => {
    await getAdminSubscriptionBand("admin-token");
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/subscription-band");
    expect(options?.method).toBe("GET");
  });

  it("POSTs the subscription band percent", async () => {
    await setAdminSubscriptionBand("admin-token", { percent: 12 });
    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe("/api/bff/admin/commerce/subscription-band");
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual({ percent: 12 });
  });
});

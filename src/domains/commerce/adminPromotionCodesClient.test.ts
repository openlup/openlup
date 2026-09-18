import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestBff } from "@/lib/bff/client";

import {
  createAdminPromotionCode,
  getAdminPromotionCodes,
  previewAdminPromotionCode,
  updateAdminPromotionCode,
} from "./adminPromotionCodesClient";

vi.mock("@/lib/bff/client", () => ({ requestBff: vi.fn().mockResolvedValue({}) }));

const mockedRequestBff = vi.mocked(requestBff);

beforeEach(() => mockedRequestBff.mockClear());

describe("adminPromotionCodesClient", () => {
  it("lists codes with encoded server filters, cursor and bearer token", async () => {
    await getAdminPromotionCodes("admin-token", {
      q: "vip 80",
      status: "active",
      scope: "both",
      cursor: "opaque+/=cursor",
      limit: 25,
    });

    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe(
      "/api/bff/admin/commerce/promotion-codes/list?q=vip+80&status=active&scope=both&cursor=opaque%2B%2F%3Dcursor&limit=25",
    );
    expect(options?.method).toBe("GET");
    expect((options?.headers as Headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it.each([
    ["preview", previewAdminPromotionCode, { benefits: [], scopes: [] }],
    ["create", createAdminPromotionCode, { name: "VIP" }],
    ["update", updateAdminPromotionCode, { id: "code-id" }],
  ] as const)("POSTs %s without leaking the token into the body", async (action, invoke, body) => {
    await invoke("admin-token", body as never);

    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe(`/api/bff/admin/commerce/promotion-codes/${action}`);
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual(body);
    expect(JSON.stringify(options?.body)).not.toContain("admin-token");
    expect((options?.headers as Headers).get("Authorization")).toBe("Bearer admin-token");
  });
});

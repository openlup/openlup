import { describe, expect, it, vi } from "vitest";
import type { VercelRequest as Request, VercelResponse as Response } from "../../_lib/types/vercel.js";
import { createCommerceOmsControlPlaneListHandler } from "./commerceOmsControlPlaneHandlers.js";

describe("OMS control-plane handler", () => {
  it("authorizes before calling the port", async () => {
    const port = { listOrders: vi.fn(), getOrderDetail: vi.fn() };
    const { res, status, json } = response();
    await createCommerceOmsControlPlaneListHandler({
      port, authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "UNAUTHORIZED", message: "missing bearer" }),
    })({ method: "GET", query: { view: "control_plane_v1" } } as unknown as Request, res);
    expect(port.listOrders).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("validates and returns the strict neutral response", async () => {
    const listOrders = vi.fn().mockResolvedValue({ contractVersion: "commerce.oms_control_plane.v1",
      orders: [], totalCount: 0, page: 1, pageSize: 25 });
    const { res, status, json } = response();
    await createCommerceOmsControlPlaneListHandler({
      port: { listOrders, getOrderDetail: vi.fn() }, authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "actor" }),
    })({ method: "GET", query: { view: "control_plane_v1" } } as unknown as Request, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true,
      data: expect.objectContaining({ contractVersion: "commerce.oms_control_plane.v1" }) }));
  });
});

function response() {
  const status = vi.fn(); const json = vi.fn();
  const res = { setHeader: vi.fn(), status, json } as unknown as Response;
  status.mockReturnValue(res); json.mockReturnValue(res);
  return { res, status, json };
}

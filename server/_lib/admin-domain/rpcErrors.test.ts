import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "../types/vercel.js";
import { DomainRpcError, mapRpcError } from "./rpcErrors.js";

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function sent(res: VercelResponse) {
  return vi.mocked(res.json).mock.calls[0]?.[0] as {
    error?: { code?: string; message?: string; details?: { reason?: string } };
  };
}

describe("mapRpcError", () => {
  it.each([
    ["42501", "publish_requires_human", 403, "FORBIDDEN"],
    ["P0001", "price_required_to_sell", 409, "CONFLICT"],
    ["P0002", "sku_not_found", 404, "NOT_FOUND"],
  ])("maps SQLSTATE %s to a stable code carrying the reason", (sqlstate, msg, status, code) => {
    const res = response();
    mapRpcError(res, new DomainRpcError(sqlstate, msg), "Write failed");
    expect(res.status).toHaveBeenCalledWith(status);
    expect(sent(res).error?.code).toBe(code);
    expect(sent(res).error?.details?.reason).toBe(msg);
  });

  it("maps a unique violation (23505) to already_exists", () => {
    const res = response();
    mapRpcError(res, new DomainRpcError("23505", "dup key"), "Write failed");
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sent(res).error?.details?.reason).toBe("already_exists");
  });

  it("falls back to UPSTREAM_UNAVAILABLE for an unknown SQLSTATE", () => {
    const res = response();
    mapRpcError(res, new DomainRpcError("XX999", "boom"), "Catalog write failed");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(sent(res).error?.message).toBe("Catalog write failed");
  });

  it("falls back to UPSTREAM_UNAVAILABLE for a non-RPC throw", () => {
    const res = response();
    mapRpcError(res, new Error("network"), "Catalog write failed");
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

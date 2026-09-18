import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import handler from "./create.js";

describe("promotion-codes/create route", () => {
  it("fails closed without runtime configuration", async () => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
    vi.mocked(res.status).mockReturnValue(res);
    await handler({ method: "POST", body: {}, query: {}, headers: {} } as unknown as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

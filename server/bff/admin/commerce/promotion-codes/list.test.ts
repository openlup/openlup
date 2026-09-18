import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import handler from "./list.js";

describe("promotion-codes/list route", () => {
  it("fails closed without Supabase configuration", async () => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
    vi.mocked(res.status).mockReturnValue(res);
    await handler({ method: "GET", query: {}, headers: {} } as unknown as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

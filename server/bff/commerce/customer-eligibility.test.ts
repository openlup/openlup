import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import handler from "./customer-eligibility.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function createResponse(): VercelResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

function request(): VercelRequest {
  return {
    method: "POST",
    body: { email: "anna@example.com" },
    query: {},
    headers: {},
  } as unknown as VercelRequest;
}

describe("customer-eligibility BFF route", () => {
  it("fails closed when the resolver flag is off", async () => {
    delete process.env.COMMERCE_V2_W2_PRICING_RESOLVER;
    const res = createResponse();

    await handler(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }) }),
    );
  });

  it("fails closed when Supabase service env is not configured", async () => {
    process.env.COMMERCE_V2_W2_PRICING_RESOLVER = "true";
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = createResponse();

    await handler(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

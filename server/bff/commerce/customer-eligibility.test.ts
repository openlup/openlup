import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { hashRateLimitKey } from "../../_lib/rate-limit/publicSignupRateLimit.js";
import handler from "./customer-eligibility.js";
import * as serviceGateway from "./serviceDataGateway.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    headers: { "x-forwarded-for": "203.0.113.8" },
    socket: { remoteAddress: "192.0.2.10" },
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
  it.each([
    { label: "direct peer", setting: undefined, key: "192.0.2.10" },
    { label: "shared bucket for a malformed setting", setting: "invalid-hop-fixture", key: "unknown" },
  ])("enforces quota on the $label", async ({ setting, key }) => {
    vi.stubEnv("COMMERCE_V2_W2_PRICING_RESOLVER", "true");
    vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", setting);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: false, reason: "ip_quota" }, error: null });
    vi.spyOn(serviceGateway, "readCommerceServiceDataGateway").mockReturnValue({
      asService: (work) => work({ rpc } as never),
    } as NonNullable<ReturnType<typeof serviceGateway.readCommerceServiceDataGateway>>);
    const res = createResponse();

    await handler(request(), res);

    expect.soft(rpc).toHaveBeenCalledExactlyOnceWith("public_record_eligibility_lookup_attempt", expect.objectContaining({
      p_ip_hash: hashRateLimitKey(key),
    }));
    expect(res.status).toHaveBeenCalledWith(429);
    if (setting) {
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^OPENLUP_E_TRUSTED_PROXY_HOPS_INVALID\n/));
      expect(log.mock.calls[0][0]).not.toContain(setting);
    }
  });

});

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { composeAdminPromotionCodes } from "./_compose.js";

const keys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "COMMERCE_PROMOTION_PREVIEW_HMAC_SECRET"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function res(): VercelResponse {
  const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(response.status).mockReturnValue(response);
  return response;
}

function req(): VercelRequest {
  return { method: "POST", headers: { authorization: "Bearer token" }, query: {} } as unknown as VercelRequest;
}

describe("promotion-code composition", () => {
  it("fails closed when preview signing is missing or shorter than 32 bytes", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.COMMERCE_PROMOTION_PREVIEW_HMAC_SECRET = "too-short";
    const response = res();
    expect(composeAdminPromotionCodes(req(), response, { requirePreviewSecret: true })).toBeNull();
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it("allows list composition without the signing secret", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    delete process.env.COMMERCE_PROMOTION_PREVIEW_HMAC_SECRET;
    expect(composeAdminPromotionCodes(req(), res())).not.toBeNull();
  });
});

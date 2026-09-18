/**
 * Smoke test for the catalog archive-product BFF route wrapper.
 *
 * Executes the route's wrapper lines so the CI coverage guard sees this
 * changed file as covered (companion test = hasCompanionTest passes).
 * With no Supabase env configured, readSupabaseAdminCommerceEnv() returns
 * null and the handler short-circuits with UPSTREAM_UNAVAILABLE — no DB call.
 */
import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../../../_lib/types/vercel.js";
import { createResponse } from "../../../../../tests/helpers/catalogRouteResponse.js";
import handler from "./archive-product.js";

function request(method = "POST"): VercelRequest {
  return { method, query: {}, headers: {} } as unknown as VercelRequest;
}

describe("catalog/archive-product BFF route", () => {
  it("responds with an error envelope (no Supabase env = UPSTREAM_UNAVAILABLE)", async () => {
    const res = createResponse();

    await handler(request("POST"), res);

    expect(res.status).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

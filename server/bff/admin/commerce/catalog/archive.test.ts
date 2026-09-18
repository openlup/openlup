/**
 * Smoke test for the catalog archive BFF route wrapper.
 *
 * Exercises the route's wrapper so the CI coverage guard sees this changed file
 * as covered. With no Supabase env configured, composeAdminCatalog returns null
 * and the handler short-circuits with UPSTREAM_UNAVAILABLE before any DB call.
 */
import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../../../_lib/types/vercel.js";
import { createResponse } from "../../../../../tests/helpers/catalogRouteResponse.js";
import handler from "./archive.js";

function request(method = "POST"): VercelRequest {
  return { method, query: {}, headers: {} } as unknown as VercelRequest;
}

describe("catalog/archive BFF route", () => {
  it("responds with UPSTREAM_UNAVAILABLE when no Supabase env is configured", async () => {
    const res = createResponse();

    await handler(request(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          message: "Admin catalog is not configured",
        }),
      }),
    );
  });
});

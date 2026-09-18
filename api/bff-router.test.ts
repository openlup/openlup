import { describe, expect, it } from "vitest";

import { rewriteBffRouterRequestUrl } from "./bff-router.js";
import type { VercelRequest } from "../server/_lib/types/vercel.js";

describe("rewriteBffRouterRequestUrl", () => {
  it("reconstructs nested BFF paths from the Vercel rewrite query", () => {
    const req = {
      headers: { host: "preview.test" },
      query: { __bffPath: "/admin/commerce/orders", path: "admin/commerce/orders", page: "1" },
      url: "/api/bff-router?__bffPath=%2Fadmin/commerce/orders&path=admin/commerce/orders&page=1",
    } as unknown as VercelRequest;

    rewriteBffRouterRequestUrl(req);

    expect(req.url).toBe("/api/bff/admin/commerce/orders?page=1");
    expect(req.query).toEqual({ page: "1" });
  });

  it("leaves direct router calls unchanged", () => {
    const req = {
      headers: { host: "preview.test" },
      query: {},
      url: "/api/bff/health",
    } as unknown as VercelRequest;

    rewriteBffRouterRequestUrl(req);

    expect(req.url).toBe("/api/bff/health");
    expect(req.query).toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import { rewriteBffRouterRequestUrl } from "../../src/bff/routerRewrite.js";
import type { HttpRequest } from "../../src/http/types.js";

function request(query: HttpRequest["query"], url = "/api/bff-router", host?: string) {
  return { query, url, headers: host ? { host } : {} } as HttpRequest;
}

describe("BFF router URL reconstruction", () => {
  it("restores a nested path and removes both internal query keys", () => {
    const req = request({ __bffPath: "/admin/entries/list", path: "admin/entries/list", page: "3" }, "/api/bff-router?__bffPath=%2Fadmin%2Fentries%2Flist&path=admin%2Fentries%2Flist&page=3", "example.test");
    rewriteBffRouterRequestUrl(req);
    expect(req.url).toBe("/api/bff/admin/entries/list?page=3");
    expect(req.query).toEqual({ page: "3" });
  });

  it.each([{}, { __bffPath: "" }, { __bffPath: [] }])("leaves a direct request unchanged for %j", (query) => {
    const req = request(query, "/api/bff/status?tag=one");
    rewriteBffRouterRequestUrl(req);
    expect(req.url).toBe("/api/bff/status?tag=one");
    expect(req.query).toBe(query);
  });

  it("uses the first path value, drops empty segments and encodes each segment once", () => {
    const req = request({ __bffPath: ["//items///part%20one/a%2Fb/%2520/", "ignored"], tag: ["one", "two"] }, "/api/bff-router?tag=one&tag=two&__bffPath=ignored&__bffPath=also-ignored");
    rewriteBffRouterRequestUrl(req);
    expect(req.url).toBe("/api/bff/items/part%20one/a%2Fb/%2520?tag=one&tag=two");
    expect(req.query).toEqual({ tag: ["one", "two"] });
  });

  it("defaults a missing Host and URL", () => {
    const req = request({ __bffPath: "status" });
    delete req.url;
    rewriteBffRouterRequestUrl(req);
    expect(req.url).toBe("/api/bff/status");
    expect(req.query).toEqual({});
  });

  it("rewrites the same path with or without a Host header", () => {
    const req = request({ __bffPath: "status" }, "/api/bff-router", "example.test");
    rewriteBffRouterRequestUrl(req);
    expect(req.url).toBe("/api/bff/status");
    const missingHost = request({ __bffPath: "status" });
    rewriteBffRouterRequestUrl(missingHost);
    expect(missingHost.url).toBe("/api/bff/status");
  });

  it("preserves the original request on malformed path encoding", () => {
    const query = { __bffPath: "items/%zz", path: "internal", retained: "value" };
    const req = request(query, "/api/bff-router?retained=value");
    expect(() => rewriteBffRouterRequestUrl(req)).toThrow(URIError);
    expect(req.url).toBe("/api/bff-router?retained=value");
    expect(req.query).toBe(query);
  });
});

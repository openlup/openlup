import { describe, expect, it, vi } from "vitest";

import {
  applySecurityHeaders, contentTypeFor, looksLikeAsset, serveSpaStatic,
  type NodeSecurityHeaderPolicy, type StaticAssetReader,
} from "../../src/http/security.js";
import type { HttpResponse } from "../../src/http/types.js";

function response() {
  const headers = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  const state = { statusCode: 200, body: "" };
  const res = Object.assign(state, {
    setHeader(name: string, value: string) { writes.push([name, value]); headers.set(name.toLowerCase(), value); },
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end(value: unknown) { state.body = String(value); },
  }) as unknown as HttpResponse;
  return { res, state, writes };
}

const policy: NodeSecurityHeaderPolicy = {
  globalHeaders: [
    ["Strict-Transport-Security", "max-age=600; includeSubDomains"],
    ["X-Content-Type-Options", "nosniff"], ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "same-origin"], ["Permissions-Policy", "camera=()"],
    ["Reporting-Endpoints", 'reports="/api/csp-report"'],
    ["Content-Security-Policy-Report-Only", "default-src 'self'; img-src https://assets.example.test; report-uri /api/csp-report"],
  ],
  assetCachePrefixes: ["/assets/", "/media/"], noindexFamilies: ["/private"], noindexExacts: ["/session"],
  isProductionHost: (host) => host === "example.test" || host === "example.test:443",
};

describe("security header policy", () => {
  it("sets caller headers verbatim in order and keeps existing values case-insensitively", () => {
    const { res, writes } = response();
    res.setHeader("x-frame-options", "SAMEORIGIN");
    writes.length = 0;
    applySecurityHeaders(res, "/", "example.test", policy);
    expect(writes).toEqual(policy.globalHeaders.filter(([name]) => name !== "X-Frame-Options"));
    expect(res.getHeader("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.getHeader("X-Robots-Tag")).toBeUndefined();
  });

  it.each(["/assets/app.js", "/media/image.png"])("applies asset caching for %s", (path) => {
    const { res } = response();
    applySecurityHeaders(res, path, "example.test", policy);
    expect(res.getHeader("cache-control")).toBe("public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
  });

  it("applies path rules after global defaults and the host rule last", () => {
    const { res, writes } = response();
    applySecurityHeaders(res, "/spa-fallback.html", undefined, {
      ...policy, globalHeaders: [["Cache-Control", "private"], ["X-Robots-Tag", "index"]],
      assetCachePrefixes: ["/"], noindexExacts: ["/spa-fallback.html"],
    });
    expect(writes).toEqual([
      ["Cache-Control", "private"], ["X-Robots-Tag", "index"],
      ["Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"],
      ["Cache-Control", "public, max-age=0, s-maxage=0, must-revalidate"],
      ["X-Robots-Tag", "noindex, nofollow"],
      ["X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex"],
    ]);
  });

  it.each(["/ssg-manifest.json", "/spa-fallback.html"])("forces revalidation at %s", (path) => {
    const { res } = response();
    applySecurityHeaders(res, path, "example.test", policy);
    expect(res.getHeader("cache-control")).toBe("public, max-age=0, s-maxage=0, must-revalidate");
  });

  it("forces the fixed security document content type", () => {
    const { res } = response();
    res.setHeader("Content-Type", "application/octet-stream");
    applySecurityHeaders(res, "/.well-known/security.txt", "example.test", policy);
    expect(res.getHeader("content-type")).toBe("text/plain; charset=utf-8");
  });

  it.each([
    ["/private", true], ["/private/nested", true], ["/private-other", false],
    ["/session", true], ["/session/nested", false], ["/", false], ["/assets-other/app.js", false],
  ])("matches noindex boundaries at %s", (path, matched) => {
    const { res } = response();
    applySecurityHeaders(res, path, "example.test", policy);
    expect(res.getHeader("x-robots-tag")).toBe(matched ? "noindex, nofollow" : undefined);
    expect(res.getHeader("cache-control")).toBeUndefined();
  });

  it.each([undefined, "reference.invalid", "localhost:3000", "example.test.reference.invalid"])(
    "uses the supplied host decision for %s and overrides route tags", (host) => {
      const { res } = response();
      applySecurityHeaders(res, "/private", host, policy);
      expect(res.getHeader("x-robots-tag")).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
    },
  );

  it("delegates production classification including ports to the caller", () => {
    const isProductionHost = vi.fn(() => true);
    const { res } = response();
    applySecurityHeaders(res, "/", "example.test:443", { ...policy, isProductionHost });
    expect(isProductionHost).toHaveBeenCalledExactlyOnceWith("example.test:443");
    expect(res.getHeader("x-robots-tag")).toBeUndefined();
  });
});

describe("static path helpers", () => {
  it.each([
    ["html", "text/html; charset=utf-8"], ["js", "text/javascript; charset=utf-8"],
    ["mjs", "text/javascript; charset=utf-8"], ["css", "text/css; charset=utf-8"],
    ["json", "application/json; charset=utf-8"], ["svg", "image/svg+xml"], ["png", "image/png"],
    ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"], ["ico", "image/x-icon"],
    ["woff", "font/woff"], ["woff2", "font/woff2"], ["txt", "text/plain; charset=utf-8"],
    ["webmanifest", "application/manifest+json"], ["unknown", "application/octet-stream"],
  ])("maps .%s case-insensitively", (extension, expected) => {
    expect(contentTypeFor(`/assets/file.${extension}`)).toBe(expected);
    expect(contentTypeFor(`/assets/file.${extension.toUpperCase()}`)).toBe(expected);
  });

  it.each([["/assets/file.js", true], ["/a.b/route", false], ["/nested/route", false], ["/file.", true], ["/", false]])(
    "recognizes extensions in %s", (path, expected) => expect(looksLikeAsset(path)).toBe(expected),
  );
});

describe("static response selection", () => {
  function reader(files: Record<string, string> = {}): StaticAssetReader {
    return {
      read: vi.fn(async (path: string) => files[path] === undefined ? null : { body: Buffer.from(files[path]), contentType: contentTypeFor(path) }),
      readIndex: vi.fn(async () => ({ body: Buffer.from("<shell/>"), contentType: "text/html; charset=utf-8" })),
    };
  }

  it.each([
    ["/", { "/index.html": "<home/>" }, false, false, "<home/>"],
    ["/assets/app.css", { "/assets/app.css": "body{}" }, true, true, "body{}"],
    ["/document", { "/document/index.html": "<document/>" }, true, true, "<document/>"],
    ["/document/", { "/document/index.html": "<document/>" }, true, false, "<document/>"],
    ["/client/nested", {}, false, true, "<shell/>"],
    ["/missing-document", {}, true, true, "<shell/>"],
  ] as const)("serves %s from the selected source", async (path, files, document, fallback, body) => {
    const r = reader(files);
    const { res, state } = response();
    await serveSpaStatic({} as never, res, path, r, document, fallback);
    expect(state.statusCode).toBe(200);
    expect(state.body).toBe(body);
    expect(res.getHeader("content-type")).toBe(contentTypeFor(path.endsWith(".css") ? path : "/index.html"));
    expect(r.read).toHaveBeenNthCalledWith(1, path === "/" ? "/index.html" : path);
    expect(r.readIndex).toHaveBeenCalledTimes(body === "<shell/>" ? 1 : 0);
  });

  it.each(["/assets/missing.js", "/unknown"])("returns a plain 404 for %s", async (path) => {
    const r = reader();
    const { res, state } = response();
    await serveSpaStatic({} as never, res, path, r, true, path.endsWith(".js"));
    expect(state).toMatchObject({ statusCode: 404, body: "Not Found" });
    expect(res.getHeader("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.readIndex).not.toHaveBeenCalled();
    expect(r.read).toHaveBeenCalledTimes(path.endsWith(".js") ? 1 : 2);
  });

  it("does not serve undeclared route documents", async () => {
    const r = reader({ "/undeclared/index.html": "<document/>" });
    const { res, state } = response();
    await serveSpaStatic({} as never, res, "/undeclared", r);
    expect(state.statusCode).toBe(404);
    expect(r.read).toHaveBeenCalledExactlyOnceWith("/undeclared");
  });

  it.each(["asset", "document", "fallback"])("preserves an existing content type for a %s", async (kind) => {
    const r = reader(kind === "asset" ? { "/file.txt": "asset" } : kind === "document" ? { "/route/index.html": "document" } : {});
    const { res } = response();
    res.setHeader("Content-Type", "application/example");
    await serveSpaStatic({} as never, res, kind === "asset" ? "/file.txt" : "/route", r, kind === "document", kind === "fallback");
    expect(res.getHeader("content-type")).toBe("application/example");
  });
});

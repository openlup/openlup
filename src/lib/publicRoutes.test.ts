import { describe, expect, it, vi } from "vitest";
import { canonicalizeLegacyPublicPathname, normalizePublicPathname, publicLegacyRedirects, publicStaticRoutes } from "./publicRoutes";

describe("public route manifest", () => {
  it("projects the selected static item route once and excludes the root", () => {
    expect(publicStaticRoutes.map(({ path }) => path)).toEqual(["items/field-notes"]);
    expect(publicStaticRoutes[0]).toMatchObject({ locale: "en", seoPath: ["reference", "item"] });
  });
  it("has no historical redirects in the selected public profile", () => {
    expect(publicLegacyRedirects).toEqual([]);
    expect(canonicalizeLegacyPublicPathname("/en/legacy/")).toBeNull();
  });
  it("normalizes root, leading slash and a trailing slash", () => {
    expect(normalizePublicPathname("/")).toBe("/");
    expect(normalizePublicPathname("items/field-notes/")).toBe("/items/field-notes");
  });
  it("canonicalizes exact and prefix redirects from an explicitly supplied manifest", async () => {
    vi.resetModules();
    vi.doMock("@/lib/siteRoutes", () => ({
      siteRoutes: [],
      siteRedirects: [
        { source: "/old", destination: "/new", permanent: true },
        { source: "/legacy/:path*", destination: "/items/:path*", permanent: true, clientPrefix: { from: "/legacy/", to: "/items/" } },
      ],
    }));
    try {
      const { canonicalizeLegacyPublicPathname: canonicalize } = await import("./publicRoutes");
      expect(canonicalize("old/")).toBe("/new");
      expect(canonicalize("/legacy/field-notes/")).toBe("/items/field-notes");
      expect(canonicalize("/legacyish/field-notes")).toBeNull();
      expect(canonicalize("/unknown")).toBeNull();
    } finally {
      vi.doUnmock("@/lib/siteRoutes");
      vi.resetModules();
    }
  });
});

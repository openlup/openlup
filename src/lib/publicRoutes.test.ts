import { describe, expect, it } from "vitest";
import {
  canonicalizeLegacyPublicPathname,
  publicLegacyRedirects,
  publicStaticRoutes,
} from "./publicRoutes";

describe("public route manifest", () => {
  it("keeps static route paths unique", () => {
    const paths = publicStaticRoutes.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("excludes retired free-samples routes from static generation", () => {
    const paths = publicStaticRoutes.map((route) => route.path);
    expect(paths).not.toContain("free-samples");
    expect(paths).not.toContain("darmowe-probki");
  });

  it("drives legacy EN alias canonicalization", () => {
    expect(canonicalizeLegacyPublicPathname("/en/free-samples")).toBe("/waitlist-en");
    expect(canonicalizeLegacyPublicPathname("/en/how-it-works/")).toBe("/how-it-works");
    expect(canonicalizeLegacyPublicPathname("/en/dogs/lamb/nutrition")).toBe(
      "/dogs/lamb/nutrition",
    );
    // Free-samples retired: /free-samples now canonicalizes to the waitlist.
    expect(canonicalizeLegacyPublicPathname("/free-samples")).toBe("/waitlist-en");
    expect(canonicalizeLegacyPublicPathname("/darmowe-probki")).toBe("/waitlist");
    expect(canonicalizeLegacyPublicPathname("/en")).toBeNull();
  });

  it("marks all legacy redirects as permanent", () => {
    expect(publicLegacyRedirects.length).toBeGreaterThan(0);
    expect(publicLegacyRedirects.every((redirect) => redirect.permanent)).toBe(true);
  });

  it("preserves retired free-samples reachability through legacy redirects", () => {
    const redirects = new Map(
      publicLegacyRedirects.map(({ source, destination }) => [source, destination]),
    );

    expect(redirects.get("/darmowe-probki")).toBe("/waitlist");
    expect(redirects.get("/darmowe-probki/dziekujemy")).toBe("/waitlist");
    expect(redirects.get("/free-samples")).toBe("/waitlist-en");
    expect(redirects.get("/free-samples/thank-you")).toBe("/waitlist-en");
    expect(redirects.get("/en/free-samples")).toBe("/waitlist-en");
    expect(redirects.get("/en/free-samples/thank-you")).toBe("/waitlist-en");
  });
});

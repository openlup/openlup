import { describe, expect, it } from "vitest";
import { canonicalizeEnAliasPathname } from "./enRouteAliases";

describe("canonicalizeEnAliasPathname", () => {
  it("maps generated EN aliases to runtime canonical paths", () => {
    expect(canonicalizeEnAliasPathname("/en/dogs/lamb")).toBe("/dogs/lamb");
    expect(canonicalizeEnAliasPathname("/en/dogs/venison/nutrition")).toBe(
      "/dogs/venison/nutrition",
    );
    expect(canonicalizeEnAliasPathname("/en/free-samples")).toBe("/waitlist-en");
    expect(canonicalizeEnAliasPathname("/en/how-it-works/")).toBe("/how-it-works");
    expect(canonicalizeEnAliasPathname("/en/terms")).toBe("/terms");
  });

  it("does not rewrite real canonical EN paths or the EN home route", () => {
    expect(canonicalizeEnAliasPathname("/dogs/lamb")).toBeNull();
    expect(canonicalizeEnAliasPathname("/en")).toBeNull();
  });

  it("redirects the retired free-samples path to the waitlist", () => {
    expect(canonicalizeEnAliasPathname("/free-samples")).toBe("/waitlist-en");
  });
});

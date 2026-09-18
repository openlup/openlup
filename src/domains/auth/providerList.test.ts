import { describe, expect, it } from "vitest";
import { DEFAULT_SOCIAL_PROVIDERS, parseSocialProviders } from "./providerList.js";

describe("parseSocialProviders", () => {
  it("defaults to Google when unset", () => {
    expect(parseSocialProviders(undefined)).toEqual([...DEFAULT_SOCIAL_PROVIDERS]);
    expect(parseSocialProviders(undefined)).toEqual(["google"]);
  });

  it("parses and orders a comma-separated list", () => {
    expect(parseSocialProviders("google,apple,facebook")).toEqual(["google", "apple", "facebook"]);
  });

  it("trims, lowercases, and drops unknown tokens", () => {
    expect(parseSocialProviders(" Google , twitter , APPLE ")).toEqual(["google", "apple"]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parseSocialProviders("apple,google,apple")).toEqual(["apple", "google"]);
  });

  it("treats an explicit empty/unknown-only value as no providers (disabled)", () => {
    expect(parseSocialProviders("")).toEqual([]);
    expect(parseSocialProviders("none")).toEqual([]);
  });
});

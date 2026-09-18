import { describe, expect, it } from "vitest";
import { maskProviderReference } from "./observabilityRedaction.js";

describe("maskProviderReference", () => {
  it("collapses any present value to a fixed marker", () => {
    expect(maskProviderReference("pi_123")).toBe("redacted_provider_reference");
    expect(maskProviderReference("ch_abc")).toBe("redacted_provider_reference");
  });

  it("preserves absence as null", () => {
    expect(maskProviderReference(null)).toBeNull();
    expect(maskProviderReference(undefined)).toBeNull();
    expect(maskProviderReference("")).toBeNull();
  });
});

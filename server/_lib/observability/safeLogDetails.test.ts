import { describe, expect, it } from "vitest";
import { sanitizeObservedReason, sanitizeObservedSupportCode } from "./safeLogDetails.js";

describe("safe observed route log details", () => {
  it("keeps slug-like reason values and redacts unsafe free text", () => {
    expect(sanitizeObservedReason("feature_flag_disabled")).toBe("feature_flag_disabled");
    expect(sanitizeObservedReason("provider:timeout")).toBe("provider:timeout");
    expect(sanitizeObservedReason("provider buyer@example.com failed")).toBe("redacted_unsafe_reason");
    expect(sanitizeObservedReason("token=secret")).toBe("redacted_unsafe_reason");
  });

  it("keeps support-safe codes and redacts unsafe support text", () => {
    expect(sanitizeObservedSupportCode("SUP-123")).toBe("SUP-123");
    expect(sanitizeObservedSupportCode("DHL_20260620_ABC")).toBe("DHL_20260620_ABC");
    expect(sanitizeObservedSupportCode("SUP-123 buyer@example.com")).toBe("redacted_unsafe_support_code");
    expect(sanitizeObservedSupportCode("token=secret")).toBe("redacted_unsafe_support_code");
  });
});

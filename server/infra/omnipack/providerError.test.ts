import { describe, expect, it } from "vitest";
import {
  OmnipackProviderError,
  mayPostHaveSucceeded,
  sanitizeOmnipackProviderError,
} from "./providerError.js";

describe("OmniPack provider errors", () => {
  it("serializes only the controlled provider error contract", () => {
    const error = new OmnipackProviderError({
      operation: "createOrder",
      status: 503,
      code: "http_503",
      retryable: false,
      mayHaveSucceeded: true,
    });
    (error as Error & { responseBody?: unknown }).responseBody = {
      email: "customer@example.test",
      address: "Secret Street 1",
    };

    const sanitized = sanitizeOmnipackProviderError(error);
    expect(sanitized).toEqual({
      code: "http_503",
      mayHaveSucceeded: true,
      message: "OmniPack request failed: createOrder",
      operation: "createOrder",
      retryable: false,
      status: 503,
    });
    expect(JSON.stringify(sanitized)).not.toContain("customer@example.test");
    expect(JSON.stringify(sanitized)).not.toContain("Secret Street");
  });

  it("redacts arbitrary thrown values and fails safely toward an uncertain retryable outcome", () => {
    const sanitized = sanitizeOmnipackProviderError(
      new Error("fetch failed for customer@example.test using password super-secret"),
    );

    expect(sanitized).toEqual({
      code: "omnipack_provider_error",
      mayHaveSucceeded: true,
      message: "OmniPack request failed",
      operation: null,
      retryable: true,
      status: null,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/customer|password|super-secret/);
  });

  it.each([null, 408, 409, 425, 429, 500, 503, 599])(
    "treats POST status %s as potentially accepted",
    (status) => expect(mayPostHaveSucceeded("POST", status)).toBe(true),
  );

  it.each([400, 401, 403, 404, 422])(
    "treats POST status %i as a definitive rejection",
    (status) => expect(mayPostHaveSucceeded("POST", status)).toBe(false),
  );

  it("never classifies reads or case-mismatched methods as possibly accepted", () => {
    expect(mayPostHaveSucceeded("GET", 503)).toBe(false);
    expect(mayPostHaveSucceeded("post", null)).toBe(false);
  });
});

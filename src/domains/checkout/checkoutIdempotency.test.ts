import { describe, expect, it } from "vitest";
import {
  CHECKOUT_IDEMPOTENCY_KEY_HEADER,
  validateCheckoutIdempotencyHeader,
} from "./checkoutIdempotency.js";

const SAMPLE_UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const UUID_V1_SAMPLE = "9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d";

describe("validateCheckoutIdempotencyHeader", () => {
  it("accepts a well-formed UUID v4 header", () => {
    const result = validateCheckoutIdempotencyHeader(SAMPLE_UUID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBe(SAMPLE_UUID);
    }
  });

  it("rejects an undefined header with reason='missing'", () => {
    const result = validateCheckoutIdempotencyHeader(undefined);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.rejection.reason).toBe("missing");
    }
  });

  it("rejects an empty / whitespace header as missing", () => {
    expect(validateCheckoutIdempotencyHeader("").ok).toBe(false);
    expect(validateCheckoutIdempotencyHeader("   ").ok).toBe(false);
  });

  it("rejects a malformed UUID with reason='malformed'", () => {
    const result = validateCheckoutIdempotencyHeader("not-a-uuid");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.rejection.reason).toBe("malformed");
    }
  });

  it("rejects non-v4 UUID values", () => {
    const result = validateCheckoutIdempotencyHeader(UUID_V1_SAMPLE);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.rejection.reason).toBe("malformed");
    }
  });

  it("trims surrounding whitespace before validation", () => {
    const result = validateCheckoutIdempotencyHeader(`  ${SAMPLE_UUID}  `);
    expect(result.ok).toBe(true);
  });

  it("CHECKOUT_IDEMPOTENCY_KEY_HEADER matches the canonical name BFF handlers will look up", () => {
    expect(CHECKOUT_IDEMPOTENCY_KEY_HEADER).toBe("idempotency-key");
  });
});

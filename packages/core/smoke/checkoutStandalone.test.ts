import { describe, expect, it } from "vitest";
import {
  CHECKOUT_IDEMPOTENCY_KEY_HEADER,
  validateCheckoutIdempotencyHeader,
  type CheckoutIdempotencyRejection,
} from "@openlup/core/checkout";

const SAMPLE_UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const UUID_V1_SAMPLE = "9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d";

describe("checkout standalone smoke", () => {
  it("exposes the neutral idempotency header contract", () => {
    expect(CHECKOUT_IDEMPOTENCY_KEY_HEADER).toBe("idempotency-key");

    const result = validateCheckoutIdempotencyHeader(` ${SAMPLE_UUID} `);
    expect(result).toEqual({ ok: true, key: SAMPLE_UUID });
  });

  it("classifies rejected idempotency keys without persistence coupling", () => {
    const missing = validateCheckoutIdempotencyHeader(undefined);
    const malformed = validateCheckoutIdempotencyHeader("not-a-uuid");
    const wrongVersion = validateCheckoutIdempotencyHeader(UUID_V1_SAMPLE);

    expect(readReason(missing)).toBe("missing");
    expect(readReason(malformed)).toBe("malformed");
    expect(readReason(wrongVersion)).toBe("malformed");
  });
});

function readReason(
  result: ReturnType<typeof validateCheckoutIdempotencyHeader>,
): CheckoutIdempotencyRejection["reason"] | null {
  return result.ok === false ? result.rejection.reason : null;
}

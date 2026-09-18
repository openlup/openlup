import { describe, expect, it } from "vitest";

import {
  CHECKOUT_RECOVERY_TOKEN_PREFIX,
  generateCheckoutRecoveryToken,
  hashCheckoutRecoveryToken,
} from "./checkoutRecoveryToken.js";

describe("checkout recovery token", () => {
  it("hashes deterministically as SHA-256 hex (matches the SQL encode(sha256(...)))", () => {
    // sha256("token") known vector.
    expect(hashCheckoutRecoveryToken("token")).toBe(
      "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0",
    );
    expect(hashCheckoutRecoveryToken("a")).toBe(hashCheckoutRecoveryToken("a"));
    expect(hashCheckoutRecoveryToken("a")).not.toBe(hashCheckoutRecoveryToken("b"));
  });

  it("generates distinct URL-safe tokens with the quoted-printable-safe prefix", () => {
    const a = generateCheckoutRecoveryToken();
    const b = generateCheckoutRecoveryToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
    // The link rides as `?token=<token>` inside a quoted-printable email body;
    // a NON-hex first char keeps the `=` separator from being eaten as an escape.
    expect(a.startsWith(CHECKOUT_RECOVERY_TOKEN_PREFIX)).toBe(true);
    expect(a[0]).not.toMatch(/[0-9a-fA-F]/);
  });
});

import { describe, expect, it } from "vitest";
import { createNodeCheckoutResumeTokenCodec } from "./checkoutResumeToken.js";

describe("checkout resume token codec", () => {
  it("generates deterministic URL-safe tokens for idempotent create requests", () => {
    const codec = createNodeCheckoutResumeTokenCodec(
      "12345678901234567890123456789012",
    );

    const first = codec.generateToken({ idempotencyKey: "resume-2026-06-06" });
    const second = codec.generateToken({ idempotencyKey: "resume-2026-06-06" });

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codec.hashToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(codec.hashIdempotencyKey("resume-2026-06-06")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates random URL-safe tokens when no idempotency key is supplied", () => {
    const codec = createNodeCheckoutResumeTokenCodec(
      "12345678901234567890123456789012",
    );

    const first = codec.generateToken();
    const second = codec.generateToken();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

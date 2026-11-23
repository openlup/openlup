import { describe, expect, it } from "vitest";
import {
  formatPublicSignupRateLimitMessage,
  hashRateLimitKey,
} from "./publicSignupRateLimit.js";

describe("hashRateLimitKey", () => {
  it("is deterministic for the same input", () => {
    expect(hashRateLimitKey("ala@example.com")).toBe(
      hashRateLimitKey("ala@example.com"),
    );
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(hashRateLimitKey("  Ala@Example.COM  ")).toBe(
      hashRateLimitKey("ala@example.com"),
    );
  });

  it("produces a 64-character hex digest", () => {
    expect(hashRateLimitKey("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs", () => {
    expect(hashRateLimitKey("a")).not.toBe(hashRateLimitKey("b"));
  });
});

describe("formatPublicSignupRateLimitMessage", () => {
  it("returns the email-quota message when reason is email_quota", () => {
    expect(formatPublicSignupRateLimitMessage("email_quota")).toMatch(/email/i);
  });

  it("returns the IP message when reason is ip_quota", () => {
    expect(formatPublicSignupRateLimitMessage("ip_quota")).toMatch(/adresu/i);
  });

  it("returns the IP message when reason is undefined", () => {
    expect(formatPublicSignupRateLimitMessage(undefined)).toMatch(/adresu/i);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractClientIp,
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

describe("extractClientIp", () => {
  it("prefers x-forwarded-for, returning the first hop", () => {
    expect(
      extractClientIp({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 192.168.0.1" }),
    ).toBe("1.2.3.4");
  });

  it("falls back to cf-connecting-ip when x-forwarded-for is missing", () => {
    expect(extractClientIp({ "cf-connecting-ip": "5.6.7.8" })).toBe("5.6.7.8");
  });

  it("falls back to x-real-ip when others are missing", () => {
    expect(extractClientIp({ "x-real-ip": "7.7.7.7" })).toBe("7.7.7.7");
  });

  it("returns 'unknown' when no candidate header is set", () => {
    expect(extractClientIp({})).toBe("unknown");
  });

  it("trims whitespace from the chosen hop", () => {
    expect(extractClientIp({ "x-forwarded-for": "  9.9.9.9  , 8.8.8.8" })).toBe(
      "9.9.9.9",
    );
  });

  it("handles array-shaped header values", () => {
    expect(
      extractClientIp({
        "x-forwarded-for": ["3.3.3.3, 4.4.4.4", "should-be-ignored"],
      }),
    ).toBe("3.3.3.3");
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

import { describe, expect, it } from "vitest";
import { resolveResendApiKey } from "./resendApiKey.js";

describe("resolveResendApiKey", () => {
  it("resolves the live key when no provider mode is set", () => {
    expect(resolveResendApiKey({ RESEND_API_KEY: "re_live_123" })).toEqual({
      apiKey: "re_live_123",
      mode: "live",
    });
  });

  it("resolves the sandbox key when RESEND_PROVIDER_MODE=sandbox", () => {
    expect(
      resolveResendApiKey({
        RESEND_PROVIDER_MODE: "sandbox",
        RESEND_SANDBOX_API_KEY: "re_sb_123",
        // A live key may be absent on preview (the guard forbids it).
      }),
    ).toEqual({ apiKey: "re_sb_123", mode: "sandbox" });
  });

  it("ignores the live key in sandbox mode and reports missing when the sandbox key is absent", () => {
    expect(
      resolveResendApiKey({ RESEND_PROVIDER_MODE: "sandbox", RESEND_API_KEY: "re_live_123" }),
    ).toEqual({ apiKey: undefined, mode: "sandbox" });
  });

  it("returns undefined in live mode when no key is present", () => {
    expect(resolveResendApiKey({})).toEqual({ apiKey: undefined, mode: "live" });
  });

  it("treats blank/whitespace keys as missing and trims real keys", () => {
    expect(resolveResendApiKey({ RESEND_API_KEY: "   " }).apiKey).toBeUndefined();
    expect(resolveResendApiKey({ RESEND_API_KEY: "  re_x  " }).apiKey).toBe("re_x");
  });

  it("is case-insensitive and trims the provider mode", () => {
    expect(
      resolveResendApiKey({ RESEND_PROVIDER_MODE: "  SANDBOX ", RESEND_SANDBOX_API_KEY: "re_sb" }).mode,
    ).toBe("sandbox");
  });
});

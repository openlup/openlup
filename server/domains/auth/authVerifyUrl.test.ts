import { describe, expect, it } from "vitest";

import { buildAuthVerifyUrl } from "./authVerifyUrl.js";

const SERVICE = "https://project.supabase.co";
const REDIRECT = "https://app.example/konto/auth/callback";

describe("buildAuthVerifyUrl", () => {
  it("percent-encodes the first byte of the token so a template cannot split on it", () => {
    // The endpoint reads the hashed token from a RAW query separator, so the
    // leading byte is escaped rather than left literal. This is the rule the
    // module exists to keep in one place: the hook composes the link and
    // scripts/customer-auth-get-verify.ts probes the real endpoint with the same
    // builder, which is the only reason that probe catches a token/token_hash
    // flip (#1032/#1034) instead of proving a URL it wrote itself.
    const url = buildAuthVerifyUrl(SERVICE, "recovery", "pkce_abc", REDIRECT);

    expect(url.startsWith(`${SERVICE}/auth/v1/verify?token=%70kce_abc&`)).toBe(true);
    expect(url).not.toContain("token=pkce_abc");
  });

  it("escapes the rest of the token and the redirect exactly once", () => {
    const url = buildAuthVerifyUrl(SERVICE, "magiclink", "a b+c", "https://app.example/a?b=c&d=e");

    expect(url).toContain("token=%61%20b%2Bc");
    expect(url).toContain("redirect_to=https%3A%2F%2Fapp.example%2Fa%3Fb%3Dc%26d%3De");
    expect(url).not.toContain("redirect_to=https://");
  });

  it("collapses both email-change action types onto the endpoint's single type", () => {
    // GoTrue emits two action types for one verify type. Sending either raw
    // fails the endpoint, so this mapping is behaviour, not cosmetics.
    for (const actionType of ["email_change_current", "email_change_new"]) {
      expect(buildAuthVerifyUrl(SERVICE, actionType, "t", REDIRECT)).toContain("type=email_change&");
    }
    expect(buildAuthVerifyUrl(SERVICE, "recovery", "t", REDIRECT)).toContain("type=recovery&");
  });

  it("does not double a trailing slash on the auth service origin", () => {
    expect(buildAuthVerifyUrl(`${SERVICE}///`, "signup", "t", REDIRECT).startsWith(`${SERVICE}/auth/v1/verify?`)).toBe(true);
  });

  it("returns an empty token rather than inventing an escape for one", () => {
    expect(buildAuthVerifyUrl(SERVICE, "invite", "", REDIRECT)).toContain("token=&");
  });
});

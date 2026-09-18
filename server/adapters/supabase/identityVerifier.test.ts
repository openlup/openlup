import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseIdentityVerifier } from "./identityVerifier.js";

function clientReturning(result: { data: unknown; error: unknown }): SupabaseClient {
  return { auth: { getUser: vi.fn(async () => result) } } as unknown as SupabaseClient;
}

describe("createSupabaseIdentityVerifier", () => {
  it("returns the principal with emailVerified=true when email_confirmed_at is set", async () => {
    const verifier = createSupabaseIdentityVerifier(
      clientReturning({
        data: { user: { id: "u1", email: "a@b.com", email_confirmed_at: "2026-01-01", user_metadata: {} } },
        error: null,
      }),
    );
    expect(await verifier.verifyAccessToken("tok")).toEqual({
      principalId: "u1",
      email: "a@b.com",
      emailVerified: true,
    });
  });

  it("treats user_metadata.email_verified as verified", async () => {
    const verifier = createSupabaseIdentityVerifier(
      clientReturning({
        data: { user: { id: "u2", email: "c@d.com", email_confirmed_at: null, user_metadata: { email_verified: true } } },
        error: null,
      }),
    );
    expect(await verifier.verifyAccessToken("tok")).toMatchObject({ emailVerified: true });
  });

  it("reports emailVerified=false when neither signal is present", async () => {
    const verifier = createSupabaseIdentityVerifier(
      clientReturning({
        data: { user: { id: "u3", email: "e@f.com", email_confirmed_at: null, user_metadata: {} } },
        error: null,
      }),
    );
    expect(await verifier.verifyAccessToken("tok")).toEqual({
      principalId: "u3",
      email: "e@f.com",
      emailVerified: false,
    });
  });

  it("returns null on error or missing user", async () => {
    const onError = createSupabaseIdentityVerifier(clientReturning({ data: { user: null }, error: { message: "bad" } }));
    expect(await onError.verifyAccessToken("tok")).toBeNull();
    const noUser = createSupabaseIdentityVerifier(clientReturning({ data: { user: null }, error: null }));
    expect(await noUser.verifyAccessToken("tok")).toBeNull();
  });
});

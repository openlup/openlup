import { describe, expect, it, vi } from "vitest";
import type { ManagedIdentityClient as SupabaseClient } from "../../src/identity/managedClient.js";
import { createSupabaseIdentityVerifier } from "../../src/identity/managedIdentityVerifier.js";

function clientReturning(result: { data: unknown; error: unknown }): SupabaseClient {
  return { auth: { getUser: vi.fn(async () => result) } } as unknown as SupabaseClient;
}

describe("createSupabaseIdentityVerifier", () => {
  it("confirmation_fact_verifies_without_metadata", async () => {
    const verifier = createSupabaseIdentityVerifier(
      clientReturning({
        data: { user: { id: "u1", email: "confirmed@example.com", email_confirmed_at: "2026-01-01", user_metadata: {} } },
        error: null,
      }),
    );
    expect(await verifier.verifyAccessToken("tok")).toEqual({
      principalId: "u1",
      email: "confirmed@example.com",
      emailVerified: true,
    });
  });

  it("metadata_true_without_confirmation_is_unverified", async () => {
    const verifier = createSupabaseIdentityVerifier(
      clientReturning({
        data: { user: { id: "u2", email: "metadata@example.com", email_confirmed_at: null, user_metadata: { email_verified: true } } },
        error: null,
      }),
    );
    expect(await verifier.verifyAccessToken("tok")).toMatchObject({ emailVerified: false });
  });

  it("reports emailVerified=false when neither signal is present", async () => {
    const verifier = createSupabaseIdentityVerifier(
      clientReturning({
        data: { user: { id: "u3", email: "unconfirmed@example.com", email_confirmed_at: null, user_metadata: {} } },
        error: null,
      }),
    );
    expect(await verifier.verifyAccessToken("tok")).toEqual({
      principalId: "u3",
      email: "unconfirmed@example.com",
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

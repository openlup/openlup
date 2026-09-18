import { describe, expect, it } from "vitest";
import type {
  AccountLinkStore,
  AdminAuthorizationResult,
  AdminAuthPort,
  CustomerAccount,
  IdentityVerifierPort,
  VerifiedPrincipal,
} from "./ports.js";

// Contract-conformance smoke for the generic auth ports: proves the interfaces
// are implementable with provider-neutral shapes (no Supabase, no vendor types),
// which is the guarantee the OSS core relies on.

describe("auth ports contract", () => {
  it("an IdentityVerifierPort can be implemented and yields a VerifiedPrincipal", async () => {
    const principal: VerifiedPrincipal = {
      principalId: "p1",
      email: "a@b.com",
      emailVerified: true,
    };
    const verifier: IdentityVerifierPort = {
      verifyAccessToken: async (token) => (token ? principal : null),
    };

    expect(await verifier.verifyAccessToken("tok")).toEqual(principal);
    expect(await verifier.verifyAccessToken("")).toBeNull();
  });

  it("an AccountLinkStore can be implemented over a provider-neutral account shape", async () => {
    const account: CustomerAccount = { id: "acct-1", email: "a@b.com", principalId: null };
    const store: AccountLinkStore = {
      findAccountByPrincipalId: async () => null,
      findAccountByEmail: async () => account,
      isReservedPrincipal: async () => false,
      linkPrincipalToAccount: async () => ({ ok: true, alreadyLinked: false }),
      createAccount: async () => ({ id: "acct-new" }),
    };

    expect(await store.findAccountByEmail("a@b.com")).toEqual({ id: "acct-1", email: "a@b.com", principalId: null });
    expect(await store.isReservedPrincipal("p1")).toBe(false);
    expect(await store.linkPrincipalToAccount("acct-1", "p1")).toEqual({
      ok: true,
      alreadyLinked: false,
    });
    expect(await store.createAccount({
      email: "a@b.com",
      principalId: "p1",
      acquisitionSource: "social_signup",
      lifecycleStage: "lead",
    })).toEqual({ id: "acct-new" });
  });

  it("an AdminAuthPort can be implemented and yields a UUID-keep authorization", async () => {
    const granted: AdminAuthorizationResult = {
      ok: true,
      principalId: "auth-uuid-1",
      role: "admin",
      isMachineActor: false,
    };
    const port: AdminAuthPort = {
      authorize: async (token, options) => {
        if (!token) return { ok: false, code: "UNAUTHORIZED", message: "Admin session required" };
        if (options?.allowedRoles && !options.allowedRoles.includes("admin")) {
          return { ok: false, code: "FORBIDDEN", message: "Admin role required" };
        }
        return granted;
      },
    };

    expect(await port.authorize("tok")).toEqual(granted);
    expect(await port.authorize(null)).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Admin session required",
    });
    expect(await port.authorize("tok", { allowedRoles: ["distributor"] })).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
  });
});

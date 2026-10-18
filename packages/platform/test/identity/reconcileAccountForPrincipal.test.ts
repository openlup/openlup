import { createVerifierResultOnlyEmailTrustPolicy } from "../../src/identity/emailTrustPolicy.js";
import { describe, expect, it, vi } from "vitest";
import { reconcileAccountForPrincipal } from "../../src/identity/reconcileAccountForPrincipal.js";
import type { AccountLinkStore, CustomerAccount } from "../../src/identity/ports.js";

function makeStore(overrides: Partial<AccountLinkStore> = {}): AccountLinkStore {
  return {
    findAccountByPrincipalId: vi.fn(async () => null),
    findAccountByEmail: vi.fn(async () => null),
    isReservedPrincipal: vi.fn(async () => false),
    linkPrincipalToAccount: vi.fn(async () => ({ ok: true as const, alreadyLinked: false })),
    createAccount: vi.fn(async () => ({ id: "acct-new" })),
    ...overrides,
  };
}

const VERIFIED = { principalId: "user-1", email: "Buyer@Example.COM", emailVerified: true };

describe("reconcileAccountForPrincipal", () => {
  it("rejects when there is no email", async () => {
    const store = makeStore();
    const result = await reconcileAccountForPrincipal(store, {
      principalId: "user-1",
      email: null,
      emailVerified: false,
    }, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: false, code: "NO_VERIFIED_EMAIL" });
    expect(store.findAccountByPrincipalId).not.toHaveBeenCalled();
  });

  it("rejects when the email is unverified", async () => {
    const store = makeStore();
    const result = await reconcileAccountForPrincipal(store, {
      ...VERIFIED,
      emailVerified: false,
    }, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: false, code: "NO_VERIFIED_EMAIL" });
  });

  it("refuses a reserved principal (a machine/service admin identity)", async () => {
    const store = makeStore({ isReservedPrincipal: vi.fn(async () => true) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: false, code: "RESERVED_PRINCIPAL_REFUSED" });
    expect(store.createAccount).not.toHaveBeenCalled();
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
  });

  it("lets a HUMAN admin self-link to their matching unlinked client", async () => {
    const store = makeStore({
      isReservedPrincipal: vi.fn(async () => false),
      findAccountByEmail: vi.fn(async () => ({ id: "acct-admin", email: "buyer@example.com", principalId: null })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: true, accountId: "acct-admin", created: false, linked: true });
    expect(store.linkPrincipalToAccount).toHaveBeenCalledWith("acct-admin", "user-1");
  });

  it("returns the existing account for a returning principal (idempotent)", async () => {
    const account: CustomerAccount = { id: "acct-1", email: "buyer@example.com", principalId: "user-1" };
    const store = makeStore({ findAccountByPrincipalId: vi.fn(async () => account) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: true, accountId: "acct-1", created: false, linked: false });
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });

  it("returns a conflict when a returning principal account email differs from the verified token email", async () => {
    const account: CustomerAccount = { id: "acct-1", email: "fixture@example.invalid", principalId: "user-1" };
    const store = makeStore({ findAccountByPrincipalId: vi.fn(async () => account) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({
      ok: false,
      code: "PRINCIPAL_EMAIL_MISMATCH",
      existingPrincipalId: "user-1",
    });
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });

  it("relinks an unlinked account matched by verified email (the hot dedup path)", async () => {
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => ({ id: "acct-2", email: "buyer@example.com", principalId: null })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: true, accountId: "acct-2", created: false, linked: true });
    expect(store.findAccountByEmail).toHaveBeenCalledWith("buyer@example.com");
    expect(store.linkPrincipalToAccount).toHaveBeenCalledWith("acct-2", "user-1");
    expect(store.createAccount).not.toHaveBeenCalled();
  });

  it("treats an account already linked to this principal as success", async () => {
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => ({ id: "acct-2", email: "buyer@example.com", principalId: "user-1" })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: true, accountId: "acct-2", created: false, linked: false });
    expect(store.linkPrincipalToAccount).not.toHaveBeenCalled();
  });

  it("never duplicates an email owned by a different principal", async () => {
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => ({ id: "acct-2", email: "buyer@example.com", principalId: "other-user" })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({
      ok: false,
      code: "EMAIL_OWNED_BY_OTHER_PRINCIPAL",
      existingPrincipalId: "other-user",
    });
    expect(store.linkPrincipalToAccount).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });

  it("surfaces a concurrent link conflict on the unlinked-relink path", async () => {
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => ({ id: "acct-2", email: "buyer@example.com", principalId: null })),
      linkPrincipalToAccount: vi.fn(async () => ({ ok: false as const, existingPrincipalId: "other" })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({
      ok: false,
      code: "ACCOUNT_LINK_CONFLICT",
      existingPrincipalId: "other",
    });
  });

  it("creates a fresh empty account for a brand-new principal", async () => {
    const store = makeStore({ createAccount: vi.fn(async () => ({ id: "acct-new" })) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: true, accountId: "acct-new", created: true, linked: true });
    expect(store.createAccount).toHaveBeenCalledWith({
      email: "buyer@example.com",
      principalId: "user-1",
      acquisitionSource: "social_signup",
      lifecycleStage: "lead",
    });
  });

  it("retries the email branch once on a unique-email insert race and relinks", async () => {
    let emailLookups = 0;
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => {
        emailLookups += 1;
        return emailLookups === 1 ? null : { id: "acct-raced", email: "buyer@example.com", principalId: null };
      }),
      createAccount: vi.fn(async () => {
        throw new Error("duplicate key value violates unique constraint");
      }),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy());
    expect(result).toEqual({ ok: true, accountId: "acct-raced", created: false, linked: true });
    expect(emailLookups).toBe(2);
  });

  it("rethrows a createAccount error that is not a recoverable race", async () => {
    const store = makeStore({
      createAccount: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(reconcileAccountForPrincipal(store, VERIFIED, createVerifierResultOnlyEmailTrustPolicy())).rejects.toThrow("db down");
  });
});

describe("email association admission", () => {
  const refused = { assess: vi.fn(async () => ({ trusted: false as const, code: "EMAIL_TRUST_ENVELOPE_REFUSED" as const })) };
  it("email_lookup_link_and_create_are_gated", async () => {
    const store = makeStore();
    expect(await reconcileAccountForPrincipal(store, VERIFIED, refused)).toEqual({ ok: false, code: "EMAIL_TRUST_ENVELOPE_REFUSED" });
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
    expect(store.linkPrincipalToAccount).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });
  it("already_linked_account_does_not_require_email_association", async () => {
    const policy = { assess: vi.fn(async () => { throw new Error("offline"); }) };
    const store = makeStore({ findAccountByPrincipalId: async () => ({ id: "account", email: VERIFIED.email, principalId: VERIFIED.principalId }) });
    expect(await reconcileAccountForPrincipal(store, VERIFIED, policy)).toEqual({ ok: true, accountId: "account", created: false, linked: false });
    expect(policy.assess).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { assess: async () => { throw new Error("private"); } }, { assess: async () => ({ trusted: "yes" }) }])("missing_or_throwing_policy_fails_closed: %j", async policy => {
    const store = makeStore();
    expect(await reconcileAccountForPrincipal(store, VERIFIED, policy as never)).toEqual({ ok: false, code: "EMAIL_TRUST_SETTINGS_UNAVAILABLE" });
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });
  it("declared_provider_and_confirmation_required", async () => {
    const store = makeStore();
    expect(await reconcileAccountForPrincipal(store, { ...VERIFIED, emailVerified: false }, createVerifierResultOnlyEmailTrustPolicy())).toEqual({ ok: false, code: "NO_VERIFIED_EMAIL" });
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
  });
  it("create_conflict_retry_cannot_bypass_policy", async () => {
    const policy = { assess: vi.fn(async () => ({ trusted: true as const })) };
    const store = makeStore({
      findAccountByEmail: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "raced", email: VERIFIED.email, principalId: null }),
      createAccount: vi.fn(async () => { throw new Error("conflict"); }),
    });
    expect(await reconcileAccountForPrincipal(store, VERIFIED, policy)).toMatchObject({ ok: true, accountId: "raced", linked: true });
    expect(policy.assess).toHaveBeenCalledTimes(1);
    expect(policy.assess.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(store.findAccountByEmail).mock.invocationCallOrder[0]);
    const denied = makeStore({ createAccount: vi.fn(async () => { throw new Error("conflict"); }) });
    await reconcileAccountForPrincipal(denied, VERIFIED, refused);
    expect(denied.findAccountByEmail).not.toHaveBeenCalled();
    expect(denied.createAccount).not.toHaveBeenCalled();
  });
});

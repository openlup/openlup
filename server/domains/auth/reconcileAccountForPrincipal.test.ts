import { describe, expect, it, vi } from "vitest";
import { reconcileAccountForPrincipal } from "./reconcileAccountForPrincipal.js";
import type { AccountLinkStore, CustomerAccount } from "./ports.js";

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
    });
    expect(result).toEqual({ ok: false, code: "NO_VERIFIED_EMAIL" });
    expect(store.findAccountByPrincipalId).not.toHaveBeenCalled();
  });

  it("rejects when the email is unverified", async () => {
    const store = makeStore();
    const result = await reconcileAccountForPrincipal(store, {
      ...VERIFIED,
      emailVerified: false,
    });
    expect(result).toEqual({ ok: false, code: "NO_VERIFIED_EMAIL" });
  });

  it("refuses a reserved principal (a machine/service admin identity)", async () => {
    const store = makeStore({ isReservedPrincipal: vi.fn(async () => true) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({ ok: false, code: "RESERVED_PRINCIPAL_REFUSED" });
    expect(store.createAccount).not.toHaveBeenCalled();
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
  });

  it("lets a HUMAN admin self-link to their matching unlinked client", async () => {
    // A human admin is NOT reserved (isReservedPrincipal false); their verified
    // email matches an unlinked client, so they relink their own identity — the
    // stranded staff-buyer fix on the login-time heal path.
    const store = makeStore({
      isReservedPrincipal: vi.fn(async () => false),
      findAccountByEmail: vi.fn(async () => ({ id: "acct-admin", email: "buyer@example.com", principalId: null })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({ ok: true, accountId: "acct-admin", created: false, linked: true });
    expect(store.linkPrincipalToAccount).toHaveBeenCalledWith("acct-admin", "user-1");
  });

  it("returns the existing account for a returning principal (idempotent)", async () => {
    const account: CustomerAccount = { id: "acct-1", email: "buyer@example.com", principalId: "user-1" };
    const store = makeStore({ findAccountByPrincipalId: vi.fn(async () => account) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({ ok: true, accountId: "acct-1", created: false, linked: false });
    expect(store.findAccountByEmail).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });

  it("returns a conflict when a returning principal account email differs from the verified token email", async () => {
    const account: CustomerAccount = { id: "acct-1", email: "fixture@example.invalid", principalId: "user-1" };
    const store = makeStore({ findAccountByPrincipalId: vi.fn(async () => account) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
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
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({ ok: true, accountId: "acct-2", created: false, linked: true });
    // email normalized before lookup + link attempted
    expect(store.findAccountByEmail).toHaveBeenCalledWith("buyer@example.com");
    expect(store.linkPrincipalToAccount).toHaveBeenCalledWith("acct-2", "user-1");
    expect(store.createAccount).not.toHaveBeenCalled();
  });

  it("treats an account already linked to this principal as success", async () => {
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => ({ id: "acct-2", email: "buyer@example.com", principalId: "user-1" })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({ ok: true, accountId: "acct-2", created: false, linked: false });
    expect(store.linkPrincipalToAccount).not.toHaveBeenCalled();
  });

  it("never duplicates an email owned by a different principal", async () => {
    const store = makeStore({
      findAccountByEmail: vi.fn(async () => ({ id: "acct-2", email: "buyer@example.com", principalId: "other-user" })),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
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
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({
      ok: false,
      code: "ACCOUNT_LINK_CONFLICT",
      existingPrincipalId: "other",
    });
  });

  it("creates a fresh empty account for a brand-new principal", async () => {
    const store = makeStore({ createAccount: vi.fn(async () => ({ id: "acct-new" })) });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
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
      // first lookup (pre-insert) finds nothing; post-race lookup finds the row
      findAccountByEmail: vi.fn(async () => {
        emailLookups += 1;
        return emailLookups === 1 ? null : { id: "acct-raced", email: "buyer@example.com", principalId: null };
      }),
      createAccount: vi.fn(async () => {
        throw new Error("duplicate key value violates unique constraint");
      }),
    });
    const result = await reconcileAccountForPrincipal(store, VERIFIED);
    expect(result).toEqual({ ok: true, accountId: "acct-raced", created: false, linked: true });
    expect(emailLookups).toBe(2);
  });

  it("rethrows a createAccount error that is not a recoverable race", async () => {
    const store = makeStore({
      createAccount: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(reconcileAccountForPrincipal(store, VERIFIED)).rejects.toThrow("db down");
  });
});

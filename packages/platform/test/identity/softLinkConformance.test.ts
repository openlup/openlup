import { describe, expect, it, vi } from "vitest";
import { findOrCreateAuthUserId, linkClientAuthUser, type ClientAuthLinkStore } from "../../src/identity/ports.js";
import { createSupabaseClientAuthLinkStore } from "../../src/identity/managedClientAuthLink.js";
import { createSupabaseAccountLinkStore } from "../../src/identity/managedAccountLinkStore.js";
import { reconcileAccountForPrincipal } from "../../src/identity/reconcileAccountForPrincipal.js";
import type { ManagedIdentityClient, ManagedIdentityRow } from "../../src/identity/managedClient.js";

describe("create-first soft-account linking", () => {
  it("creates before any lookup and preserves the linked result", async () => {
    const store: ClientAuthLinkStore = {
      findClientByEmail: vi.fn(async () => ({ id: "account", authUserId: null })),
      createAuthUser: vi.fn(async () => "principal"), findAuthUserIdByEmail: vi.fn(),
      findAuthUserEmailById: vi.fn(), findAdminIdentity: vi.fn(async () => null),
      setClientAuthUserId: vi.fn(async () => ({ ok: true, alreadyLinked: false })),
    };
    expect(await linkClientAuthUser(store, "  User@Example.Invalid ")).toEqual({ ok: true, clientId: "account", authUserId: "principal", created: true, alreadyLinked: false, adminSelfLink: false });
    expect(store.createAuthUser).toHaveBeenCalledWith("user@example.invalid");
    expect(store.findAuthUserIdByEmail).not.toHaveBeenCalled();
  });
  it("looks up only after the already-registered result and refuses an unresolved identity", async () => {
    const events: string[] = [];
    const store = { createAuthUser: async () => { events.push("create"); return null; }, findAuthUserIdByEmail: vi.fn(async () => { events.push("lookup"); return "existing"; }) };
    expect(await findOrCreateAuthUserId(store, "user@example.invalid")).toEqual({ authUserId: "existing", created: false });
    expect(events).toEqual(["create", "lookup"]);
    store.findAuthUserIdByEmail.mockResolvedValueOnce(null as never);
    await expect(findOrCreateAuthUserId(store, "user@example.invalid")).rejects.toThrow("auth_user_registered_but_unresolved");
  });
  it.each([
    { code: "email_exists" }, { code: "user_already_exists" },
    { status: 422, message: "Address already registered" },
    { status: 422, message: "Address already been registered" },
  ])("maps only characterized already-registered responses: %j", async (error) => {
    const client = { auth: { admin: { createUser: vi.fn(async () => ({ data: { user: null }, error })) } } } as unknown as ManagedIdentityClient;
    await expect(createSupabaseClientAuthLinkStore(client).createAuthUser("user@example.invalid")).resolves.toBeNull();
  });
  it("propagates other create failures without directory lookup", async () => {
    const failure = new Error("identity_creation_failed");
    const client = { auth: { admin: { createUser: vi.fn(async () => ({ data: { user: null }, error: failure })) } } } as unknown as ManagedIdentityClient;
    await expect(createSupabaseClientAuthLinkStore(client).createAuthUser("user@example.invalid")).rejects.toBe(failure);
  });
  it("uses normalized paged lookup with nextPage and retains its cap refusal", async () => {
    const listUsers = vi.fn()
      .mockResolvedValueOnce({ data: { users: [], nextPage: 2 }, error: null })
      .mockResolvedValueOnce({ data: { users: [{ id: "existing", email: " USER@example.invalid " }] }, error: null });
    const client = { auth: { admin: { listUsers } } } as unknown as ManagedIdentityClient;
    const store = createSupabaseClientAuthLinkStore(client);
    await expect(store.findAuthUserIdByEmail("user@example.invalid")).resolves.toBe("existing");
    expect(listUsers.mock.calls).toEqual([[{ page: 1, perPage: 1000 }], [{ page: 2, perPage: 1000 }]]);
    listUsers.mockReset().mockResolvedValue({ data: { users: Array.from({ length: 1000 }, () => ({ id: "other" })), nextPage: 2 }, error: null });
    await expect(store.findAuthUserIdByEmail("user@example.invalid")).rejects.toThrow("auth_user_lookup_cap_exceeded");
    expect(listUsers).toHaveBeenCalledTimes(5);
  });
});


// Simulate the database's case-sensitive eq and case-insensitive regex operators.
// The rows are deliberately mixed-case; the use cases supply normalized input.
function contactClient(storedEmail: string) {
  const row = { id: "00000000-0000-4000-8000-000000000001", email: storedEmail, auth_user_id: null };
  let matches = false;
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((_column: string, value: string) => { matches = storedEmail === value; return query; }),
    filter: vi.fn((column: string, operator: string, pattern: string) => {
      expect([column, operator]).toEqual(["email", "imatch"]);
      matches = new RegExp(pattern, "i").test(storedEmail);
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: matches ? [row] : [], error: null })),
    maybeSingle: vi.fn(async () => ({ data: matches ? row : null, error: null })),
  };
  return { client: { from: () => query } as unknown as ManagedIdentityClient, query, row };
}

// Return database candidates directly: PostgreSQL imatch can fold Unicode
// characters that JavaScript's case-insensitive regex does not fold.
function contactCandidates(emails: Array<string | null>) {
  const rows: ManagedIdentityRow[] = emails.map((email, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    email, auth_user_id: null,
  }));
  const query = {
    select: vi.fn(() => query),
    filter: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: rows, error: null })),
    maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
  };
  return { client: { from: () => query } as unknown as ManagedIdentityClient, query, rows };
}

describe.each(["soft-link", "reconcile"] as const)("%s contact lookup", (kind) => {
  const lookup = (client: ManagedIdentityClient, email: string) => kind === "soft-link"
    ? createSupabaseClientAuthLinkStore(client).findClientByEmail(email)
    : createSupabaseAccountLinkStore(client).findAccountByEmail(email);

  it("matches a mixed-case stored contact after input normalization without creating a duplicate", async () => {
    const { client, query, row } = contactClient("Buyer@Example.COM");
    if (kind === "soft-link") {
      const store = {
        ...createSupabaseClientAuthLinkStore(client),
        createAuthUser: vi.fn(async () => "00000000-0000-4000-8000-000000000002"),
        findAdminIdentity: vi.fn(async () => null),
        setClientAuthUserId: vi.fn(async () => ({ ok: true as const, alreadyLinked: false })),
      };
      expect(await linkClientAuthUser(store, "  BUYER@example.com ")).toMatchObject({ ok: true, clientId: row.id });
      expect(store.setClientAuthUserId).toHaveBeenCalledWith(row.id, "00000000-0000-4000-8000-000000000002");
    } else {
      const store = {
        ...createSupabaseAccountLinkStore(client),
        isReservedPrincipal: vi.fn(async () => false),
        findAccountByPrincipalId: vi.fn(async () => null),
        createAccount: vi.fn(async () => { throw new Error("unique_lower_email"); }),
        linkPrincipalToAccount: vi.fn(async () => ({ ok: true as const, alreadyLinked: false })),
      };
      expect(await reconcileAccountForPrincipal(store, { principalId: "00000000-0000-4000-8000-000000000002", email: "  BUYER@example.com ", emailVerified: true })).toEqual({ ok: true, accountId: row.id, created: false, linked: true });
      expect(store.createAccount).not.toHaveBeenCalled();
    }
    expect(query.filter).toHaveBeenCalledWith("email", "imatch", "^buyer@example\\.com$");
    expect(query.eq).not.toHaveBeenCalledWith("email", expect.anything());
  });

  it.each([
    ["a_b@example.com", "axb@example.com"],
    ["a%b@example.com", "axxb@example.com"],
    ["a\\b@example.com", "ab@example.com"],
    ["a*b@example.com", "axxb@example.com"],
    ["a+b@example.com", "aab@example.com"],
    ["a.b@example.com", "axb@example.com"],
    ["a|b@example.com", "a@example.com"],
    ["buyer@example.com", "otherbuyer@example.com"],
    ["buyer@example.com", "buyer@example.com.invalid"],
  ])("matches %s literally and refuses %s", async (email, other) => {
    expect(await lookup(contactClient(email.toUpperCase()).client, email)).not.toBeNull();
    expect(await lookup(contactClient(other).client, email)).toBeNull();
  });

  it.each([
    ["bıyer@example.com", "BIYER@EXAMPLE.COM"],
    ["buſer@example.com", "BUSER@EXAMPLE.COM"],
  ])("rejects database Unicode-folded candidates for %s", async (email, widened) => {
    const { client, query } = contactCandidates([widened]);
    expect(await lookup(client, email)).toBeNull();
    expect(query.select).toHaveBeenCalledWith("id, email, auth_user_id");
    expect(query.limit).toHaveBeenCalledWith(10);
  });

  it("rejects candidates without an email", async () => {
    const { client, rows } = contactCandidates([null, null]);
    delete rows[1].email;
    expect(await lookup(client, "buyer@example.com")).toBeNull();
  });
});

describe("exact normalized contact selection", () => {
  it("soft-links the oldest exact candidate after discarding an older widened row", async () => {
    const email = "bıyer@example.com";
    const { client, query, rows } = contactCandidates(["BIYER@EXAMPLE.COM", " BıYER@EXAMPLE.COM ", email]);
    const store = {
      ...createSupabaseClientAuthLinkStore(client),
      createAuthUser: vi.fn(async () => "00000000-0000-4000-8000-000000000010"),
      findAdminIdentity: vi.fn(async () => null),
      setClientAuthUserId: vi.fn(async () => ({ ok: true as const, alreadyLinked: false })),
    };
    expect(await linkClientAuthUser(store, email)).toMatchObject({ ok: true, clientId: rows[1].id });
    expect(store.setClientAuthUserId).toHaveBeenCalledWith(rows[1].id, "00000000-0000-4000-8000-000000000010");
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(query.limit).toHaveBeenCalledWith(10);
  });

  it("reconciles the single exact candidate after discarding a widened row", async () => {
    const email = "buſer@example.com";
    const { client, rows } = contactCandidates(["BUSER@EXAMPLE.COM", ` ${email} `]);
    expect(await createSupabaseAccountLinkStore(client).findAccountByEmail(email)).toEqual({
      id: rows[1].id, email: rows[1].email, principalId: null,
    });
  });

  it("fails reconciliation closed on multiple exact candidates before linking or creating", async () => {
    const { client } = contactCandidates(["BUYER@example.com", " buyer@example.com "]);
    const store = {
      ...createSupabaseAccountLinkStore(client),
      isReservedPrincipal: vi.fn(async () => false),
      findAccountByPrincipalId: vi.fn(async () => null),
      linkPrincipalToAccount: vi.fn(async () => ({ ok: true as const, alreadyLinked: false })),
      createAccount: vi.fn(async () => ({ id: "00000000-0000-4000-8000-000000000010" })),
    };
    await expect(reconcileAccountForPrincipal(store, {
      principalId: "00000000-0000-4000-8000-000000000010", email: "buyer@example.com", emailVerified: true,
    })).rejects.toMatchObject({ code: "PGRST116" });
    expect(store.linkPrincipalToAccount).not.toHaveBeenCalled();
    expect(store.createAccount).not.toHaveBeenCalled();
  });
});

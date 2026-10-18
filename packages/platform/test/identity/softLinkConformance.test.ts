import { describe, expect, it, vi } from "vitest";
import { findOrCreateAuthUserId, linkClientAuthUser, type ClientAuthLinkStore } from "../../src/identity/ports.js";
import { createSupabaseClientAuthLinkStore } from "../../src/identity/managedClientAuthLink.js";
import type { ManagedIdentityClient } from "../../src/identity/managedClient.js";

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

import { describe, expect, it, vi } from "vitest";
import { createSupabaseClientAuthLinkStore } from "../../src/identity/managedClientAuthLink.js";
import { linkClientAuthUser } from "../../src/identity/ports.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const principalId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const email = "reader@example.com";

function fixture(existing = false) {
  const users = new Map<string, { id: string; email: string; email_confirmed_at: string | null }>();
  if (existing) users.set(principalId, { id: principalId, email, email_confirmed_at: null });
  const contact = { id: accountId, email, auth_user_id: null as string | null };
  const otherContact = { id: "00000000-0000-4000-8000-000000000004", email: "other@example.com", auth_user_id: null as string | null };
  const contacts = [contact, otherContact];
  const events: string[] = [];
  let failure: "conflict" | "error" | null = null;
  const createUser = vi.fn(async (input: { email: string; email_confirm: boolean }) => {
    events.push("create");
    if (users.size) return { data: { user: null }, error: { code: "email_exists" } };
    const user = { id: principalId, email: input.email, email_confirmed_at: input.email_confirm ? "2026-01-01T00:00:00Z" : null };
    users.set(user.id, user);
    return { data: { user }, error: null };
  });
  const listUsers = vi.fn(async () => { events.push("lookup"); return { data: { users: [...users.values()] }, error: null }; });
  const deleteUser = vi.fn(async (id: string) => { users.delete(id); return { error: null }; });
  const client = {
    auth: { admin: { createUser, listUsers, deleteUser,
      getUserById: vi.fn(async (id: string) => ({ data: { user: users.get(id) }, error: null })),
    } },
    from(table: string) {
      type Contact = typeof contact;
      let update: Partial<Contact> | null = null;
      const predicates = new Map<keyof Contact, unknown>();
      const matches = (row: Contact) => [...predicates].every(([key, value]) => row[key] === value);
      const query = {
        select: () => query, filter: () => query, order: () => query,
        eq: (key: keyof Contact, value: unknown) => { predicates.set(key, value); return query; },
        is: (key: keyof Contact, value: unknown) => { predicates.set(key, value); return query; },
        limit: async () => ({ data: [contact], error: null }),
        update: (payload: Partial<Contact>) => { update = payload; return query; },
        maybeSingle: async () => {
          if (table === "admin_users") return { data: null, error: null };
          if (update) {
            events.push("link");
            if (failure === "error") return { data: null, error: new Error("synthetic_link_failure") };
            // A concurrent writer links the contact before the conditional update executes.
            if (failure === "conflict") contact.auth_user_id = otherId;
          }
          const selected = contacts.filter(matches);
          if (update) for (const row of selected) Object.assign(row, update);
          if (selected.length > 1) return { data: null, error: new Error("synthetic_multiple_rows") };
          return { data: selected[0] ?? null, error: null };
        },
      };
      return query;
    },
  };
  return { store: createSupabaseClientAuthLinkStore(client), users, contact, otherContact, events, createUser, listUsers, deleteUser,
    fail: (value: typeof failure) => { failure = value; } };
}

describe("unconfirmed soft-account provisioning", () => {
  it("soft_account_creation_is_unconfirmed", async () => {
    const f = fixture();
    expect(await linkClientAuthUser(f.store, "  READER@Example.COM ")).toEqual({
      ok: true, clientId: accountId, authUserId: principalId, created: true, alreadyLinked: false, adminSelfLink: false,
    });
    expect(f.createUser).toHaveBeenCalledExactlyOnceWith({ email, email_confirm: false });
    expect(f.users.get(principalId)?.email_confirmed_at).toBeNull();
    expect(f.contact.auth_user_id).toBe(principalId);
    expect(f.otherContact.auth_user_id).toBeNull();
    expect(f.events).toEqual(["create", "link"]);
  });

  it("duplicate_recovery_preserves_existing_identity", async () => {
    const f = fixture(true);
    expect(await linkClientAuthUser(f.store, " READER@example.com ")).toMatchObject({ ok: true, authUserId: principalId, created: false });
    expect(f.events).toEqual(["create", "lookup", "link"]);
    expect(await linkClientAuthUser(f.store, email)).toMatchObject({ ok: true, authUserId: principalId, created: false, alreadyLinked: true });
    expect(f.events).toEqual(["create", "lookup", "link"]);
    expect([...f.users.keys()]).toEqual([principalId]);
    expect(f.users.get(principalId)?.email_confirmed_at).toBeNull();
    expect(f.deleteUser).not.toHaveBeenCalled();
  });

  it.each(["conflict", "error"] as const)("failed_link_keeps_created_identity: %s", async (failure) => {
    const f = fixture();
    f.fail(failure);
    if (failure === "error") await expect(linkClientAuthUser(f.store, email)).rejects.toThrow("synthetic_link_failure");
    else expect(await linkClientAuthUser(f.store, email)).toMatchObject({ ok: false, code: "CLIENT_AUTH_LINK_CONFLICT" });
    expect(f.deleteUser).not.toHaveBeenCalled();
    expect([...f.users.keys()]).toEqual([principalId]);
    expect(f.users.get(principalId)?.email_confirmed_at).toBeNull();
    expect(f.contact.auth_user_id).toBe(failure === "conflict" ? otherId : null);
    expect(f.otherContact.auth_user_id).toBeNull();
    // Retry after the competing link is withdrawn or the transient write failure clears.
    f.contact.auth_user_id = null;
    f.fail(null);
    expect(await linkClientAuthUser(f.store, email)).toMatchObject({ ok: true, authUserId: principalId, created: false });
    expect(f.events).toEqual(["create", "link", "create", "lookup", "link"]);
  });
});

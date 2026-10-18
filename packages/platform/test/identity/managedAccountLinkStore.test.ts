import { describe, expect, it } from "vitest";
import type { ManagedIdentityClient as SupabaseClient } from "../../src/identity/managedClient.js";
import { createSupabaseAccountLinkStore } from "../../src/identity/managedAccountLinkStore.js";
function fakeClient(results: Array<{ data?: unknown; error?: unknown }>): SupabaseClient {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "filter", "is", "update", "insert"]) {
    chain[method] = () => chain;
  }
  const next = async () => queue.shift() ?? { data: null, error: null };
  chain.maybeSingle = next;
  chain.single = next;
  chain.limit = next;
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("createSupabaseAccountLinkStore", () => {
  it("maps a clients row to a domain account by principal", async () => {
    const store = createSupabaseAccountLinkStore(
      fakeClient([{ data: { id: "acct-1", email: "buyer@example.com", auth_user_id: "p1" } }]),
    );
    expect(await store.findAccountByPrincipalId("p1")).toEqual({ id: "acct-1", email: "buyer@example.com", principalId: "p1" });
  });

  it("returns null and normalizes a null auth_user_id to unlinked", async () => {
    const missing = createSupabaseAccountLinkStore(fakeClient([{ data: null }]));
    expect(await missing.findAccountByEmail("x@y.com")).toBeNull();

    const unlinked = createSupabaseAccountLinkStore(
      fakeClient([{ data: [{ id: "acct-2", email: "x@y.com", auth_user_id: null }] }]),
    );
    expect(await unlinked.findAccountByEmail("x@y.com")).toEqual({ id: "acct-2", email: "x@y.com", principalId: null });
  });

  it("reserves ONLY machine-actor admin principals", async () => {
    expect(
      await createSupabaseAccountLinkStore(
        fakeClient([{ data: { id: "agent", is_machine_actor: true } }]),
      ).isReservedPrincipal("agent"),
    ).toBe(true);
    expect(
      await createSupabaseAccountLinkStore(
        fakeClient([{ data: { id: "maciej", is_machine_actor: false } }]),
      ).isReservedPrincipal("maciej"),
    ).toBe(false);
    expect(
      await createSupabaseAccountLinkStore(
        fakeClient([{ data: { id: "agent", is_machine_actor: null } }]),
      ).isReservedPrincipal("agent"),
    ).toBe(true);
    expect(
      await createSupabaseAccountLinkStore(fakeClient([{ data: null }])).isReservedPrincipal("p1"),
    ).toBe(false);
  });

  it("links atomically when the row was unlinked", async () => {
    const store = createSupabaseAccountLinkStore(
      fakeClient([{ data: { auth_user_id: "p1" } }]),
    );
    expect(await store.linkPrincipalToAccount("acct-1", "p1")).toEqual({
      ok: true,
      alreadyLinked: false,
    });
  });

  it("reports alreadyLinked when the update no-ops but the row already points at us", async () => {
    const store = createSupabaseAccountLinkStore(
      fakeClient([{ data: null }, { data: { auth_user_id: "p1" } }]),
    );
    expect(await store.linkPrincipalToAccount("acct-1", "p1")).toEqual({
      ok: true,
      alreadyLinked: true,
    });
  });

  it("reports a conflict when the row is owned by a different principal", async () => {
    const store = createSupabaseAccountLinkStore(
      fakeClient([{ data: null }, { data: { auth_user_id: "other" } }]),
    );
    expect(await store.linkPrincipalToAccount("acct-1", "p1")).toEqual({
      ok: false,
      existingPrincipalId: "other",
    });
  });

  it("creates an account and returns its id", async () => {
    const store = createSupabaseAccountLinkStore(fakeClient([{ data: { id: "acct-new" } }]));
    expect(
      await store.createAccount({
        email: "new@x.com",
        principalId: "p1",
        acquisitionSource: "social_signup",
        lifecycleStage: "lead",
      }),
    ).toEqual({ id: "acct-new" });
  });

  it("throws on a create error so the caller can handle the race", async () => {
    const store = createSupabaseAccountLinkStore(
      fakeClient([{ error: new Error("duplicate key") }]),
    );
    await expect(
      store.createAccount({
        email: "new@x.com",
        principalId: "p1",
        acquisitionSource: "social_signup",
        lifecycleStage: "lead",
      }),
    ).rejects.toThrow("duplicate key");
  });
});

import { expect, it, vi } from "vitest";
import { createManagedPrivacyStore } from "../../src/identity/managedPrivacy.js";
import { createIdentityPersonalDataContributor } from "../../src/identity/identityPersonalDataContributor.js";
import { createPersonalDataContributorRegistry } from "../../src/identity/personalDataRegistry.js";
import { erasePersonalData, exportPersonalData } from "../../src/identity/privacyUseCases.js";
import type { ManagedIdentityClient } from "../../src/identity/managedClient.js";
const C = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
it("managed erasure refuses before any database, transaction or provider call", async () => {
  const run = vi.fn(async () => { throw new Error("must not run"); });
  const store = createManagedPrivacyStore();
  const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, { retainedContactFields: {} }, () => C)], { requiredContributorIds: ["identity"] });
  await expect(erasePersonalData({ store, registry, unitOfWork: { run }, now: () => new Date(), randomId: () => C }, { principalId: P }, { subject: { kind: "contact", contactId: C }, idempotencyKey: P })).rejects.toThrow("MANAGED_PRIVACY_ERASURE_UNAVAILABLE");
  expect(run).not.toHaveBeenCalled();
  await expect(store.prepareErasure(null as never)).rejects.toThrow("MANAGED_PRIVACY_ERASURE_UNAVAILABLE");
});
it("managed export uses granted columns, only persisted links, excludes provider secrets and reports missing coverage", async () => {
  const selections: string[] = [];
  const from = vi.fn((table: string) => {
    const query = { select(columns: string) { selections.push(`${table}:${columns}`); return query; }, eq: vi.fn(() => query),
      maybeSingle: async () => ({ data: table === "clients" ? { id: C, auth_user_id: P, email: "person@example.com", first_name: "Example" } : { id: P, role: "admin", membership_state: "active", is_machine_actor: false }, error: null }) };
    return query;
  });
  const getUserById = vi.fn(async () => ({ data: { user: { id: P, email: "person@example.com", app_metadata: { secret: "excluded" }, user_metadata: { access_token: "excluded" } } }, error: null }));
  const client = { from, auth: { admin: { getUserById } } } as unknown as ManagedIdentityClient;
  const store = createManagedPrivacyStore(); const identity = createIdentityPersonalDataContributor(store, { retainedContactFields: {} }, () => C);
  const result = await exportPersonalData({ store, registry: createPersonalDataContributorRegistry([identity], { requiredContributorIds: ["identity", "subscriptions"] }), unitOfWork: { run: work => work(client) }, now: () => new Date("2026-01-01"), randomId: () => C }, { principalId: P }, { kind: "contact", contactId: C });
  expect(result.documents[0].coverage.complete).toBe(false);
  expect(result.documents[0].coverage.unavailable).toContain("contact.country");
  expect(result.missingContributors).toEqual(["subscriptions"]);
  expect(JSON.stringify(result)).not.toContain("excluded");
  expect(getUserById).toHaveBeenCalledWith(P);
  expect(selections).toEqual(["clients:id, email, auth_user_id, first_name, last_name, phone", "admin_users:id, membership_state, role, is_machine_actor"]);
});

import type { Pool } from "pg";
import { createDirectOperatorInvitationStore } from "../../src/identity/directOperatorInvitationStore.js";
import { createPostgresCustomerChallengeStore } from "../../src/identity/postgresCustomerRecovery.js";
import { expect, it, vi } from "vitest";
import type { PgQueryExecutor } from "../../src/data/index.js";
import { createPostgresPrivacyStore } from "../../src/identity/postgresPrivacy.js";
import { createIdentityPersonalDataContributor } from "../../src/identity/identityPersonalDataContributor.js";
const C = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222", A = "33333333-3333-4333-8333-333333333333", K = "44444444-4444-4444-8444-444444444444";
function executor(respond: (sql: string, values: unknown[]) => Record<string, unknown>[] = () => []) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => ({ rows: respond(sql, values) }));
  return { query, db: { query } as unknown as PgQueryExecutor };
}
const subject = { contactId: C, principalId: P, identity: { contact: { id: C, principal_id: P, email: "person@example.com", metadata: {} }, membership: null } };
const actor = { principalId: A };
it("pseudonymization preserves contact IDs, auth links and unrelated subjects while deleting every owned challenge", async () => {
  const other = { id: K, principal_id: A, auth_user_id: A, email: "other@example.com" };
  const contact = { id: C, principal_id: P, auth_user_id: P, email: "person@example.com", first_name: "Example", last_name: "Person", phone: "000", country: "XX" };
  const beforeOther = structuredClone(other);
  const { db, query } = executor((sql, values) => {
    if (sql.startsWith("UPDATE public.clients")) {
      expect(values[0]).toBe(C); expect(sql).toMatch(/WHERE id = \$1$/);
      expect(sql.split("WHERE")[0]).not.toMatch(/\bid\s*=|auth_user_id\s*=/);
      contact.email = String(values[1]); contact.principal_id = null as never;
      contact.first_name = contact.last_name = contact.phone = contact.country = null as never;
    }
    return [];
  });
  await createPostgresPrivacyStore().eraseIdentity(db, subject, actor, `erased+${K}@identity.invalid`);
  expect(contact).toEqual({ id: C, principal_id: null, auth_user_id: P, email: `erased+${K}@identity.invalid`, first_name: null, last_name: null, phone: null, country: null });
  expect(other).toEqual(beforeOther);
  const calls = query.mock.calls;
  expect(calls).toContainEqual(["DELETE FROM public.customer_identity_challenges WHERE client_id = $1", [C]]);
  expect(calls).toContainEqual(["DELETE FROM public.operator_identity_challenges WHERE principal_id = $1", [P]]);
  expect(calls.some(([sql]) => /DELETE FROM public.(clients|platform_human_principals)/.test(sql))).toBe(false);
  expect(calls.some(([sql]) => sql.includes("phase <> 'accepted'"))).toBe(true);
  expect(calls.some(([sql]) => sql.includes("old_value - 'email_key'"))).toBe(true);
});
it("self-erasure and machine principals refuse without writes; active membership uses guarded authority", async () => {
  const f = executor(); const store = createPostgresPrivacyStore();
  await expect(store.eraseIdentity(f.db, subject, { principalId: P }, "erased@example.invalid")).rejects.toThrow("PRIVACY_PROTECTED_OPERATOR");
  expect(f.query).not.toHaveBeenCalled();
  const active = { ...subject, identity: { ...subject.identity, membership: { membership_state: "active" } } };
  await store.eraseIdentity(f.db, active, actor, "erased@example.invalid");
  expect(f.query).toHaveBeenCalledWith("SELECT public.platform_revoke_human_membership($1, $2, $3)", [A, P, "identity erasure"]);
});
it("opaque ownership refuses, while explicit retain declarations keep payloads out of the export", async () => {
  const f = executor(), store = createPostgresPrivacyStore();
  const opaque = { ...subject, identity: { contact: { ...subject.identity.contact, metadata: { arbitrary: "personal" } } } };
  const identity = createIdentityPersonalDataContributor(store, { retainedContactFields: {} }, () => K);
  await expect(identity.assessErasure(f.db, opaque)).rejects.toThrow("PRIVACY_OWNERSHIP_UNDECLARED");
  const declared = createIdentityPersonalDataContributor(store, { retainedContactFields: { metadata: { owner: "contact-extension", resource: "clients.metadata", disposition: "retain", reasonCode: "OWNER_RETENTION", remote: false } } }, () => K);
  expect((await declared.assessErasure(f.db, opaque)).obligations).toContainEqual(expect.objectContaining({ resource: "clients.metadata", disposition: "retain" }));
  const exported = await declared.export(f.db, opaque);
  expect(exported.coverage.unavailable).toContain("contact.metadata"); expect(JSON.stringify(exported.data)).not.toContain("personal");
});
it("receipt key binds to the persisted subject and repeats return the original identity", async () => {
  const row = { client_id: C, principal_id: P, idempotency_key: K, contract_version: "identity.erasure.v1", erasure_id: A, completed_at: new Date("2026-01-01T00:00:00.123Z"), retained_obligations: [] };
  const { db } = executor(() => [row]); const store = createPostgresPrivacyStore();
  expect(await store.findReceipt(db, { kind: "contact", contactId: C }, K)).toMatchObject({ erasureId: A, completedAt: "2026-01-01T00:00:00.123Z" });
  expect(await store.findReceipt(db, { kind: "principal", principalId: P }, K)).toMatchObject({ erasureId: A, completedAt: "2026-01-01T00:00:00.123Z" });
  await expect(store.findReceipt(db, { kind: "contact", contactId: A }, K)).rejects.toThrow("PRIVACY_IDEMPOTENCY_CONFLICT");
});
it("receipt preparation refuses unsafe effective privileges and takes the challenge relation before subject locks", async () => {
  const f = executor(sql => sql.includes("AS unsafe") ? [{ unsafe: true }] : []);
  await expect(createPostgresPrivacyStore().prepareErasure(f.db)).rejects.toThrow("PRIVACY_STORE_PRIVILEGES_UNSAFE");
  const safe = executor(sql => sql.includes("AS unsafe") ? [{ unsafe: false }] : []);
  await createPostgresPrivacyStore().prepareErasure(safe.db);
  expect(safe.query.mock.calls.at(-1)).toEqual(["LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE"]);
});

it("deleted customer challenges cannot redeem after erasure and waiting issuance rechecks the receipt", async () => {
  let challenge = true, erased = false;
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith("DELETE FROM public.customer_identity_challenges")) challenge = false;
    if (sql.startsWith("UPDATE public.clients")) erased = true;
    if (sql.includes("SELECT public.customer_identity_challenge_redeem")) return { rows: [{ result: challenge ? { principalId: P, email: "person@example.com" } : null }] };
    if (sql.includes("SELECT 1 FROM public.clients c JOIN public.identity_privacy_erasures")) return { rows: erased ? [{ present: true }] : [] };
    return { rows: [] };
  });
  const db = { query } as unknown as PgQueryExecutor;
  const store = createPostgresCustomerChallengeStore({ connectionString: "unused" }, { poolFactory: () => ({ connect: async () => ({ query, release() {} }), end: async () => {} }) as unknown as Pool });
  await createPostgresPrivacyStore().eraseIdentity(db, subject, actor, "erased@example.invalid");
  expect(await store.redeem({ tokenHash: "a".repeat(64), now: "2026-01-01T00:00:00Z" })).toBeNull();
  expect(await store.issue({ email: "erased@example.invalid", tokenHash: "b".repeat(64), expiresAt: "2026-01-01T00:10:00Z" })).toEqual({ deliverable: false });
  const lockIndex = statements.findIndex(sql => sql.includes("LOCK TABLE public.customer_identity_challenges"));
  expect(statements.findIndex(sql => sql.includes("customer_identity_challenge_redeem"))).toBeGreaterThan(lockIndex);
  expect(statements.some(sql => sql.includes("SELECT public.customer_identity_challenge_issue"))).toBe(false);
  await store.close();
});
it("customer prune uses expiry, strict retention cutoff and a separate bounded batch", async () => {
  const { query } = executor(() => []);
  const store = createPostgresCustomerChallengeStore({ connectionString: "unused" }, { poolFactory: () => ({ connect: async () => ({ query, release() {} }), end: async () => {} }) as unknown as Pool });
  await expect(store.pruneChallenges({ limit: 501 })).rejects.toThrow("customer_prune_limit_invalid");
  expect(await store.pruneChallenges({ limit: 500 })).toEqual({ deleted: 0 });
  expect(query.mock.calls.find(([sql]) => sql.includes("WITH batch"))).toEqual([expect.stringContaining("expires_at < clock_timestamp() - interval '24 hours'"), [500]]);
  await store.close();
});

it("resolution follows persisted principal links even when another subject has the same email", async () => {
  const { db, query } = executor((sql, values) => {
    if (sql.startsWith("SELECT c.*")) {
      expect(sql).toContain("WHERE c.principal_id = $1"); expect(values).toEqual([P]);
      return [{ id: C, principal_id: P, email: "same@example.com" }];
    }
    if (sql.startsWith("SELECT principal_id, email")) return [{ principal_id: P, email: "same@example.com" }];
    return [];
  });
  const resolved = await createPostgresPrivacyStore().resolve(db, { kind: "principal", principalId: P });
  expect(resolved).toMatchObject({ contactId: C, principalId: P });
  expect(query.mock.calls.some(([sql]) => /lower|btrim|WHERE.*email/.test(sql))).toBe(false);
});
it("erased operator invitation issue and activation refuse without reintroducing authority", async () => {
  const { query } = executor(sql => sql.startsWith("SELECT principal_id, email") ? [{ principal_id: P, email: "erased@example.invalid" }]
    : sql.startsWith("SELECT role, membership_state") ? [{ role: "admin", membership_state: "active" }]
    : sql.includes("AS present") ? [{ present: false }]
    : sql.startsWith("SELECT 1 FROM public.identity_privacy_erasures") ? [{ present: true }] : []);
  const store = createDirectOperatorInvitationStore({ connectionString: "unused" }, { poolFactory: () => ({ connect: async () => ({ query, release() {} }), end: async () => {} }) as unknown as Pool });
  expect(await store.issue({ actorPrincipalId: A, targetPrincipalId: P, email: "erased@example.invalid", role: "distributor", ttlSeconds: 600 })).toEqual({ code: "IDENTITY_CONFLICT" });
  expect(await store.acceptOperatorInvitation(P)).toEqual({ code: "INVITATION_REVOKED" });
  expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE public/.test(sql))).toBe(false);
  await store.close();
});

it("already revoked membership redacts its reason under the existing guard without changing lifecycle or role", async () => {
  let enabled = false, reason: string | null = "person@example.com";
  const { db, query } = executor((sql, values) => {
    if (sql.includes("current_setting('app.platform_human_membership_revoke'")) return [{ previous: "" }];
    if (sql === "SELECT set_config('app.platform_human_membership_revoke', 'true', true)") enabled = true;
    if (sql.startsWith("UPDATE public.platform_human_memberships")) {
      if (!enabled) throw new Error("platform_human_membership_lifecycle_update_forbidden");
      expect(sql).toBe("UPDATE public.platform_human_memberships SET membership_revocation_reason = NULL WHERE principal_id = $1 AND membership_state = 'revoked'");
      expect(values).toEqual([P]); reason = null;
    }
    if (sql === "SELECT set_config('app.platform_human_membership_revoke', $1, true)") enabled = values[0] === "true";
    return [];
  });
  await createPostgresPrivacyStore().eraseIdentity(db, { ...subject, identity: { ...subject.identity, membership: { membership_state: "revoked", role: "distributor", membership_revocation_reason: reason } } }, actor, "erased@example.invalid");
  expect(reason).toBeNull(); expect(enabled).toBe(false);
  expect(query.mock.calls.some(([sql]) => sql.includes("SELECT public.platform_revoke_human_membership"))).toBe(false);
});


it.each(["contact", "principal"] as const)("customer challenge operations refuse a retained %s receipt before either RPC", async receiptKind => {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("JOIN public.identity_privacy_erasures e")) {
      const predicate = receiptKind === "contact" ? "e.client_id = c." : "e.principal_id = c.principal_id";
      return { rows: sql.includes(predicate) ? [{ present: true }] : [] };
    }
    if (sql.includes("customer_identity_challenge_redeem(")) return { rows: [{ result: { principalId: P, email: "person@example.com" } }] };
    if (sql.includes("customer_identity_challenge_issue(")) return { rows: [{ result: { deliverable: true } }] };
    return { rows: [] };
  });
  const store = createPostgresCustomerChallengeStore({ connectionString: "unused" }, { poolFactory: () => ({ connect: async () => ({ query, release() {} }), end: async () => {} }) as unknown as Pool });
  try {
    expect(await store.redeem({ tokenHash: "c".repeat(64), now: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(await store.issue({ email: "person@example.com", tokenHash: "d".repeat(64), expiresAt: "2026-01-01T00:10:00Z" })).toEqual({ deliverable: false });
    expect(statements.filter(sql => sql.includes("SELECT public.customer_identity_challenge_"))).toEqual([]);
    expect(statements.filter(sql => sql === "BEGIN")).toHaveLength(2);
    expect(statements.filter(sql => sql === "COMMIT")).toHaveLength(2);
    for (const transaction of statements.join(";").split("BEGIN;").slice(1)) {
      const lockIndex = transaction.indexOf("LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE");
      expect(lockIndex).toBeGreaterThanOrEqual(0);
      expect(lockIndex).toBeLessThan(transaction.indexOf("JOIN public.identity_privacy_erasures"));
    }
  } finally { await store.close(); }
});

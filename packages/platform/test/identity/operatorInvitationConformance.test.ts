import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDirectOperatorInvitationStore } from "../../src/identity/directOperatorInvitationStore.js";
const principal = "d4000000-0000-4000-8000-000000000002";
const actor = "d4000000-0000-4000-8000-000000000001";
const pending = { principal_id: principal, invitation_id: "d4000000-0000-4000-8000-000000000003", role: "distributor", phase: "invited", invited_at: "2026-10-18T12:00:00Z", expires_at: "2026-10-25T12:00:00Z" };
function directFixture(options: { revoked?: boolean; accepted?: boolean; failAudit?: boolean; expired?: boolean; machine?: boolean } = {}) {
  const statements: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    if (sql.startsWith("SELECT principal_id, email")) return { rows: [{ principal_id: principal, email: "member@example.com" }] };
    if (sql.includes("FROM public.platform_control_operators")) return { rows: [{ present: options.machine ?? false }] };
    if (sql.includes("SELECT role, membership_state")) return { rows: [{ role: "admin", membership_state: "active" }] };
    if (sql.includes("SELECT * FROM public.platform_human_memberships")) return { rows: options.revoked ? [{ principal_id: principal, role: "admin", membership_state: "revoked" }] : [] };
    if (sql.includes("SELECT * FROM public.identity_operator_invitations")) return { rows: [{ ...pending, phase: options.accepted ? "accepted" : "invited" }] };
    if (sql.startsWith("SELECT clock_timestamp() >=")) return { rows: [{ expired: options.expired ?? false }] };
    if (sql.startsWith("WITH stamp AS (SELECT clock_timestamp() AS at) SELECT")) return { rows: [{ at: "2026-10-18T12:01:00Z", expired: false }] };
    if (sql.startsWith("SELECT current_setting")) return { rows: [{ previous: "previous-value" }] };
    if (sql.includes("UPDATE public.identity_operator_invitations SET phase = 'accepted'")) return { rows: [{ ...pending, phase: "accepted" }] };
    if (sql.includes("UPDATE public.identity_operator_invitations SET phase = 'cancelled'")) return { rows: [{ ...pending, phase: "cancelled" }] };
    if (sql.includes("UPDATE public.identity_operator_invitations SET phase = 'expired'")) return { rows: [{ ...pending, phase: "expired" }] };
    if (sql.includes("INSERT INTO public.identity_operator_invitation_events") && options.failAudit) throw new Error("audit_write_failed");
    return { rows: [] };
  });
  const release = vi.fn(); const client = { query, release };
  const pool = { connect: vi.fn(async () => client), end: vi.fn() } as unknown as Pool;
  const store = createDirectOperatorInvitationStore({ connectionString: "unused" }, { poolFactory: () => pool });
  return { store, statements, query, release };
}
describe("direct invitation command transaction protocol", () => {
  it("reactivation uses existing guard setting and two ordered updates, all inside one transaction", async () => {
    const f = directFixture({ revoked: true });
    expect(await f.store.acceptOperatorInvitation(principal)).toEqual({ code: "ACTIVATED", role: "distributor" });
    const statements = f.statements.map((v) => v.sql);
    expect(statements[0]).toBe("BEGIN"); expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.filter((v) => v.includes("UPDATE public.platform_human_memberships"))).toHaveLength(2);
    const enabled = statements.indexOf("SELECT set_config('app.platform_human_membership_revoke', 'true', true)");
    const lifecycle = statements.findIndex((v) => v.includes("SET membership_state = 'active'"));
    const role = statements.indexOf("UPDATE public.platform_human_memberships SET role = $2 WHERE principal_id = $1");
    const audit = statements.findIndex((v) => v.includes("INSERT INTO public.identity_operator_invitation_events"));
    expect(enabled).toBeGreaterThan(0); expect(lifecycle).toBeGreaterThan(enabled); expect(role).toBeGreaterThan(lifecycle); expect(audit).toBeGreaterThan(role);
    expect(f.statements).toContainEqual({ sql: "SELECT set_config('app.platform_human_membership_revoke', $1, true)", values: ["previous-value"] });
    expect(statements.some((v) => v.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("audit failure rolls back membership and invitation instead of committing partial acceptance", async () => {
    const f = directFixture({ failAudit: true });
    await expect(f.store.acceptOperatorInvitation(principal)).rejects.toThrow("audit_write_failed");
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.statements.map((v) => v.sql)).not.toContain("COMMIT");
  });
  it("an accepted historical attempt never restores revoked access", async () => {
    const f = directFixture({ revoked: true, accepted: true });
    expect(await f.store.acceptOperatorInvitation(principal)).toEqual({ code: "INVITATION_REVOKED" });
    expect(f.statements.some((v) => v.sql.includes("UPDATE public.platform_human_memberships"))).toBe(false);
  });
  it("expiry uses the serialized database clock and persists one expiry event", async () => {
    const f = directFixture({ expired: true });
    expect(await f.store.acceptOperatorInvitation(principal)).toEqual({ code: "INVITATION_EXPIRED" });
    const lock = f.statements.findIndex((v) => v.sql.includes("pg_advisory_xact_lock"));
    const clock = f.statements.findIndex((v) => v.sql.startsWith("SELECT clock_timestamp() >="));
    expect(lock).toBeGreaterThan(0); expect(clock).toBeGreaterThan(lock);
    const events = f.statements.filter((v) => v.sql.includes("INSERT INTO public.identity_operator_invitation_events"));
    expect(events).toHaveLength(1); expect(events[0].values?.[2]).toBe("expire");
  });
  it("machine principals cannot accept human invitations", async () => {
    const f = directFixture({ machine: true });
    expect(await f.store.acceptOperatorInvitation(principal)).toEqual({ code: "NO_INVITATION" });
    expect(f.statements.some((v) => v.sql.includes("INSERT INTO public.platform_human_memberships"))).toBe(false);
  });
  it("revocation keeps using the existing last-administrator guard function", async () => {
    const f = directFixture();
    f.query.mockImplementation(async (sql, values) => {
      f.statements.push({ sql, values });
      if (sql.includes("SELECT role, membership_state")) return { rows: [{ role: "admin", membership_state: "active" }] };
      if (sql.includes("SELECT principal_id, email")) return { rows: [{ principal_id: principal, email: "member@example.com" }] };
      if (sql.includes("SELECT * FROM public.platform_human_memberships")) return { rows: [{ principal_id: principal, role: "admin", membership_state: "active" }] };
      if (sql.includes("platform_revoke_human_membership")) throw new Error("platform_human_last_admin_lockout");
      return { rows: [] };
    });
    await expect(f.store.remove({ actorPrincipalId: actor, targetPrincipalId: principal })).rejects.toThrow("platform_human_last_admin_lockout");
    expect(f.statements).toContainEqual({ sql: "SELECT public.platform_revoke_human_membership($1, $2, $3)", values: [actor, principal, null] });
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
  });
});

it("issue locks actor and target memberships in deterministic order before individual locks", async () => {
  const f = directFixture();
  expect(await f.store.issue({ actorPrincipalId: actor, targetPrincipalId: principal, email: "member@example.com", role: "distributor", ttlSeconds: 60 })).toMatchObject({ code: "ALREADY_INVITED" });
  const serialization = f.statements.findIndex((v) => v.sql.includes("pg_advisory_xact_lock"));
  const actorLock = f.statements.findIndex((v) => v.sql.includes("FOR SHARE"));
  const ordered = f.statements.findIndex((v) => v.sql.includes("ORDER BY principal_id FOR UPDATE"));
  expect(serialization).toBeGreaterThan(0); expect(ordered).toBeGreaterThan(serialization); expect(actorLock).toBeGreaterThan(ordered);
  expect(f.statements[ordered].values).toEqual([[actor, principal]]);
});
it("remove locks both memberships in deterministic order before authorization", async () => {
  const f = directFixture();
  expect(await f.store.remove({ actorPrincipalId: actor, targetPrincipalId: principal })).toEqual({ revoked: true });
  const ordered = f.statements.findIndex((v) => v.sql.includes("ORDER BY principal_id FOR UPDATE"));
  const actorLock = f.statements.findIndex((v) => v.sql.includes("FOR SHARE"));
  expect(ordered).toBeGreaterThan(0); expect(actorLock).toBeGreaterThan(ordered);
  expect(f.statements[ordered].values).toEqual([[actor, principal]]);
});

it("pending cancellation records a cancel event without an existing membership", async () => {
  const f = directFixture();
  expect(await f.store.remove({ actorPrincipalId: actor, targetPrincipalId: principal })).toEqual({ revoked: true });
  expect(f.statements.filter((v) => v.sql.includes("SET phase = 'cancelled'"))).toHaveLength(1);
  const events = f.statements.filter((v) => v.sql.includes("INSERT INTO public.identity_operator_invitation_events"));
  expect(events).toHaveLength(1); expect(events[0].values?.[2]).toBe("cancel");
  expect(f.statements.some((v) => v.sql.includes("platform_revoke_human_membership"))).toBe(false);
  expect(f.statements.some((v) => v.sql.includes("DELETE"))).toBe(false);
});

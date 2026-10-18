import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor, type PostgresDataGatewayEnv, type PostgresDataGatewayOptions } from "../data/index.js";
import type { OperatorInvitationStore } from "./operatorInvitationPorts.js";
import type { OperatorInvitationResult, OperatorRole } from "./contracts/operatorInvitations.js";
import { assertOperatorInvitationTtl, invitationFailure } from "./operatorInvitationLifecycle.js";

type Row = Record<string, unknown>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const role = (value: unknown): OperatorRole => value === "distributor" ? "distributor" : "admin";
const snapshot = (row: Row) => ({ principalId: String(row.principal_id), role: role(row.role) });
function result(row: Row, code: OperatorInvitationResult["code"]): OperatorInvitationResult {
  return { ...snapshot(row), code, membershipState: "invited", invitationId: String(row.invitation_id), invitedAt: iso(row.invited_at), expiresAt: iso(row.expires_at) };
}
async function event(db: PgQueryExecutor, action: string, before: Row | null, after: Row, actor: string | null): Promise<void> {
  await db.query(`INSERT INTO public.identity_operator_invitation_events
    (event_id, invitation_id, principal_id, action, actor_kind, actor_principal_id, old_value, new_value, occurred_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, clock_timestamp())`,
  [after.invitation_id, after.principal_id, action, actor ? "human" : "system", actor, JSON.stringify(before ?? {}), JSON.stringify(after)]);
}
async function lock(db: PgQueryExecutor, id: string): Promise<Row | null> {
  const principal = (await db.query("SELECT principal_id, email FROM public.platform_human_principals WHERE principal_id = $1", [id])).rows[0];
  if (!principal) return null;
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`operator_invitation:${String(principal.email).trim().toLowerCase()}`]);
  return principal;
}
async function membership(db: PgQueryExecutor, id: string): Promise<Row | null> {
  return (await db.query("SELECT * FROM public.platform_human_memberships WHERE principal_id = $1 FOR UPDATE", [id])).rows[0] ?? null;
}
async function machine(db: PgQueryExecutor, id: string): Promise<boolean> {
  return (await db.query("SELECT EXISTS (SELECT 1 FROM public.platform_control_operators WHERE principal_id = $1) AS present", [id])).rows[0]?.present === true;
}
async function lockCommandMemberships(db: PgQueryExecutor, actor: string, target: string): Promise<void> {
  // Lock both rows in the same order before taking either actor or target locks.
  await db.query("SELECT principal_id FROM public.platform_human_memberships WHERE principal_id = ANY($1::uuid[]) ORDER BY principal_id FOR UPDATE", [[actor, target]]);
}
async function administrator(db: PgQueryExecutor, id: string): Promise<void> {
  const row = (await db.query("SELECT role, membership_state FROM public.platform_human_memberships WHERE principal_id = $1 FOR SHARE", [id])).rows[0];
  if (row?.role !== "admin" || row.membership_state !== "active" || await machine(db, id)) throw invitationFailure("HUMAN_ADMIN_REQUIRED", "FORBIDDEN");
}
async function invitation(db: PgQueryExecutor, id: string): Promise<Row | null> {
  const row = (await db.query("SELECT * FROM public.identity_operator_invitations WHERE principal_id = $1 FOR UPDATE", [id])).rows[0];
  if (!row) return null;
  // Capture the database clock after serialization; equality is already expired.
  const expiredNow = (await db.query("SELECT clock_timestamp() >= $1::timestamptz AS expired", [row.expires_at])).rows[0]!.expired;
  if (row.phase === "invited" && expiredNow === true) {
    const expired = (await db.query("UPDATE public.identity_operator_invitations SET phase = 'expired', closed_at = expires_at WHERE principal_id = $1 RETURNING *", [id])).rows[0]!;
    await event(db, "expire", row, expired, null);
    return expired;
  }
  return row;
}

/** Owner-authority lane, never the actor gateway. One transaction per command. */
export function createDirectOperatorInvitationStore(env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions = {}): OperatorInvitationStore & { close(): Promise<void> } {
  const lane = createPostgresRoleFreeTransactionLane(env, options);
  const run = <T>(work: (db: PgQueryExecutor) => Promise<T>) => lane.run((db) => work(db as PgQueryExecutor));
  return {
    issue(input) {
      assertOperatorInvitationTtl(input.ttlSeconds);
      return run(async (db) => {
        // Serialize same-target commands, then lock both memberships in order.
        const principal = await lock(db, input.targetPrincipalId);
        await lockCommandMemberships(db, input.actorPrincipalId, input.targetPrincipalId);
        await administrator(db, input.actorPrincipalId);
        const email = input.email.trim().toLowerCase();
        if (!principal || String(principal.email).trim().toLowerCase() !== email || await machine(db, input.targetPrincipalId)) return { code: "IDENTITY_CONFLICT" };
        const member = await membership(db, input.targetPrincipalId);
        if (member?.membership_state === "active") return { code: "MEMBERSHIP_ALREADY_ACTIVE" };
        const previous = await invitation(db, input.targetPrincipalId);
        if (previous?.phase === "invited") return previous.role === input.role ? result(previous, "ALREADY_INVITED") : { code: "INVITATION_ROLE_CONFLICT" };
        const collision = (await db.query("SELECT principal_id FROM public.identity_operator_invitations WHERE email_key = $1", [email])).rows[0];
        if (collision && collision.principal_id !== input.targetPrincipalId) return { code: "IDENTITY_CONFLICT" };
        const row = (await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
          INSERT INTO public.identity_operator_invitations
          (principal_id, invitation_id, email_key, role, phase, invited_by, invited_at, expires_at)
          SELECT $1, gen_random_uuid(), $2, $3, 'invited', $4, stamp.at, stamp.at + $5 * interval '1 second' FROM stamp WHERE true
          ON CONFLICT (principal_id) DO UPDATE SET invitation_id = EXCLUDED.invitation_id, email_key = EXCLUDED.email_key,
          role = EXCLUDED.role, phase = 'invited', invited_by = EXCLUDED.invited_by, invited_at = EXCLUDED.invited_at,
          expires_at = EXCLUDED.expires_at, accepted_at = NULL, closed_at = NULL RETURNING *`,
        [input.targetPrincipalId, email, input.role, input.actorPrincipalId, input.ttlSeconds])).rows[0]!;
        await event(db, previous || member ? "reissue" : "issue", previous, row, input.actorPrincipalId);
        return result(row, previous || member ? "INVITATION_REISSUED" : "INVITATION_CREATED");
      });
    },
    read(id) {
      return run(async (db) => {
        if (!await lock(db, id)) return null;
        const member = await membership(db, id);
        if (member?.membership_state === "active") return { ...snapshot(member), membershipState: "active" };
        const pending = await invitation(db, id);
        if (pending && pending.phase !== "accepted") return { ...snapshot(pending), membershipState: pending.phase === "invited" ? "invited" : pending.phase === "expired" ? "expired" : "revoked" };
        return member ? { ...snapshot(member), membershipState: "revoked" } : null;
      });
    },
    acceptOperatorInvitation(id) {
      return run((db) => acceptDirectOperatorInvitationInTransaction(db, id));
    },
    remove(input) {
      return run(async (db) => {
        const principal = await lock(db, input.targetPrincipalId);
        await lockCommandMemberships(db, input.actorPrincipalId, input.targetPrincipalId);
        await administrator(db, input.actorPrincipalId);
        if (input.actorPrincipalId === input.targetPrincipalId) throw invitationFailure("SELF_REVOKE_FORBIDDEN", "FORBIDDEN");
        if (!principal || await machine(db, input.targetPrincipalId)) throw invitationFailure("IDENTITY_CONFLICT");
        const member = await membership(db, input.targetPrincipalId);
        const pending = await invitation(db, input.targetPrincipalId);
        if (pending?.phase === "invited") {
          const cancelled = (await db.query("UPDATE public.identity_operator_invitations SET phase = 'cancelled', closed_at = clock_timestamp() WHERE principal_id = $1 RETURNING *", [input.targetPrincipalId])).rows[0]!;
          await event(db, "cancel", pending, cancelled, input.actorPrincipalId);
        }
        if (member?.membership_state === "active") await db.query("SELECT public.platform_revoke_human_membership($1, $2, $3)", [input.actorPrincipalId, input.targetPrincipalId, input.reason ?? null]);
        if (!member && !pending) throw invitationFailure("ADMIN_NOT_FOUND", "BAD_REQUEST");
        return { revoked: true };
      });
    },
    close: lane.close,
  };
}

/** Principal creation commits independently; an invitation failure leaves it reusable. */
export function createDirectOperatorIdentityDirectory(env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions = {}) {
  const lane = createPostgresRoleFreeTransactionLane(env, options);
  return {
    ensurePrincipal(input: { email: string; redirectTo: string }): Promise<{ principalId: string; created: boolean }> {
      const email = input.email.trim().toLowerCase();
      return lane.run(async (executor) => {
        const db = executor as PgQueryExecutor;
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`operator_invitation:${email}`]);
        const matches = (await db.query("SELECT principal_id FROM public.platform_human_principals WHERE lower(btrim(email)) = $1", [email])).rows;
        if (matches.length > 1) throw invitationFailure("IDENTITY_CONFLICT");
        if (matches[0]) {
          const principalId = String(matches[0].principal_id);
          if (await machine(db, principalId)) throw invitationFailure("IDENTITY_CONFLICT");
          return { principalId, created: false };
        }
        const row = (await db.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES (gen_random_uuid(), $1) RETURNING principal_id", [email])).rows[0]!;
        return { principalId: String(row.principal_id), created: true };
      });
    },
    close: lane.close,
  };
}

/** Trusted authentication only; caller owns the transaction, including challenge consumption. */
export async function acceptDirectOperatorInvitationInTransaction(db: PgQueryExecutor, id: string): Promise<import("./contracts/operatorInvitations.js").OperatorInvitationAcceptance> {
  if (!await lock(db, id) || await machine(db, id)) return { code: "NO_INVITATION" };
  const member = await membership(db, id);
  if (member?.membership_state === "active") {
    if (member.role !== "admin" && member.role !== "distributor") return { code: "NO_INVITATION" };
    return { code: "ALREADY_ACTIVE", role: member.role };
  }
  const pending = await invitation(db, id);
  if (!pending) return { code: "NO_INVITATION" };
  if (pending.phase === "expired") return { code: "INVITATION_EXPIRED" };
  if (pending.phase !== "invited" || (pending.role !== "admin" && pending.role !== "distributor")) return { code: "INVITATION_REVOKED" };
  const clock = (await db.query("WITH stamp AS (SELECT clock_timestamp() AS at) SELECT at, at >= $1::timestamptz AS expired FROM stamp", [pending.expires_at])).rows[0]!;
  const at = clock.at;
  if (clock.expired === true) {
    const expired = (await db.query("UPDATE public.identity_operator_invitations SET phase = 'expired', closed_at = expires_at WHERE principal_id = $1 RETURNING *", [id])).rows[0]!;
    await event(db, "expire", pending, expired, null);
    return { code: "INVITATION_EXPIRED" };
  }
  if (member) {
    const setting = (await db.query("SELECT current_setting('app.platform_human_membership_revoke', true) AS previous")).rows[0]?.previous;
    await db.query("SELECT set_config('app.platform_human_membership_revoke', 'true', true)");
    await db.query(`UPDATE public.platform_human_memberships SET membership_state = 'active', membership_provenance = 'invitation',
      membership_accepted_at = $2, membership_revoked_at = NULL, membership_revoked_by = NULL, membership_revocation_reason = NULL WHERE principal_id = $1`, [id, at]);
    await db.query("UPDATE public.platform_human_memberships SET role = $2 WHERE principal_id = $1", [id, pending.role]);
    await db.query("SELECT set_config('app.platform_human_membership_revoke', $1, true)", [setting ?? ""]);
  } else {
    await db.query(`INSERT INTO public.platform_human_memberships (principal_id, role, membership_state, membership_provenance, membership_accepted_at)
      VALUES ($1, $2, 'active', 'invitation', $3)`, [id, pending.role, at]);
  }
  const accepted = (await db.query("UPDATE public.identity_operator_invitations SET phase = 'accepted', accepted_at = $2, closed_at = $2 WHERE principal_id = $1 RETURNING *", [id, at])).rows[0]!;
  await event(db, "accept", pending, accepted, id);
  return { code: "ACTIVATED", role: role(pending.role) };
}

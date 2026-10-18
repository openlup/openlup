import { createHash } from "node:crypto";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "../data/index.js";
import { acceptDirectOperatorInvitationInTransaction } from "./directOperatorInvitationStore.js";
import { operatorChallengeRequestSchema } from "./contracts/operatorAuth.js";
import type { OperatorIdentityStore } from "./operatorPorts.js";
const fingerprint = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const allowed = (role: unknown) => role === "admin" || role === "distributor";

/** Dedicated owner lane: no actor gateway, customer writes or machine grants. */
export function createPostgresOperatorIdentityStore(env: { connectionString: string }): OperatorIdentityStore {
  const lane = createPostgresRoleFreeTransactionLane(env);
  const run = <T>(work: (db: PgQueryExecutor) => Promise<T>) => lane.run(db => work(db as PgQueryExecutor));
  async function safeStore(db: PgQueryExecutor) {
    // Includes privileges inherited via memberships/default ACLs, not just explicit grants.
    const unsafe = (await db.query(`SELECT EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (has_table_privilege(r.oid, 'public.operator_identity_challenges', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid, 'public.operator_identity_challenges', 'SELECT,INSERT,UPDATE,REFERENCES'))
    ) OR EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = 'public.operator_identity_challenges'::regclass AND a.grantee = 0)
      OR EXISTS (SELECT 1 FROM pg_attribute c, LATERAL aclexplode(c.attacl) a
      WHERE c.attrelid = 'public.operator_identity_challenges'::regclass AND a.grantee = 0) AS unsafe`)).rows[0]?.unsafe;
    if (unsafe !== false) throw new Error("operator_challenge_store_privileges_unsafe");
  }
  async function lockPrincipal(db: PgQueryExecutor, email: string) {
    // Same serialization key as the invitation lifecycle, before row locks.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`operator_invitation:${email}`]);
    const matches = (await db.query("SELECT principal_id, email FROM public.platform_human_principals WHERE lower(btrim(email)) = $1 FOR UPDATE", [email])).rows;
    if (matches.length > 1) throw new Error("operator_normalized_email_conflict");
    return matches[0] ?? null;
  }
  async function eligible(db: PgQueryExecutor, id: string, email: string): Promise<boolean> {
    if ((await db.query("SELECT 1 FROM public.platform_control_operators WHERE principal_id = $1", [id])).rows.length) return false;
    const member = (await db.query("SELECT role, membership_state FROM public.platform_human_memberships WHERE principal_id = $1 FOR UPDATE", [id])).rows[0];
    if (member?.membership_state === "active") return allowed(member.role);
    const pending = (await db.query(`SELECT role FROM public.identity_operator_invitations WHERE principal_id = $1
      AND email_key = $2 AND phase = 'invited' AND accepted_at IS NULL AND closed_at IS NULL
      AND expires_at > clock_timestamp() FOR UPDATE`, [id, email])).rows[0];
    return !!pending && allowed(pending.role);
  }
  return {
    issue({ email, tokenHash }) {
      return run(async db => {
        await safeStore(db);
        const principal = await lockPrincipal(db, email);
        if (!principal || !await eligible(db, String(principal.principal_id), email)) return { deliverable: false };
        const stamp = (await db.query("SELECT clock_timestamp() AS at")).rows[0]!.at;
        const counts = (await db.query(`SELECT count(*) AS hour_count,
          count(*) FILTER (WHERE created_at > $2::timestamptz - interval '60 seconds') AS minute_count
          FROM public.operator_identity_challenges WHERE principal_id = $1 AND created_at > $2::timestamptz - interval '1 hour'`, [principal.principal_id, stamp])).rows[0]!;
        if (Number(counts.minute_count) >= 1 || Number(counts.hour_count) >= 5) return { deliverable: false };
        const row = (await db.query(`INSERT INTO public.operator_identity_challenges
          (principal_id, email_fingerprint, token_hash, created_at, expires_at)
          VALUES ($1, $2, $3, $4, $4::timestamptz + interval '10 minutes') RETURNING expires_at`, [principal.principal_id, fingerprint(email), tokenHash, stamp])).rows[0]!;
        return { deliverable: true, email: String(principal.email).trim().toLowerCase(), expiresAt: new Date(String(row.expires_at)).toISOString() };
      });
    },
    redeem({ tokenHash }) {
      return run(async db => {
        await safeStore(db);
        const candidate = (await db.query(`SELECT p.email, p.principal_id FROM public.operator_identity_challenges c
          JOIN public.platform_human_principals p USING (principal_id) WHERE c.token_hash = $1`, [tokenHash])).rows[0];
        if (!candidate) return null;
        const email = String(candidate.email).trim().toLowerCase();
        const principal = await lockPrincipal(db, email);
        if (!principal || principal.principal_id !== candidate.principal_id || !await eligible(db, String(principal.principal_id), email)) return null;
        const challenge = (await db.query(`SELECT * FROM public.operator_identity_challenges WHERE token_hash = $1
          AND principal_id = $2 AND used_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [tokenHash, principal.principal_id])).rows[0];
        if (!challenge || challenge.email_fingerprint !== fingerprint(email)) return null;
        const accepted = await acceptDirectOperatorInvitationInTransaction(db, String(principal.principal_id));
        if ((accepted.code !== "ACTIVATED" && accepted.code !== "ALREADY_ACTIVE") || !allowed(accepted.role)) return null;
        const consumed = await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
          UPDATE public.operator_identity_challenges SET used_at = stamp.at FROM stamp
          WHERE id = $1 AND used_at IS NULL AND expires_at > stamp.at RETURNING id`, [challenge.id]);
        // Throw to roll activation back if the challenge expired during activation.
        if (!consumed.rows.length) throw new Error("operator_challenge_expired_during_activation");
        return { principalId: String(principal.principal_id), email };
      }).catch(error => {
        if (error instanceof Error && error.message === "operator_challenge_expired_during_activation") return null;
        throw error;
      });
    },
    findMembership(id) {
      return run(async db => {
        await safeStore(db);
        const row = (await db.query(`SELECT p.principal_id, p.email, m.role, m.membership_state
          FROM public.platform_human_principals p JOIN public.platform_human_memberships m USING (principal_id)
          WHERE p.principal_id = $1 AND NOT EXISTS (SELECT 1 FROM public.platform_control_operators o WHERE o.principal_id = p.principal_id)`, [id])).rows[0];
        return row ? { principalId: String(row.principal_id), email: String(row.email), role: row.role, membershipState: String(row.membership_state) } : null;
      });
    },
    bootstrapFirstAdministrator(input) {
      const { email } = operatorChallengeRequestSchema.parse(input);
      return run(async db => {
        await safeStore(db);
        await db.query("LOCK TABLE public.platform_human_memberships, public.identity_operator_invitations IN SHARE ROW EXCLUSIVE MODE");
        if ((await db.query(`SELECT 1 FROM public.platform_human_memberships UNION ALL SELECT 1 FROM public.identity_operator_invitations LIMIT 1`)).rows.length) throw new Error("OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED");
        let principal = await lockPrincipal(db, email);
        if (!principal) principal = (await db.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES (gen_random_uuid(), $1) RETURNING principal_id, email", [email])).rows[0]!;
        const id = String(principal.principal_id);
        if ((await db.query("SELECT 1 FROM public.platform_control_operators WHERE principal_id = $1", [id])).rows.length) throw new Error("operator_bootstrap_machine_refused");
        const pending = (await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
          INSERT INTO public.identity_operator_invitations
          (principal_id, invitation_id, email_key, role, phase, invited_by, invited_at, expires_at)
          SELECT $1, gen_random_uuid(), $2, 'admin', 'invited', $1, at, at + interval '7 days' FROM stamp RETURNING *`, [id, email])).rows[0]!;
        await db.query(`INSERT INTO public.identity_operator_invitation_events
          (event_id, invitation_id, principal_id, action, actor_kind, old_value, new_value, occurred_at)
          VALUES (gen_random_uuid(), $1, $2, 'issue', 'system', '{}'::jsonb, $3::jsonb, clock_timestamp())`, [pending.invitation_id, id, JSON.stringify(pending)]);
        return { principalId: id, membershipState: "invited" };
      });
    },
    pruneChallenges({ limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("operator_prune_limit_invalid");
      return run(async db => {
        const deleted = await db.query(`WITH batch AS (SELECT id FROM public.operator_identity_challenges
          WHERE expires_at < clock_timestamp() - interval '24 hours' ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
          DELETE FROM public.operator_identity_challenges c USING batch WHERE c.id = batch.id RETURNING c.id`, [limit]);
        return { deleted: deleted.rows.length };
      });
    },
    close: lane.close,
  };
}

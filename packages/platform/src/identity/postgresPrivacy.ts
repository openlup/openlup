import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor, type PostgresDataGatewayEnv, type PostgresDataGatewayOptions } from "../data/index.js";
import { PrivacyRefusal, type PrivacyStore, type ResolvedPrivacySubject, type AuthorizedHumanAdministrator } from "./privacyPorts.js";
import { erasureReceiptSchema, type PrivacySubjectRef, type PrivacyJson } from "./contracts/privacy.js";

type Row = Record<string, unknown>;
function json(value: unknown): PrivacyJson { return JSON.parse(JSON.stringify(value)) as PrivacyJson; }
export function createPostgresPrivacyStore(): PrivacyStore<PgQueryExecutor> {
  return {
    erasureSupported: true,
    async prepareErasure(db) {
      await db.query("SET LOCAL lock_timeout = '5s'");
      await db.query("SET LOCAL statement_timeout = '15s'");
      // Serialize receipt/key decisions; challenge relation precedes every contact lock.
      await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE");
      const unsafe = (await db.query(`SELECT EXISTS (
        SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'authenticator')
        AND (has_table_privilege(r.oid, 'public.identity_privacy_erasures', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid, 'public.identity_privacy_erasures', 'SELECT,INSERT,UPDATE,REFERENCES'))
      ) OR EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        WHERE c.oid = 'public.identity_privacy_erasures'::regclass AND a.grantee = 0)
        OR EXISTS (SELECT 1 FROM pg_attribute c, LATERAL aclexplode(c.attacl) a
        WHERE c.attrelid = 'public.identity_privacy_erasures'::regclass AND a.grantee = 0) AS unsafe`)).rows[0]?.unsafe;
      if (unsafe !== false) throw new PrivacyRefusal("PRIVACY_STORE_PRIVILEGES_UNSAFE");
      await db.query("LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE");
    },
    async authorizeErasure(db, actor) {
      const row = (await db.query(`SELECT m.role, m.membership_state FROM public.platform_human_memberships m
        WHERE m.principal_id = $1 AND NOT EXISTS (SELECT 1 FROM public.platform_control_operators o WHERE o.principal_id = m.principal_id)`, [actor.principalId])).rows[0];
      if (row?.role !== "admin" || row.membership_state !== "active") throw new PrivacyRefusal("PRIVACY_PROTECTED_OPERATOR");
    },
    async resolve(db, ref, actor) {
      const contactPredicate = ref.kind === "contact" ? "c.id = $1" : "c.principal_id = $1";
      const id = ref.kind === "contact" ? ref.contactId : ref.principalId;
      let contact = (await db.query(`SELECT c.* FROM public.clients c WHERE ${contactPredicate}`, [id])).rows[0] ?? null;
      if (ref.kind === "principal" && !contact) {
        const receipt = (await db.query("SELECT client_id FROM public.identity_privacy_erasures WHERE principal_id = $1", [id])).rows[0];
        if (receipt?.client_id) contact = (await db.query("SELECT * FROM public.clients WHERE id = $1", [receipt.client_id])).rows[0] ?? null;
      }
      let principalId = ref.kind === "principal" ? ref.principalId : contact?.principal_id ? String(contact.principal_id) : null;
      if (!principalId && contact) {
        const receipt = (await db.query("SELECT principal_id FROM public.identity_privacy_erasures WHERE client_id = $1", [contact.id])).rows[0];
        if (receipt?.principal_id) principalId = String(receipt.principal_id);
      }
      let principal = principalId ? (await db.query("SELECT principal_id, email, created_at FROM public.platform_human_principals WHERE principal_id = $1", [principalId])).rows[0] ?? null : null;
      if (!contact && !principal) return null;
      if (actor) {
        if (principal) {
          await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`operator_invitation:${String(principal.email).trim().toLowerCase()}`]);
        }
        await db.query("SELECT principal_id FROM public.platform_human_memberships WHERE principal_id = ANY($1::uuid[]) ORDER BY principal_id FOR UPDATE", [[actor.principalId, principalId].filter(Boolean)]);
        if (contact) contact = (await db.query("SELECT * FROM public.clients WHERE id = $1 FOR UPDATE", [contact.id])).rows[0] ?? null;
        if (principal) principal = (await db.query("SELECT principal_id, email, created_at FROM public.platform_human_principals WHERE principal_id = $1 FOR UPDATE", [principalId])).rows[0] ?? null;
      }
      const membership = principalId ? (await db.query("SELECT * FROM public.platform_human_memberships WHERE principal_id = $1", [principalId])).rows[0] ?? null : null;
      const invitations = principalId ? (await db.query("SELECT * FROM public.identity_operator_invitations WHERE principal_id = $1", [principalId])).rows : [];
      const invitationHistory = principalId ? (await db.query("SELECT * FROM public.identity_operator_invitation_events WHERE principal_id = $1 ORDER BY occurred_at, event_id", [principalId])).rows : [];
      const membershipHistory = principalId ? (await db.query("SELECT * FROM public.platform_human_membership_audit_events WHERE target_principal_id = $1 ORDER BY occurred_at, id", [principalId])).rows : [];
      return { contactId: contact ? String(contact.id) : null, principalId,
        identity: { contact: json(contact), principal: json(principal), membership: json(membership), invitations: json(invitations), invitationHistory: json(invitationHistory), membershipHistory: json(membershipHistory) } };
    },
    async findReceipt(db, ref, key) {
      const column = ref.kind === "contact" ? "client_id" : "principal_id";
      const id = ref.kind === "contact" ? ref.contactId : ref.principalId;
      const rows = (await db.query(`SELECT * FROM public.identity_privacy_erasures WHERE ${column} = $1 OR idempotency_key = $2::uuid`, [id, key ?? null])).rows;
      if (rows.some(row => row.idempotency_key === key && row[column] !== id)) throw new PrivacyRefusal("PRIVACY_IDEMPOTENCY_CONFLICT");
      const row = rows.find(row => row[column] === id);
      return row ? erasureReceiptSchema.parse({ version: row.contract_version, erasureId: row.erasure_id, completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : new Date(String(row.completed_at)).toISOString(), outcome: "ERASED", obligations: row.retained_obligations }) : null;
    },
    async eraseIdentity(db, subject, actor, pseudonym) {
      await erasePostgresIdentity(db, subject, actor, pseudonym);
    },
    async saveReceipt(db, subject, actor, key, receipt, dispositions) {
      await db.query(`INSERT INTO public.identity_privacy_erasures
        (erasure_id, idempotency_key, client_id, principal_id, actor_principal_id, contract_version, contributor_versions, dispositions, retained_obligations, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::timestamptz)`,
      [receipt.erasureId, key, subject.contactId, subject.principalId, actor.principalId, receipt.version,
        JSON.stringify(Object.fromEntries(dispositions.map(d => [d.contributorId, d.version]))), JSON.stringify(dispositions), JSON.stringify(receipt.obligations), receipt.completedAt]);
    },
  };
}
async function erasePostgresIdentity(db: PgQueryExecutor, subject: ResolvedPrivacySubject, actor: AuthorizedHumanAdministrator, pseudonym: string): Promise<void> {
  const id = subject.principalId;
  if (id) {
    if (id === actor.principalId || (await db.query("SELECT 1 FROM public.platform_control_operators WHERE principal_id = $1", [id])).rows.length) throw new PrivacyRefusal("PRIVACY_PROTECTED_OPERATOR");
    const member = subject.identity.membership as Row | null;
    if (member?.membership_state === "active") {
      try { await db.query("SELECT public.platform_revoke_human_membership($1, $2, $3)", [actor.principalId, id, "identity erasure"]); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && ["P0001", "42501"].includes(String(error.code))) throw new PrivacyRefusal("PRIVACY_PROTECTED_OPERATOR");
        throw error;
      }
    }
    await db.query("DELETE FROM public.operator_identity_challenges WHERE principal_id = $1", [id]);
    await db.query("DELETE FROM public.identity_operator_invitations WHERE principal_id = $1 AND phase <> 'accepted'", [id]);
    await db.query("UPDATE public.identity_operator_invitations SET email_key = $2 WHERE principal_id = $1", [id, pseudonym]);
    // Rebuild historical identity snapshots from lifecycle fields, never a recursive string replacement.
    await db.query(`UPDATE public.identity_operator_invitation_events SET
      old_value = old_value - 'email_key', new_value = new_value - 'email_key' WHERE principal_id = $1`, [id]);
    await db.query(`UPDATE public.platform_human_membership_audit_events SET reason = NULL,
      old_value = old_value - 'revocationReason', new_value = new_value - 'revocationReason' WHERE target_principal_id = $1`, [id]);
    // The existing lifecycle guard also protects free-text redaction on a revoked row.
    const previous = (await db.query("SELECT current_setting('app.platform_human_membership_revoke', true) AS previous")).rows[0]?.previous;
    await db.query("SELECT set_config('app.platform_human_membership_revoke', 'true', true)");
    await db.query("UPDATE public.platform_human_memberships SET membership_revocation_reason = NULL WHERE principal_id = $1 AND membership_state = 'revoked'", [id]);
    await db.query("SELECT set_config('app.platform_human_membership_revoke', $1, true)", [previous ?? ""]);
    await db.query("UPDATE public.platform_human_principals SET email = $2 WHERE principal_id = $1", [id, pseudonym]);
  }
  if (subject.contactId) {
    await db.query("DELETE FROM public.customer_identity_challenges WHERE client_id = $1", [subject.contactId]);
    await db.query(`UPDATE public.clients SET email = $2, first_name = NULL, last_name = NULL, phone = NULL,
      country = NULL, principal_id = NULL, updated_at = clock_timestamp() WHERE id = $1`, [subject.contactId, pseudonym]);
  }
}
export function createPostgresPrivacyUnitOfWork(env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions = {}) {
  const lane = createPostgresRoleFreeTransactionLane(env, options);
  return { run: <T>(work: (context: PgQueryExecutor) => Promise<T>) => lane.run(db => work(db as PgQueryExecutor)), close: lane.close };
}

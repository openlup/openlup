import type { RequiredSchema, SchemaObject } from "@openlup/core/readiness";

export type IdentityBundle = "node-postgres" | "node-supabase";
const table = (name: string, columns: string): SchemaObject[] => [
  { kind: "table", name }, ...columns.split(" ").map(column => ({ kind: "column" as const, name: `${name}.${column}` })),
];
const fn = (name: string, signature = ""): SchemaObject => ({ kind: "function", name, signature });
const contact = "id email first_name last_name phone lifecycle_stage acquisition_source";
const membership = "role membership_state membership_provenance membership_accepted_at membership_revoked_at membership_revoked_by membership_revocation_reason";
/** The host supplies the expected complete catalogue identity, independently of its live observer. */
export function identityRequiredSchema(bundle: IdentityBundle, version: string): RequiredSchema {
  if (!version.trim()) throw new Error("identity_migration_identity_required");
  const common = [...table("public.clients", contact), fn("auth.uid")];
  return { version, migration: bundle === "node-postgres" ? "db/platform/migrations/20261018190000_identity_privacy_erasures.sql" : "supabase/migrations", objects: bundle === "node-postgres" ? [
    ...common, ...table("public.clients", "principal_id country metadata external_ref updated_at").slice(1),
    ...table("public.customer_identity_challenges", "id client_id principal_id email_fingerprint token_hash created_at expires_at used_at"),
    ...table("public.platform_human_principals", "principal_id email created_at"),
    ...table("public.platform_human_memberships", `principal_id ${membership}`),
    ...table("public.platform_human_membership_audit_events", "id target_principal_id actor_principal_id action old_value new_value reason occurred_at"),
    ...table("public.platform_control_operators", "principal_id"),
    ...table("public.identity_operator_invitations", "principal_id invitation_id email_key role phase invited_by invited_at expires_at accepted_at closed_at"),
    ...table("public.identity_operator_invitation_events", "event_id invitation_id principal_id action actor_kind actor_principal_id old_value new_value occurred_at"),
    ...table("public.operator_identity_challenges", "id principal_id email_fingerprint token_hash created_at expires_at used_at"),
    ...table("public.identity_privacy_erasures", "erasure_id idempotency_key client_id principal_id actor_principal_id contract_version contributor_versions dispositions retained_obligations completed_at"),
    ...table("public.subscriptions", "id client_id status"),
    fn("public.customer_identity_challenge_issue", "text,text,timestamp with time zone,timestamp with time zone"),
    fn("public.customer_identity_challenge_redeem", "text,timestamp with time zone"),
    fn("public.platform_human_membership_is_active", "uuid"), fn("public.platform_human_membership_is_administrator", "uuid"),
    fn("public.platform_revoke_human_membership", "uuid,uuid,text"),
  ] : [
    ...common, ...table("public.clients", "auth_user_id created_at").slice(1), ...table("public.admin_users", `id email is_machine_actor ${membership}`),
    ...table("public.admin_audit_events", "id actor_admin_id target_admin_id action old_value new_value occurred_at"),
    ...table("public.customer_magic_link_attempts", "id email_hash ip_hash created_at"),
    ...table("public.admin_magic_link_attempts", "id email_hash ip_hash created_at"),
    ...table("auth.users", "id email email_confirmed_at"),
    fn("public.is_admin_user"), fn("public.admin_revoke_admin_user", "uuid,text"),
    fn("public.public_record_customer_magic_link_attempt", "text,text,integer,integer,integer"),
    fn("public.public_record_admin_magic_link_attempt", "text,text,integer,integer,integer"),
    fn("public.public_count_customer_magic_link_attempts_global", "integer"),
  ] };
}

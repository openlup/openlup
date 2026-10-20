import type { RequiredSchema, SchemaObject } from "@openlup/core/readiness";
export type CommunicationsBundle = "node-postgres" | "node-supabase";
const table = (name: string, columns: string): SchemaObject[] => [{kind:"table",name:`public.${name}`}, ...columns.split(" ").map(column=>({kind:"column" as const,name:`public.${name}.${column}`}))];
/** Presence metadata only. The host must independently verify the complete selected migration ledger. */
export function communicationsRequiredSchema(bundle: CommunicationsBundle, version: string): RequiredSchema {
 if (!version.trim()) throw new Error("communications_migration_identity_required");
 const common = [...table("communication_recipient_consents","recipient_fingerprint purpose state captured_at updated_at"), ...table("outbox_events","id event_type idempotency_key status metadata payload"), ...table("transactional_delivery_receipts","idempotency_key"), ...table("notification_recipients","id email active notification_type")];
 return {version,migration:bundle==="node-postgres"?"db/platform/migrations/20261019200000_communications_native_operations.sql":"supabase/migrations",objects:bundle==="node-postgres"?[
 ...common,...table("platform_job_controls","job_name enabled active_driver"),...table("platform_job_runs","id job_name status metadata"),...table("communication_delivery_controls","control_key enabled revision"),...table("communication_delivery_templates","template_reference control_key active revision"),...table("communication_delivery_commands","idempotency_key command_fingerprint"),...table("communication_delivery_events","event_id idempotency_key transition"),...table("platform_schema_migrations","position catalog_path sha256"),...table("platform_communication_operators","principal_id active"),...table("platform_human_memberships","principal_id role membership_state"),...table("platform_control_operators","principal_id"),
 ...table("communication_native_sends","id binding source_key message_id recipient_fingerprint template_reference accepted_at observed_state observed_at last_poll_at not_found_count abandoned_at"),
 ...table("communication_native_observations","binding observation_key send_id kind occurred_at source fact_fingerprint"),
 ...table("communication_native_sync_state","work_id binding provider_kind contact_id normalized_email purpose event_kind command_fingerprint response_summary"),
 ...table("communication_native_policy_decisions","id recipient_fingerprint purpose allowed reason permission_snapshot source_table source_id evaluated_at"),
 ]:[...common,...table("email_sends","id resend_id status"),...['communication_apply_unsubscribe','communication_record_permission_event','communication_touch_contact','communication_update_email_delivery_from_provider'].map(name=>({kind:"function" as const,name:`public.${name}`}))]};
}

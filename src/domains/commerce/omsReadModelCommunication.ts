import type { OmsOrderDetail } from "./omsContracts.js";
import type { OmsCommunicationDeliveryRow } from "./omsReadModelRows.js";

export function mapCommunicationDelivery(row: OmsCommunicationDeliveryRow): OmsOrderDetail["communicationDeliveries"][number] {
  return {
    id: row.id,
    purpose: row.purpose,
    templateSlug: row.template_slug,
    triggerSource: row.trigger_source,
    triggerEvent: row.trigger_event,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    dedupeKey: row.dedupe_key,
    status: row.status,
    providerKind: row.provider_kind,
    providerMessageId: row.provider_message_id,
    scheduledDueAt: row.scheduled_due_at,
    expectedSendAt: row.expected_send_at,
    queuedAt: row.queued_at,
    firstAttemptAt: row.first_attempt_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    terminalAt: row.terminal_at,
    lastErrorCode: row.last_error_code,
    outboxEventId: row.outbox_event_id,
    platformJobRunId: row.platform_job_run_id,
    emailSendId: row.email_send_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

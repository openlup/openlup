import type {
  CustomerJourneyGap,
  CustomerJourneyLookupRequest,
  CustomerJourneySnapshotResponse,
} from "../../../src/domains/support/customerJourneyContracts.js";

export type Row = Record<string, unknown>;

export const ORDER_COLUMNS = "id, order_number, client_id, status, mode, metadata, created_at, updated_at, subscription_id, subscription_cycle_id";
export const CLIENT_COLUMNS = "id, email, first_name, last_name, auth_user_id, lifecycle_stage, created_at, updated_at";
export const RECOVERY_TOKEN_COLUMNS = "id, order_id, client_id, purpose, expires_at, used_at, revoked_at, created_at, updated_at";
export const OUTBOX_COLUMNS = "id, aggregate_type, aggregate_id, event_type, status, attempts, available_at, processed_at, created_at, error";
// `template_version` is read for the operator commands: it is the expectation
// customer_support_apply_subscription_action_v1 compares, and an operator with no
// version to send must be shown a disabled control rather than a guessed one.
export const SUBSCRIPTION_COLUMNS = "id, client_id, status, next_cycle_at, payment_method_kind, payment_method_ref, edit_window_hours, template_version, created_at, updated_at";
export const CYCLE_COLUMNS = "id, subscription_id, order_id, cycle_number, status, scheduled_at, paid_at, next_retry_at, retry_attempt, failure_reason, payment_method_ref, created_at, updated_at";
export const PAYMENT_METHOD_COLUMNS = "id, client_id, subscription_id, provider_kind, status, active, created_at, updated_at";

export async function rows<T extends Row>(builder: PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<T[]> {
  const result = await builder as { data: T[] | null; error: { message?: string } | null };
  if (result.error) throw new Error(result.error.message ?? "query failed");
  return result.data ?? [];
}

export async function maybeSingle<T extends Row>(builder: {
  maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}): Promise<T | null> {
  const result = await builder.maybeSingle();
  if (result.error) throw new Error(result.error.message ?? "query failed");
  return (result.data ?? null) as T | null;
}

export function gap(code: string, severity: CustomerJourneyGap["severity"], explanation: string, nextRead: string): CustomerJourneyGap {
  return { code, severity, explanation, nextRead };
}

export function editBlockedReason(subscription: Row): string | null {
  if (subscription.status && !["active", "paused", "pending_activation"].includes(String(subscription.status))) {
    return `subscription_${subscription.status}`;
  }
  return null;
}

export function displayLookup(request: CustomerJourneyLookupRequest): string {
  return request.orderId
    ?? request.orderNumber
    ?? request.trackingNumber
    ?? request.subscriptionId
    ?? request.clientId
    ?? request.email
    ?? request.query
    ?? "unknown";
}

export function customerName(row: Row | null | undefined): string | null {
  const value = [row?.first_name, row?.last_name].filter(Boolean).join(" ").trim();
  return value || null;
}

export function nameFromOms(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return [value.firstName, value.lastName].filter(Boolean).join(" ").trim() || null;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

export function compact(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function datetimeOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function timestamp(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}

export function mapCommunication(value: Row): CustomerJourneySnapshotResponse["orders"][number]["communications"][number] {
  return {
    id: String(value.id),
    purpose: stringOrNull(value.purpose),
    templateSlug: stringOrNull(value.template_slug),
    triggerSource: stringOrNull(value.trigger_source),
    status: stringOrNull(value.status),
    providerKind: stringOrNull(value.provider_kind),
    providerMessageId: stringOrNull(value.provider_message_id),
    queuedAt: datetimeOrNull(value.queued_at),
    sentAt: datetimeOrNull(value.sent_at),
    deliveredAt: datetimeOrNull(value.delivered_at),
    terminalAt: datetimeOrNull(value.terminal_at),
    outboxEventId: stringOrNull(value.outbox_event_id),
    emailSendId: stringOrNull(value.email_send_id),
  };
}

/** A shipment obligation is only discharged by the canonical shipment purpose. */
export function isConfirmedShipmentCommunication(value: CustomerJourneySnapshotResponse["orders"][number]["communications"][number]): boolean {
  return typeof value.purpose === "string" && typeof value.status === "string"
    && ["shipment_dispatched", "shipment_delivered", "shipment_exception"].includes(value.purpose)
    && ["sent", "delivered"].includes(value.status);
}

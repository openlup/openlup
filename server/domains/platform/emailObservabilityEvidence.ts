import type { EmailHealthSnapshot } from "../../../src/domains/platform/observabilityContracts.js";

const CUSTOMER_TIMELINE_FAILED = new Set(["bounced", "complained", "failed"]);
const CUSTOMER_TIMELINE_PENDING = new Set(["planned", "queued", "processing", "delivery_delayed"]);
const CURRENT_AUDIT_KEYS = [
  "emailEnvironment",
  "environment",
  "emailBaseUrl",
  "resolvedBaseUrl",
  "baseUrl",
  "origin",
  "emailOriginSource",
  "originSource",
  "triggerSource",
  "triggerReason",
  "sendAttemptId",
  "outboxEventId",
  "platformJobRunId",
] as const;
const CURRENT_SOURCE_HINTS = [
  "auth-send-email",
  "outbox-dispatch",
  "process-email-queue",
  "send-email",
  "subscription-",
  "commerce-",
] as const;
const WEBHOOK_GAP_GRACE_MS = 30 * 60 * 1000;
const TIMELINE_OVERDUE_GRACE_MS = 15 * 60 * 1000;
const TERMINAL_CUSTOMER_EMAIL_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type EmailSendEvidenceRow = Record<string, unknown> & {
  id?: string | null;
  status?: string | null;
  sent_at?: string | null;
  source?: string | null;
  template_slug?: string | null;
  resend_id?: string | null;
  provider_response?: unknown;
};

export type CommunicationEmailDeliveryEvidenceRow = Record<string, unknown> & {
  id?: string | null;
  status: string;
  purpose?: string | null;
  template_slug?: string | null;
  recipient_fingerprint?: string | null;
  aggregate_type?: string | null;
  aggregate_id?: string | null;
  email_send_id?: string | null;
  provider_message_id?: string | null;
  expected_send_at?: string | null;
  terminal_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type EmailEventEvidenceRow = Record<string, unknown> & {
  send_id?: string | null;
  event_type?: string | null;
  timestamp?: string | null;
};

export type EmailOutboxEvidenceRow = Record<string, unknown> & {
  status: string;
  event_type?: string | null;
};

export function summarizeEmailEvidence(input: {
  emailSends: EmailSendEvidenceRow[];
  emailEvents: EmailEventEvidenceRow[];
  communicationEmailDeliveries: CommunicationEmailDeliveryEvidenceRow[];
  outboxEvents: EmailOutboxEvidenceRow[];
  // Recipient fingerprints of SENT deliveries in the window (NULLs ignored).
  // Used only to derive maxSendsPerRecipient — the per-recipient flood signal.
  sentRecipientFingerprints?: (string | null | undefined)[];
  // PROCESSED customer-email outbox rows in the window. Separate from
  // `outboxEvents`, which is restricted to pending/failed/processing and feeds
  // the queue-depth counters; settled rows would inflate those.
  skippedOutboxEvents?: EmailOutboxEvidenceRow[];
  productionHosts?: readonly string[];
  now: Date;
}): EmailHealthSnapshot {
  const productionHosts = new Set(input.productionHosts?.map((host) => host.toLowerCase()) ?? []);
  const criticalEmails = input.emailSends.filter(
    (row) => row.source === "subscription-dunning-dispatch" && row.status === "failed",
  );
  const eventsBySendId = new Set(input.emailEvents.map((event) => event.send_id).filter(isPresent));
  const actionableTerminalDeliveries = input.communicationEmailDeliveries.filter((row) =>
    isActionableTerminalDelivery(row, input.now),
  );
  const successfulDeliveries = input.communicationEmailDeliveries.filter((row) =>
    row.status === "sent" || row.status === "delivered"
  );
  const skippedNotices = (input.skippedOutboxEvents ?? []).filter(isSkippedCustomerNotice);

  return {
    criticalFailedCount: criticalEmails.length,
    failedBySource: countBy(
      input.emailSends.filter((row) => row.status === "failed"),
      (row) => row.source ?? "unknown",
    ),
    customerTimelineFailedCount: input.communicationEmailDeliveries.filter((row) =>
      CUSTOMER_TIMELINE_FAILED.has(row.status),
    ).filter((row) => actionableTerminalDeliveries.includes(row)).length,
    customerTimelineMissedCount: actionableTerminalDeliveries.filter((row) => row.status === "missed").length,
    customerTimelineOverdueCount: input.communicationEmailDeliveries.filter((row) =>
      CUSTOMER_TIMELINE_PENDING.has(row.status) &&
      Boolean(row.expected_send_at) &&
      new Date(row.expected_send_at as string).getTime() < input.now.getTime() - TIMELINE_OVERDUE_GRACE_MS,
    ).length,
    failedByPurpose: countBy(
      input.communicationEmailDeliveries.filter((row) =>
        actionableTerminalDeliveries.includes(row) &&
        (CUSTOMER_TIMELINE_FAILED.has(row.status) || row.status === "missed"),
      ),
      (row) => row.purpose ?? "unknown",
    ),
    auditIncompleteCount: input.emailSends.filter((row) =>
      isCurrentAuditableSend(row) &&
      missingAuditEvidence(row).length > 0 &&
      !hasCorrelatedSuccessfulDelivery(row, successfulDeliveries),
    ).length,
    previewProductionDomainLinkCount: input.emailSends.filter((row) =>
      hasPreviewProductionBaseUrl(row, productionHosts),
    ).length,
    webhookGapCount: input.emailSends.filter((row) => hasWebhookGap(row, eventsBySendId, input.now)).length,
    communicationOutboxFailedCount: input.outboxEvents.filter(isFailedCommunicationOutboxEvent).length,
    maxSendsPerRecipient: maxSendsPerRecipient(input.sentRecipientFingerprints ?? []),
    customerNoticeSkippedCount: skippedNotices.length,
    skippedByReason: countBy(skippedNotices, skipReasonOf),
  };
}

/**
 * A customer email the dispatcher settled without sending.
 *
 * `status='processed'` plus a `metadata.skipped` string is the exact shape a
 * handler produces when it decides not to send and returns terminally. Rows
 * without the marker are ordinary successful sends and must not be counted.
 */
function isSkippedCustomerNotice(row: EmailOutboxEvidenceRow): boolean {
  if (row.status !== "processed") return false;
  return skipReasonOf(row) !== "unknown";
}

function skipReasonOf(row: EmailOutboxEvidenceRow): string {
  return firstString(asObject(row.metadata), ["skipped"]) ?? "unknown";
}

function hasCorrelatedSuccessfulDelivery(
  send: EmailSendEvidenceRow,
  deliveries: CommunicationEmailDeliveryEvidenceRow[],
): boolean {
  if (!send.template_slug) return false;
  const sendAttemptId = firstString(asObject(send.provider_response), ["sendAttemptId", "send_attempt_id"]);

  return deliveries.some((delivery) => {
    if (delivery.template_slug !== send.template_slug) return false;
    if (!isSha256Fingerprint(delivery.recipient_fingerprint)) return false;
    if (!isPresent(delivery.aggregate_type) || !isPresent(delivery.aggregate_id)) return false;

    return Boolean(
      (send.id && delivery.email_send_id === send.id) ||
      (send.resend_id && delivery.provider_message_id === send.resend_id) ||
      (sendAttemptId && delivery.id === sendAttemptId),
    );
  });
}

function isSha256Fingerprint(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isActionableTerminalDelivery(row: CommunicationEmailDeliveryEvidenceRow, now: Date): boolean {
  if (!CUSTOMER_TIMELINE_FAILED.has(row.status) && row.status !== "missed") return false;
  const timestamp = row.terminal_at ?? row.updated_at ?? row.created_at;
  if (!timestamp) return true;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return true;
  return time >= now.getTime() - TERMINAL_CUSTOMER_EMAIL_FAILURE_WINDOW_MS;
}

function isCurrentAuditableSend(row: EmailSendEvidenceRow): boolean {
  const metadata = asObject(row.provider_response);
  if (CURRENT_AUDIT_KEYS.some((key) => metadata[key] !== undefined)) return true;
  const source = row.source ?? "";
  return CURRENT_SOURCE_HINTS.some((hint) => source === hint || source.startsWith(hint));
}

function missingAuditEvidence(row: EmailSendEvidenceRow): string[] {
  const metadata = asObject(row.provider_response);
  const triggerSource = firstString(metadata, ["triggerSource", "trigger_source"]) ?? row.source ?? "unknown";
  const triggerReason =
    firstString(metadata, ["triggerReason", "trigger_reason", "triggerEvent", "trigger_event"]) ??
    row.template_slug ??
    "unknown";
  const environment = firstString(metadata, ["emailEnvironment", "environment", "email_environment"]) ?? "unknown";
  const resolvedBaseUrl = firstString(metadata, ["emailBaseUrl", "resolvedBaseUrl", "baseUrl", "origin"]) ?? "-";
  const originSource = firstString(metadata, ["emailOriginSource", "originSource"]) ?? "-";
  const providerMessageId = row.resend_id ?? firstString(metadata, ["id", "providerMessageId", "message_id"]) ?? "-";
  const sendAttemptId = firstString(metadata, ["sendAttemptId", "send_attempt_id", "deliveryId", "delivery_id"]) ?? "-";
  const outboxEventId = firstString(metadata, ["outboxEventId", "outbox_event_id"]) ?? "-";
  const platformJobRunId = firstString(metadata, ["platformJobRunId", "platform_job_run_id", "jobRunId"]) ?? "-";
  const aggregate = aggregateReference(metadata);
  const missing: string[] = [];

  if (triggerSource === "unknown" || triggerReason === "unknown") missing.push("trigger");
  if (environment === "unknown" || resolvedBaseUrl === "-" || originSource === "-") missing.push("origin");
  if (providerMessageId === "-") missing.push("provider");
  if (sendAttemptId === "-") missing.push("send_attempt");
  if (outboxEventId === "-" && platformJobRunId === "-" && aggregate === "-") missing.push("correlation");
  return missing;
}

function hasPreviewProductionBaseUrl(row: EmailSendEvidenceRow, productionHosts: ReadonlySet<string>): boolean {
  const metadata = asObject(row.provider_response);
  const environment = firstString(metadata, ["emailEnvironment", "environment", "email_environment"]) ?? "";
  const baseUrl = firstString(metadata, ["emailBaseUrl", "resolvedBaseUrl", "baseUrl", "origin"]);
  return isPreviewEnvironment(environment) && isProductionUrl(baseUrl, productionHosts);
}

function hasWebhookGap(row: EmailSendEvidenceRow, eventsBySendId: Set<string>, now: Date): boolean {
  if (row.status !== "sent" || !row.sent_at) return false;
  const providerMessageId = row.resend_id ?? firstString(asObject(row.provider_response), ["id", "providerMessageId"]);
  if (!providerMessageId) return false;
  if (eventsBySendId.has(String(row.id)) || eventsBySendId.has(providerMessageId)) return false;
  return new Date(row.sent_at).getTime() < now.getTime() - WEBHOOK_GAP_GRACE_MS;
}

function isFailedCommunicationOutboxEvent(row: EmailOutboxEvidenceRow): boolean {
  if (row.status !== "failed") return false;
  const type = row.event_type ?? "";
  return /(^|[._-])(communication|email|mail|notification)([._-]|$)/.test(type);
}

function aggregateReference(metadata: Record<string, unknown>): string {
  const refs = [
    firstString(metadata, ["orderId", "order_id"]),
    firstString(metadata, ["notificationId", "notification_id"]),
    firstString(metadata, ["emailSendId", "email_send_id"]),
    firstString(metadata, ["aggregateId", "aggregate_id"]),
    firstString(metadata, ["authUserId", "auth_user_id"]),
  ].filter(isPresent);
  return refs.length > 0 ? refs.join(", ") : "-";
}

function isPreviewEnvironment(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("preview") || normalized.includes("staging") || normalized.includes("hidden");
}

function isProductionUrl(value: string | null, productionHosts: ReadonlySet<string>): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return productionHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = key(row);
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined && value !== "";
}

// Highest count of sent deliveries sharing one recipient fingerprint. NULL/blank
// fingerprints are ignored (unattributable rows can't prove a per-recipient flood).
function maxSendsPerRecipient(fingerprints: (string | null | undefined)[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const fingerprint of fingerprints) {
    if (typeof fingerprint !== "string" || fingerprint.length === 0) continue;
    const next = (counts.get(fingerprint) ?? 0) + 1;
    counts.set(fingerprint, next);
    if (next > max) max = next;
  }
  return max;
}

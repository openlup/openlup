import type { AdminEmailEvent, AdminEmailSend } from "./adminEmailConsoleContracts.js";

export interface EmailSupportReport {
  recipientReference: string;
  triggerSource: string;
  triggerReason: string;
  environment: string;
  resolvedBaseUrl: string;
  originSource: string;
  providerOutcome: string;
  providerMessageId: string;
  outboxEventId: string;
  platformJobRunId: string;
  aggregateReference: string;
  sendAttemptId: string;
  auditCompleteness: "complete" | "audit_incomplete";
  missingEvidence: string[];
  latestEvent: string;
  sentAt: string;
}

type ProviderMetadata = Record<string, unknown>;

export function buildEmailSupportReport(
  send: AdminEmailSend,
  events: AdminEmailEvent[],
): EmailSupportReport {
  const metadata = asObject(send.provider_response);
  const latest = latestEvent(events);
  const triggerSource = firstString(metadata, ["triggerSource", "trigger_source"]) ?? send.source ?? "unknown";
  const triggerReason =
    firstString(metadata, ["triggerReason", "trigger_reason", "triggerEvent", "trigger_event"]) ??
    send.template_slug ??
    "unknown";
  const environment = firstString(metadata, ["emailEnvironment", "environment", "email_environment"]) ?? "unknown";
  const resolvedBaseUrl = firstString(metadata, ["emailBaseUrl", "resolvedBaseUrl", "baseUrl", "origin"]) ?? "-";
  const originSource = firstString(metadata, ["emailOriginSource", "originSource"]) ?? "-";
  const providerMessageId = send.resend_id ?? firstString(metadata, ["id", "providerMessageId", "message_id"]) ?? "-";
  const outboxEventId = firstString(metadata, ["outboxEventId", "outbox_event_id"]) ?? "-";
  const platformJobRunId = firstString(metadata, ["platformJobRunId", "platform_job_run_id", "jobRunId"]) ?? "-";
  const aggregate = aggregateReference(metadata);
  const sendAttemptId = firstString(metadata, ["sendAttemptId", "send_attempt_id", "deliveryId", "delivery_id"]) ?? "-";
  const missingEvidence = missingAuditEvidence({
    triggerSource,
    triggerReason,
    environment,
    resolvedBaseUrl,
    originSource,
    providerMessageId,
    outboxEventId,
    platformJobRunId,
    aggregateReference: aggregate,
    sendAttemptId,
  });

  return {
    recipientReference: recipientReference(send),
    triggerSource,
    triggerReason,
    environment,
    resolvedBaseUrl,
    originSource,
    providerOutcome: providerOutcome(send, metadata),
    providerMessageId,
    outboxEventId,
    platformJobRunId,
    aggregateReference: aggregate,
    sendAttemptId,
    auditCompleteness: missingEvidence.length > 0 ? "audit_incomplete" : "complete",
    missingEvidence,
    latestEvent: latest ? `${latest.event_type ?? "unknown"} @ ${latest.timestamp ?? "-"}` : "-",
    sentAt: send.sent_at ?? "-",
  };
}

function recipientReference(send: AdminEmailSend): string {
  if (send.testers) {
    const name = [send.testers.first_name, send.testers.last_name].filter(Boolean).join(" ").trim();
    return `${name || "tester"} <${send.testers.email}>`;
  }
  return send.tester_id ? `tester:${send.tester_id}` : "unknown";
}

function providerOutcome(send: AdminEmailSend, metadata: ProviderMetadata): string {
  if (send.provider_error) return `failed: ${send.provider_error}`;
  const httpStatus = firstString(metadata, ["http_status", "httpStatus"]);
  if (httpStatus) return `${send.status ?? "unknown"} (HTTP ${httpStatus})`;
  if (metadata.exception === true) return send.status ?? "exception";
  return send.status ?? "unknown";
}

function aggregateReference(metadata: ProviderMetadata): string {
  const refs = [
    label("order", firstString(metadata, ["orderId", "order_id"])),
    label("notification", firstString(metadata, ["notificationId", "notification_id"])),
    label("email_send", firstString(metadata, ["emailSendId", "email_send_id"])),
  ].filter(Boolean);
  return refs.length > 0 ? refs.join(", ") : "-";
}

function latestEvent(events: AdminEmailEvent[]): AdminEmailEvent | null {
  return events
    .filter((event) => event.timestamp)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0] ?? null;
}

function asObject(value: unknown): ProviderMetadata {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProviderMetadata : {};
}

function firstString(metadata: ProviderMetadata, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function label(name: string, value: string | null): string | null {
  return value ? `${name}:${value}` : null;
}

function missingAuditEvidence(evidence: {
  triggerSource: string;
  triggerReason: string;
  environment: string;
  resolvedBaseUrl: string;
  originSource: string;
  providerMessageId: string;
  outboxEventId: string;
  platformJobRunId: string;
  aggregateReference: string;
  sendAttemptId: string;
}): string[] {
  const missing: string[] = [];
  if (evidence.triggerSource === "unknown" || evidence.triggerReason === "unknown") {
    missing.push("trigger");
  }
  if (evidence.environment === "unknown" || evidence.resolvedBaseUrl === "-" || evidence.originSource === "-") {
    missing.push("origin");
  }
  if (evidence.providerMessageId === "-") {
    missing.push("provider");
  }
  if (evidence.sendAttemptId === "-") {
    missing.push("send_attempt");
  }
  if (
    evidence.outboxEventId === "-" &&
    evidence.platformJobRunId === "-" &&
    evidence.aggregateReference === "-"
  ) {
    missing.push("correlation");
  }
  return missing;
}

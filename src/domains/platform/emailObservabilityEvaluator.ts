import type { AlertDecision, ObservabilitySnapshot } from "./observabilityContracts.js";
import type { AlertHumanContext } from "./alertHumanContext.js";
import { urgencyForSeverity } from "./alertHumanContext.js";

// Transactional email_sends.source (dunning has its own critical path; threshold = spike, not one bad address).
const TRANSACTIONAL_EMAIL_SOURCES = ["outbox-dispatch"] as const;
const TRANSACTIONAL_EMAIL_FAILURE_THRESHOLD = 3;
// One recipient legitimately gets ~5 lifecycle mails for a single order in a day
// (draft, paid, shipment, delivered, review). 8+ to one recipient in the window is
// the per-recipient flood/loop signal the abandoned-cart incident lacked.
const PER_RECIPIENT_SEND_THRESHOLD = 8;

// Skip reasons that mean the silence was CORRECT: the order was already paid,
// had moved on, or was gone. Anything else settled a customer email without
// sending it for a reason the customer would not accept, so it is counted as
// suspect. Allowlisting the benign side rather than denylisting the defective
// one is deliberate — a skip reason added later shows up as suspect until
// someone decides it is benign, which is the failure direction we want after
// 2026-08-20, when a swallowed decline notice was visible nowhere at all.
const BENIGN_SKIP_REASONS = new Set([
  "order_already_paid",
  "order_not_pending_payment",
  "order_no_longer_draft",
  "order_not_expired",
  "order_unavailable",
]);
const SUSPECT_SKIP_THRESHOLD = 1;

// Every alert below carries `count`: on the ntfy path the payload never travels, so the
// only evidence an operator reads is evidenceSummary's whitelist (webhookAlertSink.ts:243),
// and `count` is the sole magnitude key on it. Without it the page states that something
// failed but not how much, and one bad address is indistinguishable from an outage.
// Alerts whose message text already spells the number out are exempt.
export function collectEmailAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  if (snapshot.emails.criticalFailedCount > 0) {
    decisions.push(emailAlert("critical_email_failed", "Critical email send failed", "Critical email source has failed sends in the watchdog window.", { ...snapshot.emails, count: snapshot.emails.criticalFailedCount }));
  }
  if (snapshot.emails.customerTimelineFailedCount > 0) {
    decisions.push(emailAlert("customer_email_delivery_failed", "Customer email delivery failed", "Customer-facing delivery timeline has failed, bounced or complained sends.", { ...snapshot.emails, count: snapshot.emails.customerTimelineFailedCount }));
  }
  if (snapshot.emails.customerTimelineMissedCount > 0 || snapshot.emails.customerTimelineOverdueCount > 0) {
    decisions.push(emailAlert("customer_email_delivery_missed", "Customer email delivery missed", "Customer-facing delivery timeline has planned or queued sends past SLA.", { ...snapshot.emails, count: snapshot.emails.customerTimelineMissedCount + snapshot.emails.customerTimelineOverdueCount }));
  }
  if (snapshot.emails.auditIncompleteCount > 0) {
    decisions.push(emailAlert("customer_email_audit_incomplete", "Customer email audit incomplete", "Current customer email sends are missing trigger, origin, provider, send attempt, or correlation evidence.", { ...snapshot.emails, count: snapshot.emails.auditIncompleteCount }, "p2", "never"));
  }
  if (snapshot.emails.previewProductionDomainLinkCount > 0) {
    decisions.push(emailAlert("preview_email_production_domain_link", "Preview email points to production", "Preview or staging email metadata resolved a customer CTA origin to the production domain.", { ...snapshot.emails, count: snapshot.emails.previewProductionDomainLinkCount }));
  }
  if (snapshot.emails.webhookGapCount > 0) {
    decisions.push(emailAlert("email_webhook_gap", "Email provider webhook gap", "Sent provider messages are older than the webhook grace window without matching delivery event evidence.", { ...snapshot.emails, count: snapshot.emails.webhookGapCount }));
  }
  if (snapshot.emails.communicationOutboxFailedCount > 0) {
    decisions.push(emailAlert("communication_outbox_failed", "Communication outbox failed", "Communication or email outbox events failed and may block customer messaging.", { ...snapshot.emails, count: snapshot.emails.communicationOutboxFailedCount }));
  }
  if ((snapshot.emails.maxSendsPerRecipient ?? 0) >= PER_RECIPIENT_SEND_THRESHOLD) {
    decisions.push(emailAlert("per_recipient_email_volume", "Per-recipient email volume spike", `A single recipient received ${snapshot.emails.maxSendsPerRecipient} emails in the watchdog window (threshold ${PER_RECIPIENT_SEND_THRESHOLD}) — possible flood or send loop.`, snapshot.emails));
  }
  // Customer emails settled without sending. Invisible to every counter above,
  // because a swallowed notice is a `processed` row and the queue counters only
  // read pending/failed/processing.
  const suspectSkips = Object.entries(snapshot.emails.skippedByReason ?? {})
    .filter(([reason]) => !BENIGN_SKIP_REASONS.has(reason))
    .reduce((sum, [, count]) => sum + count, 0);
  if (suspectSkips >= SUSPECT_SKIP_THRESHOLD) {
    decisions.push(emailAlert("customer_notice_skipped", "Customer email settled without sending", `Customer-facing email events were marked processed without a send for a reason that is not a settled order state (${suspectSkips} in the watchdog window). The buyer was told nothing.`, { ...snapshot.emails, count: suspectSkips }, "p2"));
  }
  // Transactional send failures (sent_at NULL) — now visible via the created_at window. p2: recoverable, logged.
  const transactionalFailed = TRANSACTIONAL_EMAIL_SOURCES.reduce((sum, source) => sum + (snapshot.emails.failedBySource[source] ?? 0), 0);
  if (transactionalFailed >= TRANSACTIONAL_EMAIL_FAILURE_THRESHOLD) {
    decisions.push(emailAlert("transactional_email_failures", "Transactional email send failures", `Outbox-dispatched email sends are failing at the provider (${transactionalFailed} in the watchdog window) and are permanently discarded without retry.`, { ...snapshot.emails, transactionalFailed }, "p2"));
  }
}

function emailAlert(
  dedupeKey: string,
  title: string,
  message: string,
  payload: Record<string, unknown>,
  severity: "p1" | "p2" = "p1",
  paging: "default" | "never" = "default",
): AlertDecision {
  return {
    dedupeKey,
    severity,
    owner: "platform/communications",
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    title,
    message,
    humanContext: emailHumanContext(dedupeKey, severity),
    channels: ["webhook"],
    ...(paging === "never" ? { paging } : {}),
    payload,
  };
}

function emailHumanContext(dedupeKey: string, severity: "p1" | "p2"): AlertHumanContext {
  switch (dedupeKey) {
    case "customer_email_delivery_failed":
      return {
        incidentClass: "customer_communication_failure",
        impact: "A customer-facing email reached a terminal failed, bounced, or complained state; customers may miss transactional information.",
        firstAction: "Inspect fresh communication_email_deliveries terminal failures, then compare the Resend message state and webhook evidence before retrying.",
        urgency: urgencyForSeverity(severity),
      };
    case "customer_email_delivery_missed":
      return {
        incidentClass: "customer_communication_failure",
        impact: "A customer-facing email is planned, queued, processing, or missed past its SLA; customer timeline communication may be late.",
        firstAction: "Inspect overdue communication_email_deliveries rows and the communication/outbox dispatcher run ledger before replaying.",
        urgency: urgencyForSeverity(severity),
      };
    case "email_webhook_gap":
      return {
        incidentClass: "customer_communication_failure",
        impact: "Resend accepted email sends but the app has no matching delivery events, so delivery truth may be stale.",
        firstAction: "Check the Resend webhook endpoint/secret and recent email_webhook_attempts before replaying customer sends.",
        urgency: urgencyForSeverity(severity),
      };
    case "communication_outbox_failed":
      return {
        incidentClass: "queue_backlog",
        impact: "Communication outbox events failed and may block customer or operator messaging.",
        firstAction: "Open the failed communication outbox events, inspect the handler error, and replay only after the root cause is fixed.",
        urgency: urgencyForSeverity(severity),
      };
    case "transactional_email_failures":
      return {
        incidentClass: "customer_communication_failure",
        impact: "Provider-backed transactional emails are failing above the spike threshold and may be permanently discarded.",
        firstAction: "Inspect recent failed email_sends by source and provider_response, then verify Resend/API key health.",
        urgency: urgencyForSeverity(severity),
      };
    default:
      return {
        incidentClass: "customer_communication_failure",
        impact: "The communications watchdog found unhealthy customer or operator email evidence.",
        firstAction: "Start with the email section of the observability runbook and inspect the alert payload counts.",
        urgency: urgencyForSeverity(severity),
      };
  }
}

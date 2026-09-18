import { describe, expect, it } from "vitest";
import { summarizeEmailEvidence } from "./emailObservabilityEvidence.js";

const now = new Date("2026-06-06T10:00:00.000Z");

describe("email observability evidence", () => {
  it("keeps complete current sends out of audit-incomplete counts", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [{ send_id: "send-1", event_type: "delivered", timestamp: "2026-06-06T09:45:00.000Z" }],
      outboxEvents: [],
      emailSends: [{
        id: "send-1",
        status: "sent",
        source: "outbox-dispatch",
        sent_at: "2026-06-06T09:40:00.000Z",
        resend_id: "resend-1",
        template_slug: "commerce-order-paid",
        provider_response: {
          emailEnvironment: "hidden_preview",
          emailBaseUrl: "https://hidden-preview.example.com",
          emailOriginSource: "explicit",
          triggerSource: "outbox-dispatch",
          triggerReason: "commerce.order.paid",
          sendAttemptId: "delivery-1",
          outboxEventId: "outbox-1",
        },
      }],
    });

    expect(health.auditIncompleteCount).toBe(0);
    expect(health.webhookGapCount).toBe(0);
    expect(health.previewProductionDomainLinkCount).toBe(0);
  });

  it("counts the max sent deliveries to a single recipient fingerprint, ignoring null/blank", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      outboxEvents: [],
      emailSends: [],
      sentRecipientFingerprints: ["fp-a", "fp-a", "fp-a", "fp-b", null, undefined, ""],
    });

    expect(health.maxSendsPerRecipient).toBe(3);
  });

  it("defaults maxSendsPerRecipient to 0 when no sent fingerprints are provided", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      outboxEvents: [],
      emailSends: [],
    });

    expect(health.maxSendsPerRecipient).toBe(0);
  });

  it("flags current sends missing support evidence", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      outboxEvents: [],
      emailSends: [{
        id: "send-1",
        status: "sent",
        source: "process-email-queue",
        sent_at: "2026-06-06T09:50:00.000Z",
        template_slug: "feedback-mid",
      }],
    });

    expect(health.auditIncompleteCount).toBe(1);
  });

  it("accepts only strongly correlated successful delivery evidence", () => {
    const fingerprint = "a".repeat(64);
    const health = summarizeEmailEvidence({
      now,
      emailEvents: [],
      outboxEvents: [],
      emailSends: ["complete", "wrong-template", "no-recipient", "no-aggregate"].map((id) => ({
        id,
        status: "sent",
        source: "outbox-dispatch",
        sent_at: "2026-06-06T09:50:00.000Z",
        template_slug: "commerce-order-paid",
      })),
      communicationEmailDeliveries: [
        {
          id: "delivery-complete",
          status: "delivered",
          template_slug: "commerce-order-paid",
          recipient_fingerprint: fingerprint,
          aggregate_type: "commerce_order",
          aggregate_id: "order-1",
          email_send_id: "complete",
        },
        {
          status: "sent",
          template_slug: "commerce-order-refunded",
          recipient_fingerprint: fingerprint,
          aggregate_type: "commerce_order",
          aggregate_id: "order-2",
          email_send_id: "wrong-template",
        },
        {
          status: "sent",
          template_slug: "commerce-order-paid",
          recipient_fingerprint: null,
          aggregate_type: "commerce_order",
          aggregate_id: "order-3",
          email_send_id: "no-recipient",
        },
        {
          status: "sent",
          template_slug: "commerce-order-paid",
          recipient_fingerprint: fingerprint,
          aggregate_type: null,
          aggregate_id: null,
          email_send_id: "no-aggregate",
        },
      ],
    });

    expect(health.auditIncompleteCount).toBe(3);
  });

  it("flags preview metadata that resolves customer origin to configured production hosts", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      outboxEvents: [],
      emailSends: [{
        id: "send-1",
        status: "sent",
        sent_at: "2026-06-06T09:50:00.000Z",
        resend_id: "resend-1",
        provider_response: {
          emailEnvironment: "hidden_preview",
          emailBaseUrl: "https://example.com/feedback",
        },
      }],
      productionHosts: ["example.com", "www.example.com"],
    });

    expect(health.previewProductionDomainLinkCount).toBe(1);
  });

  it("does not assume production hosts without downstream configuration", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      outboxEvents: [],
      emailSends: [{
        id: "send-1",
        status: "sent",
        sent_at: "2026-06-06T09:50:00.000Z",
        provider_response: {
          emailEnvironment: "hidden_preview",
          emailBaseUrl: "https://example.com/feedback",
        },
      }],
    });

    expect(health.previewProductionDomainLinkCount).toBe(0);
  });

  it("flags sent Resend messages without webhook events after the grace window", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [{ send_id: "send-with-event", event_type: "delivered", timestamp: "2026-06-06T09:31:00.000Z" }],
      outboxEvents: [],
      emailSends: [
        {
          id: "send-with-event",
          status: "sent",
          sent_at: "2026-06-06T09:20:00.000Z",
          resend_id: "resend-with-event",
        },
        {
          id: "send-gap",
          status: "sent",
          sent_at: "2026-06-06T09:20:00.000Z",
          resend_id: "resend-gap",
        },
      ],
    });

    expect(health.webhookGapCount).toBe(1);
  });

  it("separates communication outbox failures from unrelated failed outbox events", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      emailSends: [],
      outboxEvents: [
        { status: "failed", event_type: "commerce.order.paid.email" },
        { status: "failed", event_type: "commerce.inventory.stock_sync" },
      ],
    });

    expect(health.communicationOutboxFailedCount).toBe(1);
  });

  it("does not count explicit cleanup skips as overdue customer email misses", () => {
    const health = summarizeEmailEvidence({
      now,
      emailEvents: [],
      emailSends: [],
      outboxEvents: [],
      communicationEmailDeliveries: [
        {
          status: "skipped",
          purpose: "transactional",
          expected_send_at: "2026-06-06T08:00:00.000Z",
        },
        {
          status: "planned",
          purpose: "transactional",
          expected_send_at: "2026-06-06T08:00:00.000Z",
        },
      ],
    });

    expect(health.customerTimelineOverdueCount).toBe(1);
    expect(health.customerTimelineMissedCount).toBe(0);
  });

  it("counts only recent terminal customer delivery failures while keeping timestamp-less rows actionable", () => {
    const health = summarizeEmailEvidence({
      now,
      emailEvents: [],
      emailSends: [],
      outboxEvents: [],
      communicationEmailDeliveries: [
        {
          status: "failed",
          purpose: "transactional",
          terminal_at: "2026-06-06T09:30:00.000Z",
        },
        {
          status: "bounced",
          purpose: "transactional",
          terminal_at: "2026-06-04T09:30:00.000Z",
        },
        {
          status: "missed",
          purpose: "marketing",
          updated_at: "2026-06-06T08:30:00.000Z",
        },
        {
          status: "complained",
          purpose: "transactional",
        },
      ],
    });

    expect(health.customerTimelineFailedCount).toBe(2);
    expect(health.customerTimelineMissedCount).toBe(1);
    expect(health.failedByPurpose).toEqual({ transactional: 2, marketing: 1 });
  });

  // A swallowed customer notice is a `processed` row, so every other counter in
  // this module reads it as handled. These two are the only evidence it left.
  it("counts customer notices that were settled without a send, by reason", () => {
    const health = summarizeEmailEvidence({
      now,
      communicationEmailDeliveries: [],
      emailEvents: [],
      outboxEvents: [],
      emailSends: [],
      skippedOutboxEvents: [
        { id: "e1", status: "processed", event_type: "commerce.payment.failed", metadata: { skipped: "payment_session_active" } },
        { id: "e2", status: "processed", event_type: "commerce.checkout_recovery", metadata: { skipped: "payment_session_active" } },
        { id: "e3", status: "processed", event_type: "commerce.payment.failed", metadata: { skipped: "order_already_paid" } },
        // Sent normally — no marker, must not be counted.
        { id: "e4", status: "processed", event_type: "commerce.payment.failed", metadata: { providerMessageId: "msg-1" } },
        // Not settled yet — belongs to the queue counters, not here.
        { id: "e5", status: "pending", event_type: "commerce.payment.failed", metadata: { skipped: "payment_session_active" } },
      ],
    });

    expect(health.customerNoticeSkippedCount).toBe(3);
    expect(health.skippedByReason).toEqual({
      payment_session_active: 2,
      order_already_paid: 1,
    });
  });
});

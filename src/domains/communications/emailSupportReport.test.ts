import { describe, expect, it } from "vitest";
import { buildEmailSupportReport } from "./emailSupportReport.js";
import type { AdminEmailEvent, AdminEmailSend } from "./adminEmailConsoleContracts.js";

describe("buildEmailSupportReport", () => {
  it("extracts support evidence from current provider-response metadata", () => {
    const report = buildEmailSupportReport(
      send({
        provider_response: {
          id: "resend-1",
          emailBaseUrl: "https://hidden-preview.example.com",
          emailOriginSource: "explicit",
          emailEnvironment: "hidden_preview",
          triggerSource: "process-email-queue",
          triggerReason: "feedback-mid",
          outboxEventId: "evt-1",
          sendAttemptId: "delivery-1",
        },
      }),
      [event("delivered", "2026-06-18T10:02:00.000Z")],
    );

    expect(report).toMatchObject({
      recipientReference: "Jan Kowalski <jan@example.com>",
      triggerSource: "process-email-queue",
      triggerReason: "feedback-mid",
      environment: "hidden_preview",
      resolvedBaseUrl: "https://hidden-preview.example.com",
      originSource: "explicit",
      providerOutcome: "sent",
      providerMessageId: "resend-row-1",
      sendAttemptId: "delivery-1",
      auditCompleteness: "complete",
      missingEvidence: [],
      latestEvent: "delivered @ 2026-06-18T10:02:00.000Z",
    });
  });

  it("extracts outbox and aggregate references without reading provider-recipient payloads", () => {
    const report = buildEmailSupportReport(
      send({
        testers: null,
        tester_id: null,
        status: "failed",
        provider_error: "rate limited",
        provider_response: {
          outboxEventId: "evt-1",
          orderId: "order-1",
          platformJobRunId: "job-1",
          to: ["private@example.com"],
        },
      }),
      [],
    );

    expect(report.recipientReference).toBe("unknown");
    expect(report.providerOutcome).toBe("failed: rate limited");
    expect(report.outboxEventId).toBe("evt-1");
    expect(report.platformJobRunId).toBe("job-1");
    expect(report.aggregateReference).toBe("order:order-1");
    expect(report.auditCompleteness).toBe("audit_incomplete");
    expect(report.missingEvidence).toEqual(expect.arrayContaining(["origin", "send_attempt"]));
    expect(JSON.stringify(report)).not.toContain("private@example.com");
  });

  it("falls back to source, template, status, and resend id for legacy rows", () => {
    const report = buildEmailSupportReport(send({ provider_response: null }), []);

    expect(report.triggerSource).toBe("send-welcome");
    expect(report.triggerReason).toBe("welcome");
    expect(report.environment).toBe("unknown");
    expect(report.resolvedBaseUrl).toBe("-");
    expect(report.providerMessageId).toBe("resend-row-1");
    expect(report.latestEvent).toBe("-");
    expect(report.auditCompleteness).toBe("audit_incomplete");
    expect(report.missingEvidence).toEqual(["origin", "send_attempt", "correlation"]);
  });
});

function send(overrides: Partial<AdminEmailSend>): AdminEmailSend {
  return {
    id: "send-1",
    provider_error: null,
    provider_response: {},
    resend_id: "resend-row-1",
    sent_at: "2026-06-18T10:00:00.000Z",
    source: "send-welcome",
    status: "sent",
    template_id: null,
    template_slug: "welcome",
    tester_id: "tester-1",
    testers: {
      first_name: "Jan",
      last_name: "Kowalski",
      email: "jan@example.com",
    },
    ...overrides,
  };
}

function event(eventType: string, timestamp: string): AdminEmailEvent {
  return {
    id: `event-${eventType}`,
    event_type: eventType,
    link_url: null,
    metadata: null,
    send_id: "send-1",
    timestamp,
  };
}

import { describe, expect, it } from "vitest";
import { summarizeAccountingEvidence } from "./accountingObservabilityEvidence.js";

const now = new Date("2026-06-11T12:00:00.000Z");

describe("accounting observability evidence", () => {
  it("returns actionable recovery evidence for handed-over fulfillment without invoice request", () => {
    const summary = summarizeAccountingEvidence(
      [{ id: "invoice-2", order_id: "order-with-invoice", created_at: "2026-06-11T11:00:00.000Z", ksef_status: "not_submitted" }],
      [],
      [],
      [],
      [
        {
          id: "fulfillment-missing",
          order_id: "order-missing",
          status: "handed_over",
          handed_over_at: "2026-06-11T11:00:00.000Z",
        },
        {
          id: "fulfillment-invoice",
          order_id: "order-with-invoice",
          status: "handed_over",
          handed_over_at: "2026-06-11T10:00:00.000Z",
        },
        {
          id: "fulfillment-label-only",
          order_id: "order-label-only",
          status: "label_created",
          handed_over_at: null,
        },
        {
          id: "fulfillment-no-handoff-time",
          order_id: "order-no-handoff-time",
          status: "handed_over",
          handed_over_at: null,
        },
      ],
      now,
    );

    expect(summary.shippedWithoutInvoiceCount).toBe(1);
    expect(summary.missingInvoiceHandoffs).toEqual([{
      kind: "handoff_missing_invoice_request",
      fulfillmentOrderId: "fulfillment-missing",
      orderId: "order-missing",
      status: "handed_over",
      handedOverAt: "2026-06-11T11:00:00.000Z",
      ageSeconds: 3600,
      reason: "no_accounting_invoice_for_fulfillment_handoff",
      recoveryAction: "replay_accounting_invoice_issue_request_from_handoff",
      observedAt: now.toISOString(),
    }]);
    expect(JSON.stringify(summary)).not.toContain("client_secret");
    expect(JSON.stringify(summary)).not.toContain("Bearer");
  });

  it("waits one hour after handoff before owning the missing-invoice alert", () => {
    const summary = summarizeAccountingEvidence(
      [], [], [], [],
      [{
        id: "fulfillment-recent",
        order_id: "order-recent",
        status: "in_transit",
        handed_over_at: "2026-06-11T11:00:01.000Z",
      }],
      now,
    );

    expect(summary.shippedWithoutInvoiceCount).toBe(0);
    expect(summary.missingInvoiceHandoffs).toEqual([]);
  });

  it("keeps a historical handoff actionable after fulfillment moves to an exception status", () => {
    const summary = summarizeAccountingEvidence(
      [], [], [], [],
      [{
        id: "fulfillment-exception",
        order_id: "order-exception",
        status: "exception",
        handed_over_at: "2026-06-11T10:59:59.000Z",
      }],
      now,
    );

    expect(summary.missingInvoiceHandoffs).toEqual([
      expect.objectContaining({
        fulfillmentOrderId: "fulfillment-exception",
        status: "exception",
        ageSeconds: 3601,
      }),
    ]);
  });

  it("counts issued invoices without customer delivery past the 24h boundary", () => {
    const summary = summarizeAccountingEvidence(
      [
        // Issued 2 days ago, email never sent → counted (regardless of stage).
        { id: "inv-1", order_id: "o-1", created_at: "2026-06-08T12:00:00.000Z", provider_invoice_id: "prov-1", ksef_status: "pending", email_status: null },
        // Issued and delivered → not counted.
        { id: "inv-2", order_id: "o-2", created_at: "2026-06-08T12:00:00.000Z", provider_invoice_id: "prov-2", ksef_status: "accepted", email_status: "sent" },
        // Fresh (within 24h) → not counted yet.
        { id: "inv-3", order_id: "o-3", created_at: "2026-06-10T06:00:00.000Z", provider_invoice_id: "prov-3", ksef_status: "pending", email_status: null },
        // No provider invoice yet → different stage's problem, not this one.
        { id: "inv-4", order_id: "o-4", created_at: "2026-06-08T12:00:00.000Z", provider_invoice_id: null, ksef_status: "pending", email_status: null },
        // Blocked → deliberate operator gate with its own alert.
        { id: "inv-5", order_id: "o-5", created_at: "2026-06-08T12:00:00.000Z", provider_invoice_id: "prov-5", ksef_status: "pending", email_status: null, status: "blocked", blocked_reason: "invalid_tax_id" },
      ],
      [],
      [],
      [],
      [],
      new Date("2026-06-10T12:00:00.000Z"),
    );

    expect(summary.issuedWithoutCustomerDeliveryCount).toBe(1);
  });

  it("keeps existing stale and failed outbox evidence behavior", () => {
    const summary = summarizeAccountingEvidence(
      [],
      [
        {
          id: "outbox-stale",
          status: "pending",
          created_at: "2026-06-11T10:00:00.000Z",
          next_attempt_at: "2026-06-11T10:30:00.000Z",
        },
        {
          id: "outbox-fresh",
          status: "pending",
          created_at: "2026-06-11T11:30:00.000Z",
          next_attempt_at: "2026-06-11T11:45:00.000Z",
        },
        {
          id: "outbox-failed",
          status: "failed",
          created_at: "2026-06-11T09:00:00.000Z",
        },
      ],
      [{ id: "correction-failed", status: "failed", created_at: "2026-06-11T09:00:00.000Z" }],
      [],
      [],
      now,
    );

    expect(summary.pendingOutboxCount).toBe(1);
    expect(summary.failedOutboxCount).toBe(1);
    expect(summary.failedCorrectionOutboxCount).toBe(1);
  });

  it("summarizes invoice creation, delivery, KSeF wait, and invalid tax ID evidence", () => {
    const summary = summarizeAccountingEvidence(
      [
        {
          id: "invoice-requested",
          order_id: "order-requested",
          created_at: "2026-06-11T11:00:00.000Z",
          status: "issue_requested",
          ksef_status: "not_submitted",
        },
        {
          id: "invoice-provider",
          order_id: "order-provider",
          created_at: "2026-06-11T11:00:00.000Z",
          provider_invoice_id: "fv-1",
          document_kind: "b2b_vat",
          ksef_required: true,
          ksef_status: "pending",
          email_status: "queued",
        },
        {
          id: "invoice-invalid-tax-id",
          order_id: "order-invalid-tax-id",
          created_at: "2026-06-11T11:00:00.000Z",
          status: "blocked",
          blocked_reason: "invalid_tax_id",
          ksef_status: "not_submitted",
        },
      ],
      [],
      [],
      [
        {
          id: "delivery-stale",
          status: "pending",
          created_at: "2026-06-11T10:00:00.000Z",
          next_attempt_at: "2026-06-11T10:30:00.000Z",
        },
        {
          id: "delivery-failed",
          status: "failed",
          created_at: "2026-06-11T10:00:00.000Z",
        },
        {
          id: "delivery-uncertain",
          status: "uncertain",
          created_at: "2026-06-11T10:00:00.000Z",
        },
      ],
      [],
      now,
    );

    expect(summary.issueRequestedCount).toBe(1);
    expect(summary.providerCreatedCount).toBe(1);
    expect(summary.deliveryPendingCount).toBe(1);
    expect(summary.deliveryFailedCount).toBe(2);
    expect(summary.b2bWaitingKsefCount).toBe(1);
    expect(summary.blockedInvoiceCount).toBe(1);
    expect(summary.invalidTaxIdBlockedCount).toBe(1);
  });
});

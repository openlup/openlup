import { describe, expect, it } from "vitest";
import { accountingSummary } from "./omsAccountingVisibility.js";

describe("commerce OMS accounting summary", () => {
  it("carries retry context and sanitizes outbox failure details", () => {
    expect(
      accountingSummary(
        {
          id: "92222222-2222-4222-8222-222222222221",
          order_id: "42222222-2222-4222-8222-222222222221",
          invoice_ref: "FV/OMS/1001",
          status: "issue_requested",
          provider_kind: "local_invoice_provider",
          provider_invoice_number: "FV-1001",
          ksef_status: "pending",
          total_gross_cents: 12900,
          currency: "PLN",
          updated_at: "2026-06-05T10:04:00+00:00",
        },
        [
          {
            invoice_id: "92222222-2222-4222-8222-222222222221",
            status: "failed",
            attempt_count: 3,
            next_attempt_at: "2026-06-05T11:00:00+00:00",
            last_error: {
              code: "invoice_provider_failed",
              message: "Token super-secret-key leaked for ala@example.com",
              retryable: true,
              rawPayload: { ignored: true },
            },
          },
        ],
      ),
    ).toMatchObject({
      status: "outbox_failed",
      outboxAttemptCount: 3,
      outboxNextAttemptAt: "2026-06-05T11:00:00+00:00",
      outboxLastError: {
        code: "invoice_provider_failed",
        message: "[redacted-secret] leaked for [redacted-email]",
        retryable: true,
      },
      recoveryGuidance: "review_and_retry",
    });
  });

  it("uses the newest failed issue outbox when an invoice has multiple provider rows", () => {
    const invoiceId = "92222222-2222-4222-8222-222222222221";

    expect(
      accountingSummary(
        {
          id: invoiceId,
          order_id: "42222222-2222-4222-8222-222222222221",
          invoice_ref: "FV/OMS/1002",
          status: "issue_requested",
          provider_kind: "local_invoice_provider",
          provider_invoice_number: null,
          ksef_status: "pending",
          total_gross_cents: 12900,
          currency: "PLN",
          updated_at: "2026-06-05T10:06:00+00:00",
        },
        [
          {
            invoice_id: invoiceId,
            status: "pending",
            attempt_count: 0,
            next_attempt_at: null,
            last_error: {},
            created_at: "2026-06-05T10:05:00+00:00",
          },
          {
            invoice_id: invoiceId,
            status: "failed",
            attempt_count: 1,
            next_attempt_at: "2026-06-05T10:30:00+00:00",
            last_error: { code: "admin_oms_preview_fixture" },
            created_at: "2026-06-05T10:00:00+00:00",
          },
        ],
      ),
    ).toMatchObject({
      status: "outbox_failed",
      outboxStatus: "failed",
      outboxAttemptCount: 1,
      outboxLastError: { code: "admin_oms_preview_fixture" },
      recoveryGuidance: "review_and_retry",
    });
  });
});

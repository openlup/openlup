import { describe, expect, it } from "vitest";
import {
  createSupabaseAccountingReadPort,
  type AccountingReadSupabaseClient,
} from "./accountingRead.js";

type QueryResult = { data: unknown; error: { code?: string; message?: string } | null };

describe("supabase accounting read port", () => {
  it("maps sanitized issue outbox failure context", async () => {
    const selected: Record<string, string> = {};
    const ordered: Record<string, string> = {};
    const port = createSupabaseAccountingReadPort(fakeClient(selected, ordered));

    await expect(
      port.getOrderSummary({ orderId: "22222222-2222-4222-8222-222222222222" }),
    ).resolves.toMatchObject({
      summary: {
        status: "outbox_failed",
        recoveryGuidance: "review_and_retry",
        outbox: {
          attemptCount: 3,
          nextAttemptAt: "2026-06-05T11:00:00+00:00",
          lastError: {
            code: "invoice_provider_failed",
            message: "[redacted-secret] failed for [redacted-email]",
            retryable: true,
          },
        },
      },
    });

    expect(selected.accounting_invoice_issue_outbox).toContain("last_error");
    expect(selected.accounting_invoice_issue_outbox).toContain("created_at");
    expect(ordered.accounting_invoice_issue_outbox).toBe("created_at");
  });

  it("selects a replacement invoice and returns the full document history", async () => {
    const base = invoiceRow({
      status: "corrected",
      provider_invoice_id: "provider-1",
      provider_invoice_number: "1/07/2026",
      correction_status: "issued",
      metadata: {
        correctionProviderInvoiceId: "provider-k12",
        correctionProviderInvoiceNumber: "K12/2026",
      },
      created_at: "2026-07-10T10:00:00+00:00",
    });
    const replacement = invoiceRow({
      id: "88888888-8888-4888-8888-888888888888",
      invoice_ref: "OPENLUP-0F50280B:reissue-1",
      status: "issued",
      provider_invoice_id: "provider-2",
      provider_invoice_number: "2/07/2026",
      correction_of_invoice_id: base.id,
      correction_status: "none",
      metadata: {},
      created_at: "2026-07-13T07:00:00+00:00",
    });
    const port = createSupabaseAccountingReadPort(fakeClient({}, {}, [replacement, base], [{
      invoice_id: base.id,
      operation: "correction_issued",
      provider_ref: "provider-k12",
      payload: {},
      created_at: "2026-07-13T06:00:00+00:00",
    }]));

    const result = await port.getOrderSummary({ orderId: "22222222-2222-4222-8222-222222222222" });

    expect(result.summary.invoice?.providerInvoiceNumber).toBe("2/07/2026");
    expect(result.summary.documents.map((document) => document.role)).toEqual([
      "original",
      "correction",
      "replacement",
    ]);
  });
});

function fakeClient(
  selected: Record<string, string>,
  ordered: Record<string, string>,
  invoices = [invoiceRow()],
  operations: Record<string, unknown>[] = [],
): AccountingReadSupabaseClient {
  return {
    from(table: string) {
      const builder = {
        select(columns: string) {
          selected[table] = columns;
          return builder;
        },
        eq() {
          return builder;
        },
        in() {
          return builder;
        },
        order(column: string) {
          ordered[table] = column;
          return builder;
        },
        then<TResult1 = QueryResult, TResult2 = never>(
          onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve<QueryResult>({
            data: table === "accounting_invoices"
              ? invoices
              : table === "accounting_invoice_operations"
                ? operations
                : outboxRows(),
            error: null,
          }).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    order_id: "22222222-2222-4222-8222-222222222222",
    invoice_ref: "INV/2026/001",
    status: "issue_requested",
    document_type: "b2b_invoice",
    buyer_kind: "business",
    ksef_requirement: "required",
    ksef_status: "not_submitted",
    provider_kind: "local_invoice_provider",
    provider_invoice_id: null,
    provider_invoice_number: null,
    total_gross_cents: 1080,
    currency: "PLN",
    blocked_reason: null,
    correction_of_invoice_id: null,
    correction_status: "none",
    document_kind: "b2b_vat",
    email_status: "pending",
    ksef_number: null,
    metadata: {},
    created_at: "2026-06-05T10:00:00+00:00",
    updated_at: "2026-06-05T10:00:00+00:00",
    ...overrides,
  };
}

function outboxRows() {
  return [
    {
      status: "pending",
      attempt_count: 0,
      next_attempt_at: null,
      last_error: {},
      created_at: "2026-06-05T10:05:00+00:00",
    },
    {
      status: "failed",
      attempt_count: 3,
      next_attempt_at: "2026-06-05T11:00:00+00:00",
      last_error: {
        code: "invoice_provider_failed",
        message: "Token super-secret-key failed for ala@example.com",
        retryable: true,
        rawPayload: { ignored: true },
      },
      created_at: "2026-06-05T10:00:00+00:00",
    },
  ];
}

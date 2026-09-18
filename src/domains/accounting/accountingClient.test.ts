import { describe, expect, it, vi } from "vitest";
import {
  getAdminAccountingOrderSummary,
  recordAccountingProviderSyncEvent,
  recordPaymentProviderSettlement,
  requestAccountingInvoiceIssue,
} from "./accountingClient";
import type {
  AccountingInvoiceIssueRequest,
  AccountingProviderSyncEvent,
  PaymentProviderSettlementRecord,
} from "./invoiceContracts";

describe("accounting BFF client", () => {
  it("posts invoice issue requests with bearer auth", async () => {
    const fetcher = createFetcher({ invoice: invoiceSummary(), replayed: false });

    await expect(
      requestAccountingInvoiceIssue("token-1", invoiceIssueRequest(), { fetcher }),
    ).resolves.toMatchObject({ invoice: { invoiceRef: "INV/2026/001" }, replayed: false });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/accounting/invoices/issue-request",
      expect.objectContaining({ method: "POST", headers: expect.any(Headers) }),
    );
    const init = fetcher.mock.calls[0][1];
    expect(init.headers.get("Authorization")).toBe("Bearer token-1");
    expect(JSON.parse(init.body)).toMatchObject({ invoiceRef: "INV/2026/001" });
  });

  it("posts provider sync events and settlement evidence", async () => {
    const syncFetcher = createFetcher({ eventId: EVENT_ID, replayed: false });
    const settlementFetcher = createFetcher({ settlementItemId: SETTLEMENT_ID, replayed: true });

    await expect(
      recordAccountingProviderSyncEvent("token-1", providerSyncEvent(), { fetcher: syncFetcher }),
    ).resolves.toEqual({ eventId: EVENT_ID, replayed: false });
    await expect(
      recordPaymentProviderSettlement("token-2", settlementRecord(), { fetcher: settlementFetcher }),
    ).resolves.toEqual({ settlementItemId: SETTLEMENT_ID, replayed: true });

    expect(syncFetcher).toHaveBeenCalledWith(
      "/api/bff/admin/accounting/provider-sync",
      expect.objectContaining({ method: "POST" }),
    );
    expect(settlementFetcher).toHaveBeenCalledWith(
      "/api/bff/admin/accounting/settlements",
      expect.objectContaining({ method: "POST" }),
    );
    expect(settlementFetcher.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer token-2");
  });

  it("reads admin accounting order summaries with bearer auth", async () => {
    const fetcher = createFetcher({
      summary: {
        orderId: ORDER_ID,
        status: "issue_requested",
        invoice: invoiceSummary(),
        recoveryGuidance: "wait_for_retry",
        outbox: {
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: null,
          lastError: { code: "queued", message: "Waiting for worker", retryable: true },
        },
      },
    });

    await expect(getAdminAccountingOrderSummary("token-3", ORDER_ID, { fetcher })).resolves.toMatchObject({
      summary: {
        orderId: ORDER_ID,
        invoice: { invoiceRef: "INV/2026/001" },
        outbox: { lastError: { code: "queued" } },
      },
    });

    expect(fetcher).toHaveBeenCalledWith(
      `/api/bff/admin/accounting/order-summary?orderId=${ORDER_ID}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer token-3");
  });
});

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "88888888-8888-4888-8888-888888888888";
const SETTLEMENT_ID = "77777777-7777-4777-8777-777777777777";
const PAYMENT_INTENT_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_ID = "66666666-6666-4666-8666-666666666666";

function invoiceIssueRequest(): AccountingInvoiceIssueRequest {
  return {
    idempotencyKey: "invoice-issue-123",
    orderId: ORDER_ID,
    invoiceRef: "INV/2026/001",
    providerKind: "fakturownia",
    policyApprovalId: POLICY_ID,
    policy: {
      documentType: "b2b_invoice",
      buyerKind: "business",
      ksefRequirement: "required",
      policyVersion: "accounting-approved-2026-06",
      approvedBy: "11111111-1111-4111-8111-111111111111",
      approvedAt: "2026-06-06T10:00:00+02:00",
      rationale: "Business invoices go through KSeF.",
    },
    buyerSnapshot: { taxId: "5250000000" },
    orderSnapshot: { orderRef: "order_123" },
    taxSnapshot: { vatRateBps: 800 },
    linesSnapshot: [{ sku: "OPENLUP", grossMinor: 1080 }],
    totalNetMinor: 1000,
    totalGrossMinor: 1080,
  };
}

function providerSyncEvent(): AccountingProviderSyncEvent {
  return {
    idempotencyKey: "sync-event-123",
    invoiceId: INVOICE_ID,
    providerKind: "fakturownia",
    providerEventId: "fv-event-1",
    eventType: "ksef.accepted",
    providerInvoiceId: "fv-1",
    providerInvoiceNumber: "1/06/2026",
    ksefNumber: "KSeF-123",
    ksefStatus: "accepted",
    statusSource: "provider_api",
    providerPdfRef: "pdf:fv-1",
    providerXmlRef: "xml:fv-1",
    providerUpoRef: "upo:fv-1",
    observedAt: "2026-06-06T10:05:00+02:00",
    payloadHash: "sha256:abc123",
    payload: { safe: true },
  };
}

function settlementRecord(): PaymentProviderSettlementRecord {
  return {
    idempotencyKey: "settlement-123",
    providerKind: "stripe",
    providerBatchId: "po_1",
    providerPaymentId: "pi_1",
    paymentIntentId: PAYMENT_INTENT_ID,
    paymentId: PAYMENT_ID,
    invoiceId: INVOICE_ID,
    grossMinor: 1000,
    feeMinor: 29,
    netMinor: 971,
    currency: "PLN",
    status: "matched",
    bankReceivedAt: "2026-06-07T10:00:00+02:00",
    evidence: { payout: "po_1" },
  };
}

function invoiceSummary() {
  return {
    id: INVOICE_ID,
    orderId: ORDER_ID,
    invoiceRef: "INV/2026/001",
    status: "issue_requested",
    documentType: "b2b_invoice",
    buyerKind: "business",
    ksefRequirement: "required",
    ksefStatus: "not_submitted",
    providerKind: "fakturownia",
    providerInvoiceId: null,
    providerInvoiceNumber: null,
    totalGrossMinor: 1080,
    currency: "PLN",
  };
}

function createFetcher(data: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve({ ok: true, data }),
  } as Response);
}

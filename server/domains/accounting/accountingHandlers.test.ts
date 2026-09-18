import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAccountingOrderSummaryHandler,
  createAccountingInvoiceIssueHandler,
  createInvoiceDataLookupHandler,
  createPaymentSettlementRecordHandler,
} from "./accountingHandlers.js";

describe("accounting handlers", () => {
  it("fails closed before accounting mutations while disabled", async () => {
    const port = { requestInvoiceIssue: vi.fn(), recordProviderSyncEvent: vi.fn(), recordPaymentSettlement: vi.fn() };
    const handler = createAccountingInvoiceIssueHandler({
      authorizeAdmin: async () => ({ ok: true, userId: "admin-1" }),
      accountingPort: port,
      mutationsEnabled: () => false,
    });
    const res = response();

    await handler(request(issueRequest()), res);

    expect(port.requestInvoiceIssue).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "FORBIDDEN", message: "Accounting mutations are not enabled" },
    });
  });

  it("issues an invoice request through the shared BFF envelope", async () => {
    const port = {
      requestInvoiceIssue: vi.fn(async () => ({
        invoice: invoiceSummary(),
        replayed: false,
      })),
      recordProviderSyncEvent: vi.fn(),
      recordPaymentSettlement: vi.fn(),
    };
    const handler = createAccountingInvoiceIssueHandler({
      authorizeAdmin: async () => ({ ok: true, userId: "admin-1" }),
      accountingPort: port,
      mutationsEnabled: () => true,
    });
    const res = response();

    await handler(request(issueRequest()), res);

    expect(port.requestInvoiceIssue).toHaveBeenCalledWith(issueRequest());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        invoice: invoiceSummary(),
        replayed: false,
      },
    });
  });

  it("validates settlement math before calling the port", async () => {
    const port = { requestInvoiceIssue: vi.fn(), recordProviderSyncEvent: vi.fn(), recordPaymentSettlement: vi.fn() };
    const handler = createPaymentSettlementRecordHandler({
      authorizeAdmin: async () => ({ ok: true, userId: "admin-1" }),
      accountingPort: port,
      mutationsEnabled: () => true,
    });
    const res = response();

    await handler(request({ ...settlementRequest(), netMinor: 1000 }), res);

    expect(port.recordPaymentSettlement).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("normalizes GET invoice lookup NIP before calling the port", async () => {
    const lookupPort = {
      lookupInvoiceData: vi.fn(async () => invoiceLookupResponse()),
    };
    const handler = createInvoiceDataLookupHandler({ lookupPort });
    const res = response();

    await handler(
      {
        method: "GET",
        query: { taxId: "123-456-32-18" },
        body: {},
        headers: {},
      } as unknown as VercelRequest,
      res,
    );

    expect(lookupPort.lookupInvoiceData).toHaveBeenCalledWith({
      taxId: "1234563218",
      country: "PL",
      providerKind: "gus_ceidg",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects invalid invoice lookup NIP before calling the port", async () => {
    const lookupPort = {
      lookupInvoiceData: vi.fn(),
    };
    const handler = createInvoiceDataLookupHandler({ lookupPort });
    const res = response();

    await handler(request({ taxId: "5130251193" }), res);

    expect(lookupPort.lookupInvoiceData).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("reads accounting order summaries through admin auth", async () => {
    const accountingPort = {
      getOrderSummary: vi.fn(async () => ({
        summary: {
          orderId: "22222222-2222-4222-8222-222222222222",
          status: "outbox_failed" as const,
          invoice: invoiceSummary(),
          documents: [],
          recoveryGuidance: "review_and_retry" as const,
          outbox: {
            status: "failed",
            attemptCount: 3,
            nextAttemptAt: "2026-06-05T11:00:00+00:00",
            lastError: {
              code: "invoice_provider_failed",
              message: "Provider rejected local snapshot",
              retryable: true,
            },
          },
        },
      })),
    };
    const handler = createAccountingOrderSummaryHandler({
      authorizeAdmin: async () => ({ ok: true, userId: "admin-1" }),
      accountingPort,
    });
    const res = response();

    await handler(
      { method: "GET", query: { orderId: "22222222-2222-4222-8222-222222222222" }, body: {}, headers: {} } as unknown as VercelRequest,
      res,
    );

    expect(accountingPort.getOrderSummary).toHaveBeenCalledWith({
      orderId: "22222222-2222-4222-8222-222222222222",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

function request(body: Record<string, unknown>, method = "POST"): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function response(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function issueRequest() {
  return {
    idempotencyKey: "invoice-issue-123",
    orderId: "22222222-2222-4222-8222-222222222222",
    invoiceRef: "INV/2026/001",
    providerKind: "fakturownia",
    policyApprovalId: "33333333-3333-4333-8333-333333333333",
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

function settlementRequest() {
  return {
    idempotencyKey: "settlement-123",
    providerKind: "stripe",
    providerBatchId: "po_1",
    providerPaymentId: "pi_1",
    paymentIntentId: "55555555-5555-4555-8555-555555555555",
    paymentId: "66666666-6666-4666-8666-666666666666",
    invoiceId: "99999999-9999-4999-8999-999999999999",
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
    id: "99999999-9999-4999-8999-999999999999",
    orderId: "22222222-2222-4222-8222-222222222222",
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
  } as const;
}

function invoiceLookupResponse() {
  return {
    status: "found",
    providerKind: "gus_ceidg",
    taxId: "1234563218",
    source: "local_test_fixture",
    legalName: "Example Commerce Sp. z o.o.",
    regon: "012345678",
    vatStatus: "active",
    address: { line1: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
    evidenceHash: "sha256:lookup",
    observedAt: "2026-06-14T00:00:00+00:00",
  } as const;
}

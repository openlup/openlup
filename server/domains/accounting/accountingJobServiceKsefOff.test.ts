import { describe, expect, it, vi } from "vitest";
import { runAccountingInvoiceIssueJob } from "./accountingJobService.js";
import type { ClaimedAccountingInvoiceIssue } from "../../../src/domains/accounting/ports.js";

// Product ruling: a paid B2B order (valid PL NIP) MUST yield a b2b_vat document
// regardless of KSeF activation — Fakturownia account configuration owns that
// decision. This guards that runAccountingInvoiceIssueJob still issues the
// b2b_vat invoice with its local KSeF evidence intact. Split
// from accountingJobService.test.ts to keep that file under the 300-LOC cap.

const b2bClaim: ClaimedAccountingInvoiceIssue = {
  outboxId: "outbox-b2b-1",
  attemptCount: 1,
  providerKind: "fakturownia",
  payment: {
    intentId: "intent-b2b-1",
    provider: "stripe",
    providerPaymentId: "pi_b2b_1",
    amountCents: 1230,
    currency: "PLN",
    localSettlementState: "unavailable",
  },
  invoice: {
    id: "invoice-b2b-1",
    orderId: "order-b2b-1",
    orderRef: "ORDER-B2B-1",
    invoiceRef: "ORDER-B2B-1:base",
    documentKind: "b2b_vat",
    ksefRequired: true,
    currency: "PLN",
    buyerSnapshot: {
      name: "openlup B2B Sp. z o.o.",
      email: "b2b@example.test",
      taxId: "1181590588",
      companyName: "openlup B2B Sp. z o.o.",
    },
    orderSnapshot: {},
    taxSnapshot: {},
    linesSnapshot: [{ name: "Food", quantity: 1, totalGrossMinor: 1230, vatRate: "23" }],
    totalNetCents: 1000,
    totalGrossCents: 1230,
    paymentCompletedAt: "2026-06-05T10:00:00.000Z",
    packageShippedAt: "2026-06-06T11:00:00.000Z",
    providerPaymentId: "pi_b2b_1",
    metadata: { paymentProvider: "stripe" },
  },
};

describe("accounting invoice issue with provider-owned KSeF activation", () => {
  it("issues a B2B VAT invoice while preserving KSeF evidence without submission options", async () => {
    const provider = providerStub();
    const port = portStub([b2bClaim]);

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: {
        requestEnabled: false,
        createEnabled: true,
        b2cEmailEnabled: false,
        providerEmailEnabled: false,
        ksefPollEnabled: false,
        issueTrigger: "handoff",
        b2bEmailRequiresKsefAcceptance: true,
      },
      env: {},
    })).resolves.toMatchObject({ ok: true, checked: 1, updated: 1, failures: 0 });

    // Provider-owned KSeF activation must not block or skip the b2b_vat
    // document, and openlup must not pass a submission option.
    expect(provider.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ documentKind: "b2b_vat", governmentClearanceRequired: true }),
      {
        recoveryLookupRequired: false,
      },
    );
    expect(port.markInvoiceIssueSucceeded).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: "outbox-b2b-1",
    }));
    expect(port.markInvoiceIssueFailed).not.toHaveBeenCalled();
  });
});

function providerStub() {
  return {
    createInvoice: vi.fn(async () => ({
      providerInvoiceId: "provider-b2b-123",
      providerInvoiceNumber: "FV/1/2026",
      raw: { id: 123, number: "FV/1/2026" },
    })),
    createFullCorrection: vi.fn(async () => ({
      providerInvoiceId: "provider-b2b-correction-123",
      providerInvoiceNumber: "KOR/1/2026",
      raw: { id: 456, number: "KOR/1/2026" },
    })),
    downloadInvoicePdf: vi.fn(async () => ({ content: Buffer.from("%PDF-1.4"), contentType: "application/pdf" })),
    downloadKsefAttachment: vi.fn(async (_id: string, kind: "gov" | "gov_upo") => ({
      content: Buffer.from(`<${kind}/>`),
      contentType: "application/xml",
    })),
    getInvoiceKsefStatus: vi.fn(async () => ({
      ksefStatus: "pending" as const,
      ksefNumber: null,
      raw: {},
    })),
  };
}

function portStub(claims: ClaimedAccountingInvoiceIssue[]) {
  return {
    claimInvoiceIssues: vi.fn(async () => claims),
    preflightInvoiceIssuePayment: vi.fn(async () => ({
      ok: true,
      code: null,
      providerReadbackState: "unavailable" as const,
      paymentIntentId: "intent-b2b-1",
    })),
    blockInvoiceIssueCanonicalMapper: vi.fn(async () => undefined),
    markInvoiceIssueSucceeded: vi.fn(async () => undefined),
    markInvoiceIssueFailed: vi.fn(async () => undefined),
    claimInvoiceDeliveries: vi.fn(async () => []),
    markInvoiceDeliverySucceeded: vi.fn(async () => undefined),
    markInvoiceDeliveryFailed: vi.fn(async () => undefined),
    markInvoiceDeliveryUncertain: vi.fn(async () => undefined),
    listKsefPollTargets: vi.fn(async () => []),
    recordKsefStatus: vi.fn(async () => undefined),
    recordProviderDocumentSync: vi.fn(async () => undefined),
    claimInvoiceCorrections: vi.fn(async () => []),
    markInvoiceCorrectionSucceeded: vi.fn(async () => undefined),
    markInvoiceCorrectionFailed: vi.fn(async () => undefined),
  };
}

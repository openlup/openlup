import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_ACTIVATION_GATE_CASES,
  ACCOUNTING_DOCUMENT_TYPES,
  ACCOUNTING_INVOICE_STATUSES,
  adminAccountingOrderSummarySchema,
  accountingInvoiceIssueRequestSchema,
  accountingProviderSyncEventSchema,
  calculateGrossMinor,
  formatPolishNip,
  invoiceDataLookupRequestSchema,
  invoiceDataLookupResponseSchema,
  invoiceDocumentPolicySchema,
  isValidPolishNip,
  KSEF_STATUSES,
  normalizePolishNip,
  paymentProviderSettlementRecordSchema,
  readAccountingSellerConfig,
  neutralTaxIdRouting,
  routeInvoiceByTaxId,
} from "./invoiceContracts.js";
import { APP_DEFAULT_SELLER } from "../../lib/brand/appBrand.js";

describe("accounting invoice contracts", () => {
  it("models local invoice and KSeF state without provider coupling", () => {
    expect(ACCOUNTING_INVOICE_STATUSES).toEqual([
      "draft",
      "issue_requested",
      "blocked",
      "issued",
      "ksef_pending",
      "accepted",
      "rejected",
      "correction_requested",
      "corrected",
      "voided",
    ]);
    expect(KSEF_STATUSES).toEqual(["not_submitted", "pending", "accepted", "rejected", "not_required"]);
    expect(ACCOUNTING_DOCUMENT_TYPES).toEqual([
      "fiscal_receipt",
      "b2c_invoice",
      "b2b_invoice",
      "correction_invoice",
    ]);
  });

  it("derives gross amounts from immutable net/tax snapshots", () => {
    expect(calculateGrossMinor(1000, 8)).toBe(1080);
    expect(calculateGrossMinor(999, 23)).toBe(1229);
  });

  it("normalizes and validates Polish NIP checksums", () => {
    expect(normalizePolishNip("123-456-32-18")).toBe("1234563218");
    expect(formatPolishNip("1234563218")).toBe("123-456-32-18");
    expect(isValidPolishNip("1234563218")).toBe(true);
    expect(isValidPolishNip("5130251193")).toBe(false);
    expect(isValidPolishNip("")).toBe(false);
  });

  it("routes B2C, B2B, and invalid NIP invoice decisions", () => {
    expect(routeInvoiceByTaxId(null)).toEqual({
      ok: true,
      documentKind: "b2c_named",
      normalizedTaxId: null,
      governmentClearanceRequired: false,
    });
    expect(routeInvoiceByTaxId("123-456-32-18")).toEqual({
      ok: true,
      documentKind: "b2b_vat",
      normalizedTaxId: "1234563218",
      governmentClearanceRequired: true,
    });
    expect(routeInvoiceByTaxId("123")).toEqual({
      ok: false,
      reason: "invalid_tax_id",
      normalizedTaxId: "123",
    });
  });

  it("answers an absent tax id and refuses a present one when no module is composed", () => {
    // The neutral default knows the one thing that is true everywhere: no tax
    // id means a consumer document. It declines to interpret a present one, and
    // names a missing configuration rather than a bad identifier — different
    // operator faults, and `invalid_tax_id` is already an alerting key.
    const absent = { ok: true, documentKind: "b2c_named", normalizedTaxId: null } as const;
    expect(neutralTaxIdRouting(null)).toEqual({ ...absent, governmentClearanceRequired: false });
    expect(neutralTaxIdRouting("   ")).toMatchObject(absent);
    expect(neutralTaxIdRouting("123-456-32-18")).toEqual({
      ok: false,
      reason: "tax_id_routing_not_configured",
      normalizedTaxId: "123-456-32-18",
    });
  });

  it("reads seller config defaults without provider secrets", () => {
    expect(readAccountingSellerConfig({}, APP_DEFAULT_SELLER)).toMatchObject({
      name: "Example Company Sp. z o.o.",
      street: "Ul. Example Street 11",
      postalCode: "32-091",
      city: "ExampleCity",
      taxId: "1234563218",
      krs: "0000000000",
      bankAccount: "21 1600 1462 1711 3485 9000 0008",
      departmentId: null,
    });
  });

  it("rejects unsafe fiscal policy defaults", () => {
    const base = {
      documentType: "b2c_invoice",
      buyerKind: "consumer",
      ksefRequirement: "optional",
      policyVersion: "accounting-approved-2026-06",
      approvedBy: "11111111-1111-4111-8111-111111111111",
      approvedAt: "2026-06-06T10:00:00+02:00",
      rationale: "Accountant-approved B2C invoice handling.",
    };

    expect(invoiceDocumentPolicySchema.safeParse(base).success).toBe(true);
    expect(invoiceDocumentPolicySchema.safeParse({ ...base, ksefRequirement: "required" }).success).toBe(false);
    expect(
      invoiceDocumentPolicySchema.safeParse({
        ...base,
        documentType: "fiscal_receipt",
        buyerKind: "business",
      }).success,
    ).toBe(false);
  });

  it("requires paid-order invoice requests to carry policy and immutable snapshots", () => {
    const request = {
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

    expect(accountingInvoiceIssueRequestSchema.safeParse(request).success).toBe(true);
    expect(accountingInvoiceIssueRequestSchema.safeParse({ ...request, totalGrossMinor: 999 }).success).toBe(false);
  });

  it("models provider sync evidence and payout settlement math", () => {
    expect(
      accountingProviderSyncEventSchema.safeParse({
        idempotencyKey: "sync-event-123",
        invoiceId: "44444444-4444-4444-8444-444444444444",
        providerKind: "fakturownia",
        providerEventId: "fakturownia-event-1",
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
      }).success,
    ).toBe(true);

    expect(
      paymentProviderSettlementRecordSchema.safeParse({
        idempotencyKey: "settlement-123",
        providerKind: "stripe",
        providerBatchId: "po_1",
        providerPaymentId: "pi_1",
        paymentIntentId: "55555555-5555-4555-8555-555555555555",
        paymentId: "66666666-6666-4666-8666-666666666666",
        invoiceId: "44444444-4444-4444-8444-444444444444",
        grossMinor: 1000,
        feeMinor: 29,
        netMinor: 971,
        currency: "PLN",
        status: "matched",
        bankReceivedAt: "2026-06-07T10:00:00+02:00",
        evidence: { payout: "po_1" },
      }).success,
    ).toBe(true);
    expect(
      paymentProviderSettlementRecordSchema.safeParse({
        idempotencyKey: "settlement-123",
        providerKind: "stripe",
        providerBatchId: "po_1",
        providerPaymentId: "pi_1",
        grossMinor: 1000,
        feeMinor: 29,
        netMinor: 1000,
        currency: "PLN",
        status: "matched",
      }).success,
    ).toBe(false);
  });

  it("requires activation evidence beyond provider credentials", () => {
    expect(ACCOUNTING_ACTIVATION_GATE_CASES).toContain("settlement_import_reconciliation");
    expect(ACCOUNTING_ACTIVATION_GATE_CASES).toContain("provider_split_brain_quarantine");
  });

  it("keeps invoice data lookup provider-neutral", () => {
    expect(
      invoiceDataLookupRequestSchema.parse({ taxId: "123-456-32-18" }),
    ).toMatchObject({
      taxId: "1234563218",
      country: "PL",
      providerKind: "gus_ceidg",
    });
    expect(
      invoiceDataLookupResponseSchema.safeParse({
        status: "found",
        providerKind: "gus_ceidg",
        taxId: "1234563218",
        source: "local_test_fixture",
        legalName: "Example Company Sp. z o.o.",
        regon: "012345678",
        vatStatus: "active",
        address: { line1: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
        evidenceHash: "sha256:lookup",
        observedAt: "2026-06-06T10:00:00+02:00",
      }).success,
    ).toBe(true);
  });

  it("models admin order summary retry context without raw provider payloads", () => {
    expect(
      adminAccountingOrderSummarySchema.safeParse({
        orderId: "22222222-2222-4222-8222-222222222222",
        status: "outbox_failed",
        recoveryGuidance: "review_and_retry",
        invoice: invoiceSummary(),
        outbox: {
          status: "failed",
          attemptCount: 3,
          nextAttemptAt: "2026-06-05T11:00:00+00:00",
          lastError: {
            code: "invoice_provider_failed",
            message: "Provider rejected the local snapshot",
            retryable: true,
            rawPayload: { unsafe: true },
          },
        },
      }).success,
    ).toBe(false);

    expect(
      adminAccountingOrderSummarySchema.safeParse({
        orderId: "22222222-2222-4222-8222-222222222222",
        status: "outbox_failed",
        recoveryGuidance: "review_and_retry",
        invoice: invoiceSummary(),
        outbox: {
          status: "failed",
          attemptCount: 3,
          nextAttemptAt: "2026-06-05T11:00:00+00:00",
          lastError: {
            code: "invoice_provider_failed",
            message: "Provider rejected the local snapshot",
            retryable: true,
          },
        },
      }).success,
    ).toBe(true);
  });
});

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
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  runAccountingInvoiceDeliveryJob,
  runAccountingInvoiceIssueJob,
  runAccountingKsefStatusJob,
} from "./accountingJobService.js";
import type { AccountingRuntimeConfig } from "./accountingRuntimeConfig.js";
import type { ClaimedAccountingInvoiceIssue } from "../../../src/domains/accounting/ports.js";
import { AccountingInvoicePersistenceError } from "../../../src/domains/accounting/ports.js";

const claim: ClaimedAccountingInvoiceIssue = {
  outboxId: "outbox-1",
  attemptCount: 1,
  providerKind: "fakturownia",
  payment: {
    intentId: "intent-1",
    provider: "stripe",
    providerPaymentId: "pi_123",
    amountCents: 1080,
    currency: "PLN",
    localSettlementState: "unavailable",
  },
  invoice: {
    id: "invoice-1",
    orderId: "order-1",
    orderRef: "ORDER-1",
    invoiceRef: "ORDER-1:base",
    documentKind: "b2c_named",
    ksefRequired: false,
    currency: "PLN",
    buyerSnapshot: { name: "Client", email: "client@example.test", taxId: null },
    orderSnapshot: {},
    taxSnapshot: {},
    linesSnapshot: [{ name: "Food", quantity: 1, totalGrossMinor: 1080, vatRate: "8" }],
    totalNetCents: 1000,
    totalGrossCents: 1080,
    paymentCompletedAt: "2026-06-05T10:00:00.000Z",
    packageShippedAt: "2026-06-06T11:00:00.000Z",
    providerPaymentId: "pi_123",
    metadata: { paymentProvider: "stripe" },
  },
};

describe("accounting job service", () => {
  it("does not claim work or call provider when create flag is disabled", async () => {
    const port = portStub();
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: false, b2cEmailEnabled: true, ksefPollEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: true, skipped: true, reason: "create_disabled" });

    expect(port.claimInvoiceIssues).not.toHaveBeenCalled();
    expect(provider.createInvoice).not.toHaveBeenCalled();
  });

  it("keeps provider-posture env out of issue options and does not send B2C email inline", async () => {
    const port = portStub({ claims: [claim] });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true, b2cEmailEnabled: true, ksefPollEnabled: false }),
      env: { FAKTUROWNIA_ENV: "production" },
    })).resolves.toMatchObject({ ok: true, checked: 1, updated: 1 });

    expect(provider.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      documentKind: "b2c_named",
      governmentClearanceRequired: false,
    }), {
      recoveryLookupRequired: false,
    });
    expect(port.preflightInvoiceIssuePayment).toHaveBeenCalledTimes(2);
    expect(port.preflightInvoiceIssuePayment).toHaveBeenNthCalledWith(1, expect.objectContaining({
      providerEvidence: { source: "local_canonical_snapshot" },
    }));
    expect(port.preflightInvoiceIssuePayment).toHaveBeenNthCalledWith(2, expect.objectContaining({
      providerEvidence: expect.objectContaining({ unavailableReason: "provider_not_configured" }),
    }));
  });

  it("requires provider recovery lookup after an invoice issue is re-claimed", async () => {
    const port = portStub({ claims: [{ ...claim, attemptCount: 2 }] });
    const provider = providerStub();

    await runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    });

    expect(provider.createInvoice).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      recoveryLookupRequired: true,
    }));
  });

  it("does not call the document provider when the final payment preflight blocks", async () => {
    const port = portStub({ claims: [claim] });
    port.preflightInvoiceIssuePayment.mockResolvedValueOnce({
      ok: false,
      code: "accounting_invoice_provider_settlement_amount_mismatch",
      providerReadbackState: "unavailable",
      paymentIntentId: "intent-1",
    });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1 });

    expect(port.preflightInvoiceIssuePayment).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: "invoice-1",
      providerStatus: "unavailable",
    }));
    expect(provider.createInvoice).not.toHaveBeenCalled();
    expect(port.markInvoiceIssueFailed).not.toHaveBeenCalled();
  });

  it("does not let a stale success handler fail the newer claim", async () => {
    const port = portStub({ claims: [claim] });
    port.markInvoiceIssueSucceeded.mockRejectedValueOnce(
      new AccountingInvoicePersistenceError(
        "Accounting invoice issue success was fenced",
        "accounting_invoice_issue_claim_generation_mismatch",
      ),
    );
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1 });

    expect(port.markInvoiceIssueFailed).not.toHaveBeenCalled();
  });

  it("terminally blocks an independent canonical mapper delta without scheduling a retry", async () => {
    const canonicalClaim: ClaimedAccountingInvoiceIssue = {
      ...claim,
      invoice: {
        ...claim.invoice,
        linesSnapshot: [{
          positionKind: "item",
          name: "Food",
          quantity: 1,
          unitGrossMinor: 1080,
          totalGrossMinor: 1080,
          unitNetMinor: 1000,
          totalNetMinor: 1000,
          vatRate: "23",
          vatRateBps: 800,
          catalogTotalGrossMinor: 1080,
          discountAllocatedMinor: 0,
        }],
        orderMoney: null,
      },
    };
    const port = portStub({ claims: [canonicalClaim] });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1 });

    expect(port.blockInvoiceIssueCanonicalMapper).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: "invoice-1",
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      code: "accounting_invoice_canonical_position_vat_label_mismatch",
    }));
    expect(port.markInvoiceIssueFailed).not.toHaveBeenCalled();
    expect(provider.createInvoice).not.toHaveBeenCalled();
  });

  it("allows staging policy to claim B2B provider email before KSeF acceptance", async () => {
    const port = portStub();
    const provider = providerStub();

    await runAccountingInvoiceDeliveryJob({
      port,
      provider,
      deliveryPort: deliveryStub(),
      expectedProviderKind: "fakturownia",
      config: config({ providerEmailEnabled: true, b2bEmailRequiresKsefAcceptance: false }),
    });

    expect(port.claimInvoiceDeliveries).toHaveBeenCalledWith(25, {
      requireKsefAcceptanceForB2b: false,
      orderId: null,
    });
  });

  it("passes targeted order id to issue and delivery claims", async () => {
    const port = portStub({ claims: [claim] });
    const provider = providerStub();

    await runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
      orderId: "order-1",
    });
    await runAccountingInvoiceDeliveryJob({
      port,
      provider,
      deliveryPort: deliveryStub(),
      expectedProviderKind: "fakturownia",
      config: config({ providerEmailEnabled: true }),
      orderId: "order-1",
    });

    expect(port.claimInvoiceIssues).toHaveBeenCalledWith(10, { orderId: "order-1" });
    expect(port.claimInvoiceDeliveries).toHaveBeenCalledWith(25, {
      requireKsefAcceptanceForB2b: true,
      orderId: "order-1",
    });
  });

  it("fails the issue outbox when provider create fails before an invoice exists", async () => {
    const port = portStub({ claims: [claim] });
    const provider = providerStub();
    provider.createInvoice.mockRejectedValueOnce(new Error("provider buyer_email=client@example.test"));

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true, b2cEmailEnabled: true, ksefPollEnabled: false }),
      env: {},
    })).resolves.toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1 });

    expect(port.markInvoiceIssueFailed).toHaveBeenCalledWith(expect.objectContaining({
      error: { message: "provider buyer_email=[redacted-email]" },
      claimAttemptCount: 1,
    }));
  });

  it("issues discounted claims with positions reconciled to the charged total", async () => {
    const discountedClaim = {
      ...claim,
      invoice: {
        ...claim.invoice,
        // Catalog lines sum 20100; the customer was charged 11175 (bundle discount).
        linesSnapshot: [3, 3, 3, 2, 2, 2].map((quantity, index) => ({
          name: `Food ${index + 1}`,
          quantity,
          unitGrossMinor: 1340,
          totalGrossMinor: 1340 * quantity,
          vatRate: "8",
        })),
        totalNetCents: 10347,
        totalGrossCents: 11175,
      },
    };
    const port = portStub({ claims: [discountedClaim] });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: true, checked: 1, updated: 1 });

    const snapshot = (provider.createInvoice.mock.calls as unknown as unknown[][])[0][0] as {
      chargedTotalGrossMinor?: number;
      lines: Array<{ totalGrossMinor?: number }>;
    };
    expect(snapshot.chargedTotalGrossMinor).toBe(11175);
    expect(snapshot.lines.reduce((sum: number, line) => sum + (line.totalGrossMinor ?? 0), 0)).toBe(11175);
  });

  it("issues shipping-charged claims with an explicit Dostawa position", async () => {
    const shippedClaim = {
      ...claim,
      invoice: {
        ...claim.invoice,
        // Charged above the item lines: flat shipping with no line to carry
        // it. With the order money breakdown the residual becomes a position.
        linesSnapshot: [{ name: "Food", quantity: 1, totalGrossMinor: 1490, vatRate: "8" }],
        totalGrossCents: 2990,
        orderMoney: { subtotalCents: 1490, discountCents: 0, shippingCents: 1500, shippingDiscountCents: 0, totalCents: 2990 },
      },
    };
    const port = portStub({ claims: [shippedClaim] });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: true, checked: 1, updated: 1 });

    const snapshot = (provider.createInvoice.mock.calls as unknown as unknown[][])[0][0] as {
      chargedTotalGrossMinor?: number;
      lines: Array<{ name: string; totalGrossMinor?: number }>;
    };
    expect(snapshot.lines.map((line) => line.name)).toEqual(["Food", "Dostawa"]);
    expect(snapshot.lines.reduce((sum: number, line) => sum + (line.totalGrossMinor ?? 0), 0)).toBe(2990);
    expect(snapshot.chargedTotalGrossMinor).toBe(2990);
  });

  it("fails the issue outbox closed when positions cannot match the charged total", async () => {
    const unreconcilableClaim = {
      ...claim,
      invoice: {
        ...claim.invoice,
        // Charged above the line totals (e.g. a shipping charge with no line).
        linesSnapshot: [{ name: "Food", quantity: 1, totalGrossMinor: 1490, vatRate: "8" }],
        totalGrossCents: 2480,
      },
    };
    const port = portStub({ claims: [unreconcilableClaim] });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1 });

    expect(provider.createInvoice).not.toHaveBeenCalled();
    expect(port.markInvoiceIssueFailed).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      error: { message: "accounting_invoice_lines_below_charged_total lines=1490 charged=2480" },
    }));
  });

  it("blocks B2B KSeF issue before provider call when buyer NIP is invalid", async () => {
    const invalidB2bClaim = {
      ...claim,
      invoice: {
        ...claim.invoice,
        documentKind: "b2b_vat",
        ksefRequired: true,
        buyerSnapshot: {
          ...claim.invoice.buyerSnapshot,
          taxId: "123",
          companyName: "Broken Tax Id Sp. z o.o.",
        },
      },
    };
    const port = portStub({ claims: [invalidB2bClaim] });
    const provider = providerStub();

    await expect(runAccountingInvoiceIssueJob({
      port,
      provider,
      config: config({ createEnabled: true }),
      env: {},
    })).resolves.toMatchObject({ ok: false, checked: 1, updated: 0, failures: 1 });

    expect(provider.createInvoice).not.toHaveBeenCalled();
    expect(port.markInvoiceIssueFailed).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: "outbox-1",
      error: { message: "fakturownia_b2b_invoice_invalid_tax_id" },
    }));
  });

  it("polls KSeF only when poll flag is enabled", async () => {
    const port = portStub({
      ksefTargets: [{ invoiceId: "invoice-1", providerInvoiceId: "provider-123", ksefStatus: "pending" }],
    });
    const provider = providerStub();

    await expect(runAccountingKsefStatusJob({
      port,
      provider,
      config: config({ createEnabled: false, b2cEmailEnabled: false, ksefPollEnabled: true }),
    })).resolves.toMatchObject({ ok: true, checked: 1, updated: 1 });

    expect(provider.getInvoiceKsefStatus).toHaveBeenCalledWith("provider-123");
    expect(port.recordKsefStatus).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: "invoice-1",
      ksefStatus: "accepted",
    }));
    expect(provider.downloadKsefAttachment).toHaveBeenCalledWith("provider-123", "gov");
    expect(provider.downloadKsefAttachment).toHaveBeenCalledWith("provider-123", "gov_upo");
    expect(port.recordProviderDocumentSync).toHaveBeenCalledWith(expect.objectContaining({
      providerPdfRef: "fakturownia:invoice:provider-123:pdf",
      providerXmlRef: "fakturownia:invoice:provider-123:gov",
      providerUpoRef: "fakturownia:invoice:provider-123:gov_upo",
    }));
  });
});

function providerStub() {
  return {
    createInvoice: vi.fn(async () => ({
      providerInvoiceId: "provider-123",
      providerInvoiceNumber: "FV/1/2026",
      raw: { id: 123, number: "FV/1/2026" },
    })),
    createFullCorrection: vi.fn(async () => ({
      providerInvoiceId: "provider-correction-123",
      providerInvoiceNumber: "KOR/1/2026",
      raw: { id: 456, number: "KOR/1/2026" },
    })),
    downloadInvoicePdf: vi.fn(async () => ({ content: Buffer.from("%PDF-1.4"), contentType: "application/pdf" })),
    downloadKsefAttachment: vi.fn(async (_providerInvoiceId: string, kind: "gov" | "gov_upo") => ({
      content: Buffer.from(`<${kind}/>`),
      contentType: "application/xml",
    })),
    getInvoiceKsefStatus: vi.fn(async () => ({
      ksefStatus: "accepted" as const,
      ksefNumber: "KSEF-1",
      raw: { gov_status: "accepted", gov_id: "KSEF-1" },
    })),
  };
}

function portStub({
  claims = [],
  ksefTargets = [],
}: {
  claims?: typeof claim[];
  ksefTargets?: Array<{ invoiceId: string; providerKind?: string; providerInvoiceId: string; providerInvoiceNumber?: string | null; ksefStatus: string }>;
} = {}) {
  return {
    claimInvoiceIssues: vi.fn(async () => claims),
    preflightInvoiceIssuePayment: vi.fn(async () => ({
      ok: true,
      code: null as string | null,
      providerReadbackState: "unavailable" as const,
      paymentIntentId: "intent-1",
    })),
    blockInvoiceIssueCanonicalMapper: vi.fn(async () => undefined),
    markInvoiceIssueSucceeded: vi.fn(async () => undefined),
    markInvoiceIssueFailed: vi.fn(async () => undefined),
    claimInvoiceDeliveries: vi.fn(async () => []),
    markInvoiceDeliverySucceeded: vi.fn(async () => undefined),
    markInvoiceDeliveryFailed: vi.fn(async () => undefined),
    markInvoiceDeliveryUncertain: vi.fn(async () => undefined),
    listKsefPollTargets: vi.fn(async () => ksefTargets.map((target) => ({
      providerKind: "fakturownia",
      providerInvoiceNumber: "FV/1/2026",
      ...target,
    }))),
    recordKsefStatus: vi.fn(async () => undefined),
    recordProviderDocumentSync: vi.fn(async () => undefined),
    claimInvoiceCorrections: vi.fn(async () => []),
    markInvoiceCorrectionSucceeded: vi.fn(async () => undefined),
    markInvoiceCorrectionFailed: vi.fn(async () => undefined),
  };
}

function deliveryStub() {
  return { sendInvoiceDocument: vi.fn() };
}

function config(overrides: Partial<AccountingRuntimeConfig> = {}): AccountingRuntimeConfig {
  return {
    requestEnabled: false,
    createEnabled: false,
    b2cEmailEnabled: false,
    providerEmailEnabled: false,
    ksefPollEnabled: false,
    issueTrigger: "handoff",
    b2bEmailRequiresKsefAcceptance: true,
    ...overrides,
  };
}

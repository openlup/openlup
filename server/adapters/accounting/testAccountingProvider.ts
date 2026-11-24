import type {
  AccountingDocumentProviderInvoiceSnapshot,
  AccountingDocumentProviderPort,
} from "../../../src/domains/accounting/ports.js";

export interface TestAccountingProviderOptions {
  /** Number prefix for test invoices (e.g. `"TEST/INV"`). Defaults to `"TEST/FV"` for legacy test parity. */
  readonly invoicePrefix?: string;
  /** Number prefix for test corrections (e.g. `"TEST/CR"`). Defaults to `"TEST/KOR"` for legacy test parity. */
  readonly correctionPrefix?: string;
}

export function createTestAccountingProvider(
  options: TestAccountingProviderOptions = {},
): AccountingDocumentProviderPort {
  const invoicePrefix = options.invoicePrefix?.trim() || "TEST/FV";
  const correctionPrefix = options.correctionPrefix?.trim() || "TEST/KOR";
  return {
    async createInvoice(
      snapshot: AccountingDocumentProviderInvoiceSnapshot,
      _options: { recoveryLookupRequired: boolean },
    ) {
      const invoiceNumber = testInvoiceNumber(snapshot, invoicePrefix);
      return {
        providerInvoiceId: `test_inv_${stableRef(snapshot.orderRef)}`,
        providerInvoiceNumber: invoiceNumber,
        raw: {
          provider: "accounting_test",
          mode: "test",
          invoiceNumber,
          documentKind: snapshot.documentKind ?? "b2c_named",
        },
      };
    },
    async createFullCorrection() {
      throw new Error("accounting_correction_recovery_unsupported");
    },
    correctionRecovery: {
      createFullCorrection: (snapshot, correctionOptions) =>
        createTestCorrection(snapshot, correctionOptions, correctionPrefix),
    },
    async downloadInvoicePdf(providerInvoiceId: string) {
      if (!providerInvoiceId.startsWith("test_inv_")) throw new Error("test_invoice_provider_ref_invalid");
      return {
        content: Buffer.from("%PDF-1.4\nNON-FISCAL TEST DOCUMENT\n"),
        contentType: "application/pdf",
      };
    },
    async downloadKsefAttachment(providerInvoiceId: string, kind: "gov" | "gov_upo") {
      if (!providerInvoiceId.startsWith("test_inv_")) throw new Error("test_invoice_provider_ref_invalid");
      return {
        content: Buffer.from(`<test provider="accounting_test" kind="${kind}" />`),
        contentType: "application/xml",
      };
    },
    async downloadGovernmentAttachment(providerInvoiceId: string, kind: "gov" | "gov_upo") {
      if (!providerInvoiceId.startsWith("test_inv_")) throw new Error("test_invoice_provider_ref_invalid");
      return {
        content: Buffer.from(`<test provider="accounting_test" kind="${kind}" />`),
        contentType: "application/xml",
      };
    },
    async getInvoiceKsefStatus(_providerInvoiceId: string) {
      return {
        ksefStatus: "not_submitted" as const,
        ksefNumber: null,
        raw: { provider: "accounting_test", mode: "test" },
      };
    },
    async getGovernmentSubmissionStatus(_providerInvoiceId: string) {
      return {
        status: "not_submitted" as const,
        number: null,
        raw: { provider: "accounting_test", mode: "test" },
      };
    },
  };
}

function testInvoiceNumber(snapshot: AccountingDocumentProviderInvoiceSnapshot, prefix: string): string {
  const year = (snapshot.issueDate || new Date().toISOString()).slice(0, 4);
  return `${prefix}/${year}/${stableRef(snapshot.orderRef)}`;
}

function stableRef(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "invoice";
}

async function createTestCorrection(
  _snapshot: AccountingDocumentProviderInvoiceSnapshot,
  options: { correctedProviderInvoiceId: string; correctionReason: string; correctionRef: string; recoveryLookupRequired: boolean },
  prefix: string,
) {
  const invoiceNumber = `${prefix}/${stableRef(options.correctionRef)}`;
  return {
    providerInvoiceId: `test_inv_correction_${stableRef(options.correctionRef)}`,
    providerInvoiceNumber: invoiceNumber,
    raw: { provider: "accounting_test", mode: "test", invoiceNumber, correction: true },
  };
}

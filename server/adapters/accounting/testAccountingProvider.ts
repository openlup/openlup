import type {
  AccountingDocumentProviderInvoiceSnapshot,
  AccountingDocumentProviderPort,
} from "../../../src/domains/accounting/ports.js";

export function createTestAccountingProvider(): AccountingDocumentProviderPort {
  return {
    async createInvoice(
      snapshot: AccountingDocumentProviderInvoiceSnapshot,
      _options: { recoveryLookupRequired: boolean },
    ) {
      const invoiceNumber = testInvoiceNumber(snapshot);
      return {
        providerInvoiceId: `test_inv_${stableRef(snapshot.orderRef)}`,
        providerInvoiceNumber: invoiceNumber,
        raw: {
          provider: "fakturownia_test",
          mode: "test",
          invoiceNumber,
          documentKind: snapshot.documentKind ?? "b2c_named",
        },
      };
    },
    async createFullCorrection(
      snapshot: AccountingDocumentProviderInvoiceSnapshot,
      _options: { correctedProviderInvoiceId: string; correctionReason: string },
    ) {
      const invoiceNumber = `TEST/KOR/${stableRef(snapshot.orderRef)}`;
      return {
        providerInvoiceId: `test_inv_correction_${stableRef(snapshot.orderRef)}`,
        providerInvoiceNumber: invoiceNumber,
        raw: { provider: "fakturownia_test", mode: "test", invoiceNumber, correction: true },
      };
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
        content: Buffer.from(`<test provider="fakturownia_test" kind="${kind}" />`),
        contentType: "application/xml",
      };
    },
    async downloadGovernmentAttachment(providerInvoiceId: string, kind: "gov" | "gov_upo") {
      if (!providerInvoiceId.startsWith("test_inv_")) throw new Error("test_invoice_provider_ref_invalid");
      return {
        content: Buffer.from(`<test provider="fakturownia_test" kind="${kind}" />`),
        contentType: "application/xml",
      };
    },
    async getInvoiceKsefStatus(_providerInvoiceId: string) {
      return {
        ksefStatus: "not_submitted" as const,
        ksefNumber: null,
        raw: { provider: "fakturownia_test", mode: "test" },
      };
    },
  };
}

function testInvoiceNumber(snapshot: AccountingDocumentProviderInvoiceSnapshot): string {
  const year = (snapshot.issueDate || new Date().toISOString()).slice(0, 4);
  return `TEST/FV/${year}/${stableRef(snapshot.orderRef)}`;
}

function stableRef(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "invoice";
}

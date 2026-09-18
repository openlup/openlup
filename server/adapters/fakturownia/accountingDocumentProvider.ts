import type {
  AccountingDocumentProviderInvoiceSnapshot,
  AccountingDocumentProviderPort,
} from "../../../src/domains/accounting/ports.js";
import {
  buildFakturowniaCreateInvoiceRequest,
  buildFakturowniaCorrectionRequest,
  type FakturowniaInvoiceSnapshot,
} from "../../infra/fakturownia/invoiceMapper.js";
import type { FakturowniaClient } from "../../infra/fakturownia/client.js";

export function createFakturowniaAccountingDocumentProvider(client: FakturowniaClient): AccountingDocumentProviderPort {
  return {
    async createInvoice(
      snapshot: AccountingDocumentProviderInvoiceSnapshot,
      options: { recoveryLookupRequired: boolean },
    ) {
      if (options.recoveryLookupRequired) {
        const existing = await client.findInvoiceByOid(snapshot.orderRef);
        if (existing) return existing;
      }
      return client.createInvoice(buildFakturowniaCreateInvoiceRequest(mapSnapshot(snapshot)));
    },
    async createFullCorrection(
      snapshot: AccountingDocumentProviderInvoiceSnapshot,
      options: { correctionReason: string; correctedProviderInvoiceId: string },
    ) {
      return client.createCorrection(buildFakturowniaCorrectionRequest({
        providerInvoiceId: options.correctedProviderInvoiceId,
        orderRef: snapshot.orderRef,
        reason: options.correctionReason,
        documentKind: snapshot.documentKind === "b2b_vat" ? "b2b_vat" : "b2c_named",
        ksefRequired: snapshot.governmentClearanceRequired === true,
        buyer: snapshot.buyer,
        lines: snapshot.lines.map((line) => ({
          name: line.name,
          quantityBefore: line.quantity,
          quantityAfter: 0,
          quantityUnit: line.quantityUnit,
          totalGrossBeforeMinor: line.totalGrossMinor ?? (line.unitGrossMinor ?? line.unitNetMinor) * line.quantity,
          totalGrossAfterMinor: 0,
          vatRate: line.vatRate,
        })),
      }));
    },
    async downloadInvoicePdf(providerInvoiceId: string) {
      return client.downloadInvoicePdf(providerInvoiceId);
    },
    async downloadGovernmentAttachment(providerInvoiceId: string, kind: "gov" | "gov_upo") {
      return client.downloadKsefAttachment(providerInvoiceId, kind);
    },
    async downloadKsefAttachment(providerInvoiceId: string, kind: "gov" | "gov_upo") {
      return client.downloadKsefAttachment(providerInvoiceId, kind);
    },
    async getGovernmentSubmissionStatus(providerInvoiceId: string) {
      const status = await client.getInvoiceKsefStatus(providerInvoiceId);
      return {
        status: status.ksefStatus,
        number: status.ksefNumber,
        raw: status.raw,
      };
    },
    async getInvoiceKsefStatus(providerInvoiceId: string) {
      return client.getInvoiceKsefStatus(providerInvoiceId);
    },
  };
}

// The one place the platform-neutral clearance flag becomes this provider's own
// national name. The E2-F4 rename stops here on purpose: inside an adapter the
// field really is about that provider's clearance system, and generalising a
// vendor's vocabulary would only hide which system a document is bound for.
function mapSnapshot(snapshot: AccountingDocumentProviderInvoiceSnapshot): FakturowniaInvoiceSnapshot {
  return {
    ...snapshot,
    ksefRequired: snapshot.governmentClearanceRequired === true,
  };
}

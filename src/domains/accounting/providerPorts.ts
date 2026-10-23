export interface AccountingDocumentProviderInvoiceSnapshot {
  orderRef: string;
  issueDate: string;
  sellDate?: string;
  currency: string;
  seller?: {
    name: string;
    street: string;
    postalCode: string;
    city: string;
    taxId: string;
    krs?: string | null;
    bankAccount?: string | null;
    departmentId?: string | null;
  };
  buyer: {
    name: string;
    email: string | null;
    taxId: string | null;
    companyName?: string | null;
    address?: {
      line1: string | null;
      postalCode: string | null;
      city: string | null;
      country: string | null;
    };
  };
  documentKind?: "b2b_vat" | "b2c_named";
  /** A tax authority must clear this document; the provider adapter names its own system. */
  governmentClearanceRequired?: boolean;
  payment?: {
    provider: string | null;
    providerPaymentId: string | null;
    paymentCompletedAt: string;
  };
  lines: Array<{
    name: string;
    quantity: number;
    /**
     * Optional host-supplied unit printed next to the quantity. Canonical
     * positions may carry it; legacy snapshots may omit it. An adapter owns
     * any locale-specific default when absent.
     */
    quantityUnit?: string;
    unitNetMinor: number;
    unitGrossMinor?: number;
    totalNetMinor?: number;
    totalGrossMinor?: number;
    vatRate: string;
  }>;
  /**
   * Order total actually charged to the customer, in minor units. When set,
   * the document provider must refuse to build a document whose positions do
   * not sum exactly to this amount.
   */
  chargedTotalGrossMinor?: number;
}

export interface AccountingDocumentProviderPort {
  createInvoice(
    snapshot: AccountingDocumentProviderInvoiceSnapshot,
    options: {
      recoveryLookupRequired: boolean;
    },
  ): Promise<AccountingDocumentProviderResult>;
  /** Explicit conforming bridge; the legacy vendor method alone is not selected.
   * Implements stable identity, exact recovery/absence and parent validation. */
  correctionRecovery?: {
    createFullCorrection(
      snapshot: AccountingDocumentProviderInvoiceSnapshot,
      options: { correctionReason: string; correctedProviderInvoiceId: string; correctionRef: string; recoveryLookupRequired: boolean },
    ): Promise<AccountingDocumentProviderResult>;
  };
  createFullCorrection(
    snapshot: AccountingDocumentProviderInvoiceSnapshot,
    options: {
      correctionReason: string;
      correctedProviderInvoiceId: string;
    },
  ): Promise<AccountingDocumentProviderResult>;
  downloadInvoicePdf(providerInvoiceId: string): Promise<AccountingDocumentProviderDownload>;
  downloadGovernmentAttachment?(
    providerInvoiceId: string,
    kind: "gov" | "gov_upo",
  ): Promise<AccountingDocumentProviderDownload>;
  downloadKsefAttachment?(
    providerInvoiceId: string,
    kind: "gov" | "gov_upo",
  ): Promise<AccountingDocumentProviderDownload>;
  getGovernmentSubmissionStatus?(providerInvoiceId: string): Promise<{
    status: "pending" | "accepted" | "rejected" | "not_submitted";
    number: string | null;
    raw: Record<string, unknown>;
  }>;
  getInvoiceKsefStatus?(providerInvoiceId: string): Promise<{
    ksefStatus: "pending" | "accepted" | "rejected" | "not_submitted";
    ksefNumber: string | null;
    raw: Record<string, unknown>;
  }>;
}

type AccountingDocumentProviderResult = {
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  raw: Record<string, unknown>;
};

type AccountingDocumentProviderDownload = {
  content: Uint8Array;
  contentType: string;
};

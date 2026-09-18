export const ACCOUNTING_INVOICE_DOCUMENT_TEMPLATE_SLUG = "commerce-invoice-document";
export const ACCOUNTING_INVOICE_DELIVERY_SOURCE = "accounting-invoice-delivery";

export interface AccountingInvoiceEmailDeliveryInput {
  outboxId: string;
  invoiceId: string;
  orderId: string;
  clientId: string | null;
  orderRef: string;
  invoiceRef: string;
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  recipientEmail: string;
  deliverySource: string | null;
  idempotencyKey: string;
  document: {
    filename: string;
    content: Uint8Array;
  };
}

export interface AccountingInvoiceDeliveryTarget {
  outboxId: string;
  attemptCount: number;
  providerKind: string;
  invoiceId: string;
  orderId: string;
  clientId: string | null;
  orderRef: string;
  invoiceRef: string;
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  recipientEmail: string;
  deliverySource: string | null;
  idempotencyKey: string;
}

export type AccountingInvoiceEmailDeliveryResult =
  | {
      status: "sent";
      providerMessageId: string;
    }
  | {
      status: "uncertain";
      error: Record<string, unknown>;
    };

/**
 * Delivers an already-created fiscal document; it never creates or alters it.
 * Implementations must return `uncertain`, not throw, after entering transport.
 */
export interface AccountingInvoiceEmailDeliveryPort {
  sendInvoiceDocument(
    input: AccountingInvoiceEmailDeliveryInput,
  ): Promise<AccountingInvoiceEmailDeliveryResult>;
}

export interface AccountingInvoiceDeliveryRuntimePort {
  claimInvoiceDeliveries(
    limit: number,
    options?: { requireKsefAcceptanceForB2b?: boolean; orderId?: string | null },
  ): Promise<AccountingInvoiceDeliveryTarget[]>;
  markInvoiceDeliverySucceeded(input: {
    outboxId: string;
    claimAttemptCount: number;
    providerInvoiceId: string;
    providerMessageId: string;
  }): Promise<void>;
  markInvoiceDeliveryFailed(input: {
    outboxId: string;
    claimAttemptCount: number;
    providerInvoiceId: string;
    error: Record<string, unknown>;
    retrySeconds: number;
  }): Promise<void>;
  markInvoiceDeliveryUncertain(input: {
    outboxId: string;
    claimAttemptCount: number;
    providerInvoiceId: string;
    providerMessageId: string | null;
    error: Record<string, unknown>;
  }): Promise<void>;
}

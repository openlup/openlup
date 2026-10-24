import type {
  AccountingDocumentProviderPort,
  AccountingInvoiceEmailDeliveryPort,
  AccountingInvoiceRuntimePort,
} from "../../../src/domains/accounting/ports.js";
import type { AccountingJobResult } from "./accountingJobService.js";
import { sanitizeAccountingError } from "./accountingProviderSnapshot.js";
import type { AccountingRuntimeConfig } from "./accountingRuntimeConfig.js";

import { runInvoiceDeliveryJob, assertInvoicePdf as assertPdf, invoicePdfFilename as pdfFilename } from "@openlup/platform/invoicing";

export async function runAccountingInvoiceDeliveryJob({
  port,
  provider,
  deliveryPort,
  expectedProviderKind,
  config,
  limit = 25,
  orderId = null,
}: {
  port: AccountingInvoiceRuntimePort;
  provider: AccountingDocumentProviderPort | null;
  deliveryPort: AccountingInvoiceEmailDeliveryPort | null;
  expectedProviderKind: string;
  config: AccountingRuntimeConfig;
  limit?: number;
  orderId?: string | null;
}): Promise<AccountingJobResult> {
  return runInvoiceDeliveryJob({
    enabled: config.providerEmailEnabled,
    providerEnabled: Boolean(provider),
    deliveryEnabled: Boolean(deliveryPort),
    claim: () => port.claimInvoiceDeliveries(limit, {
      requireKsefAcceptanceForB2b: config.b2bEmailRequiresKsefAcceptance, orderId,
    }),
    attemptCount: claim => claim.attemptCount,
    validate: claim => assertDeliveryClaim(claim, expectedProviderKind),
    download: async claim => {
      const pdf = await provider!.downloadInvoicePdf(claim.providerInvoiceId);
      assertInvoicePdf(pdf);
      return pdf;
    },
    filename: claim => invoicePdfFilename(claim.providerInvoiceNumber ?? claim.invoiceRef),
    send: async (claim, document) => {
      const result = await deliveryPort!.sendInvoiceDocument({ ...claim, document: { filename: document.filename, content: document.content } });
      return result.status === "uncertain"
        ? { kind: "uncertain" as const, code: "uncertain_delivery" as const, receiptRef: null, error: result.error }
        : { kind: "provider_accepted" as const, receiptRef: result.providerMessageId };
    },
    failedBeforeSend: (claim, error, retrySeconds) => port.markInvoiceDeliveryFailed({
      outboxId: claim.outboxId, claimAttemptCount: claim.attemptCount,
      providerInvoiceId: claim.providerInvoiceId, error: sanitizeAccountingError(error), retrySeconds,
    }),
    // This legacy M04 adapter returns sent/uncertain only. Native bindings must
    // supply a durable stop/backoff callback for their non-retryable refusals.
    terminalFailure: async () => { throw new Error("accounting_delivery_result_unsupported"); },
    uncertain: (claim, result) => port.markInvoiceDeliveryUncertain({
      outboxId: claim.outboxId, claimAttemptCount: claim.attemptCount,
      providerInvoiceId: claim.providerInvoiceId, providerMessageId: null, error: result.error,
    }),
    accepted: (claim, result) => port.markInvoiceDeliverySucceeded({
      outboxId: claim.outboxId, claimAttemptCount: claim.attemptCount,
      providerInvoiceId: claim.providerInvoiceId, providerMessageId: result.receiptRef,
    }),
    finalizeUncertain: (claim, receiptRef) => port.markInvoiceDeliveryUncertain({
      outboxId: claim.outboxId, claimAttemptCount: claim.attemptCount,
      providerInvoiceId: claim.providerInvoiceId, providerMessageId: receiptRef,
      error: { code: "invoice_email_local_finalize_uncertain" },
    }),
  });
}

function assertDeliveryClaim(claim: {
  outboxId: string;
  providerKind: string;
  providerInvoiceId: string;
  recipientEmail: string;
  idempotencyKey: string;
}, expectedProviderKind: string): void {
  if (claim.providerKind !== expectedProviderKind) {
    throw new Error("accounting_invoice_delivery_provider_kind_mismatch");
  }
  const expectedKey = `accounting-invoice-delivery:${claim.outboxId}:${claim.providerInvoiceId}`;
  if (claim.idempotencyKey !== expectedKey) {
    throw new Error("accounting_invoice_delivery_idempotency_key_invalid");
  }
  if (typeof claim.recipientEmail !== "string" || claim.recipientEmail.trim() === "") {
    throw new Error("accounting_invoice_delivery_recipient_missing");
  }
}


/** Preserve existing host diagnostic bytes and locale caption. */
export function assertInvoicePdf(pdf: Parameters<typeof assertPdf>[0]): void {
  try { assertPdf(pdf); } catch (error) {
    if (error instanceof Error && error.message.startsWith("invoice_pdf_")) throw new Error(`accounting_${error.message}`);
    throw error;
  }
}
export function invoicePdfFilename(reference: string): string { return pdfFilename(reference, "faktura"); }

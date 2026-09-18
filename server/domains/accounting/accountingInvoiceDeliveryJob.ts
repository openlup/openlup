import type {
  AccountingDocumentProviderPort,
  AccountingInvoiceEmailDeliveryPort,
  AccountingInvoiceRuntimePort,
} from "../../../src/domains/accounting/ports.js";
import type { AccountingJobResult } from "./accountingJobService.js";
import { sanitizeAccountingError } from "./accountingProviderSnapshot.js";
import type { AccountingRuntimeConfig } from "./accountingRuntimeConfig.js";

const MAX_INVOICE_PDF_BYTES = 25 * 1024 * 1024;

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
  if (!config.providerEmailEnabled) return skipped("provider_email_disabled");
  if (!provider) return skipped("provider_disabled");
  if (!deliveryPort) return skipped("email_delivery_provider_disabled");

  const claims = await port.claimInvoiceDeliveries(limit, {
    requireKsefAcceptanceForB2b: config.b2bEmailRequiresKsefAcceptance,
    orderId,
  });
  let updated = 0;
  let failures = 0;

  for (const claim of claims) {
    let deliveryResult;
    try {
      assertDeliveryClaim(claim, expectedProviderKind);
      const pdf = await provider.downloadInvoicePdf(claim.providerInvoiceId);
      assertInvoicePdf(pdf);
      deliveryResult = await deliveryPort.sendInvoiceDocument({
        ...claim,
        document: {
          filename: invoicePdfFilename(claim.providerInvoiceNumber ?? claim.invoiceRef),
          content: pdf.content,
        },
      });
    } catch (error) {
      failures += 1;
      await port.markInvoiceDeliveryFailed({
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerInvoiceId: claim.providerInvoiceId,
        error: sanitizeAccountingError(error),
        retrySeconds: retrySeconds(claim.attemptCount),
      });
      continue;
    }

    if (deliveryResult.status === "uncertain") {
      failures += 1;
      await port.markInvoiceDeliveryUncertain({
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerInvoiceId: claim.providerInvoiceId,
        providerMessageId: null,
        error: deliveryResult.error,
      });
      continue;
    }

    try {
      await port.markInvoiceDeliverySucceeded({
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerInvoiceId: claim.providerInvoiceId,
        providerMessageId: deliveryResult.providerMessageId,
      });
      updated += 1;
    } catch {
      failures += 1;
      // Provider acceptance followed by a missing local acknowledgement must
      // never become a retryable failure. The fenced uncertain transition is
      // safe even when the success transaction committed but its response was lost.
      await port.markInvoiceDeliveryUncertain({
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerInvoiceId: claim.providerInvoiceId,
        providerMessageId: deliveryResult.providerMessageId,
        error: { code: "invoice_email_local_finalize_uncertain" },
      }).catch(() => undefined);
    }
  }

  return { ok: failures === 0, checked: claims.length, updated, skipped: false, failures };
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

export function assertInvoicePdf(pdf: { content: Uint8Array; contentType: string }): void {
  const contentType = pdf.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") throw new Error("accounting_invoice_pdf_content_type_invalid");
  if (!pdf.content || pdf.content.byteLength === 0) throw new Error("accounting_invoice_pdf_empty");
  if (pdf.content.byteLength > MAX_INVOICE_PDF_BYTES) throw new Error("accounting_invoice_pdf_too_large");
  if (Buffer.from(pdf.content.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("accounting_invoice_pdf_signature_invalid");
  }
}

export function invoicePdfFilename(reference: string): string {
  const safeReference = reference
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${safeReference || "faktura"}.pdf`;
}

function retrySeconds(attemptCount: number): number {
  return Math.min(3600, 300 * Math.max(1, attemptCount));
}

function skipped(reason: string): AccountingJobResult {
  return { ok: true, checked: 0, updated: 0, skipped: true, reason, failures: 0 };
}

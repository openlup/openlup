import type { CustomerDocumentDeliveryStatus } from "../../../src/domains/customers/accountV2Contracts.js";

export type CustomerInvoiceDocumentStatusInput = {
  blockedReason: string | null;
  status: string | null;
  documentKind: string | null;
  ksefStatus: string | null;
  emailStatus: string | null;
  outboxStatus: string | null;
  downloadAvailable: boolean;
};

export function deriveCustomerDocumentDeliveryStatus(
  input: CustomerInvoiceDocumentStatusInput,
): CustomerDocumentDeliveryStatus {
  const invoiceStatus = normalize(input.status);
  const ksefStatus = normalize(input.ksefStatus);
  const emailStatus = normalize(input.emailStatus);
  const outboxStatus = normalize(input.outboxStatus);

  if (
    input.blockedReason ||
    ["rejected", "voided", "cancelled"].includes(invoiceStatus) ||
    ksefStatus === "rejected"
  ) {
    return "requires_correction";
  }

  if (emailStatus === "failed" || ["failed", "uncertain", "cancelled"].includes(outboxStatus)) {
    return "delivery_failed";
  }

  if (input.documentKind === "b2b_vat" && !["accepted", "not_required"].includes(ksefStatus)) {
    return "ksef_pending";
  }

  if (["sent", "provider_accepted"].includes(emailStatus) || outboxStatus === "succeeded") {
    return "email_provider_accepted";
  }
  if (emailStatus === "pending" || ["pending", "processing"].includes(outboxStatus)) return "email_pending";
  if (input.downloadAvailable) return "pdf_ready";
  return "not_ready";
}

function normalize(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

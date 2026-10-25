import { createInvoiceReadModel } from "../invoicing/index.js";
import type { InvoiceHostPorts } from "../invoicing/contracts/index.js";
import type { CustomerDocumentDeliveryStatus } from "./contracts/invoice.js";

export type InvoiceOwnerAccessPort = InvoiceHostPorts["accountHistory"];
export type InvoiceArtifactDownloadPort = Pick<InvoiceHostPorts["artifacts"], "download">;

export interface InvoiceAccessOptions {
  accountHistory?: InvoiceOwnerAccessPort;
  artifacts?: InvoiceArtifactDownloadPort
}

export function createInvoiceAccess(options: InvoiceAccessOptions = {}) {
  const accountHistory = options.accountHistory;
  const owner = createInvoiceReadModel({
    ...options,
    accountHistory: accountHistory && {
      read: input => accountHistory.read(input),
      async resolveDownload(input) {
        const history = await accountHistory.read({ accountRef: input.accountRef, orderId: input.orderId });
        if (history.kind !== "found") return history;
        if (history.accountRef !== input.accountRef || history.orderId !== input.orderId
          || !history.documents.some(document => document.documentRef === input.documentRef)) return { kind: "denied" };
        return accountHistory.resolveDownload(input);
      }
    }
  });
  return { history: owner.history, download: owner.download };
}

export function downloadOwnedInvoicePdf<Ticket, Pdf extends { content: Uint8Array; contentType: string }>(input: {
  resolve(): Promise<Ticket | null>;
  download(ticket: Ticket): Promise<Pdf>
}) {
  return createInvoiceReadModel().ownedPdf(input);
}

export interface CustomerInvoiceDocumentStatusInput {
  blockedReason: string | null;
  status: string | null;
  documentKind: string | null;
  ksefStatus: string | null;
  emailStatus: string | null;
  outboxStatus: string | null;
  downloadAvailable: boolean
}

export function deriveCustomerDocumentDeliveryStatus(input: CustomerInvoiceDocumentStatusInput): CustomerDocumentDeliveryStatus {
  const status = normalized(input.status),
    clearance = normalized(input.ksefStatus),
    email = normalized(input.emailStatus),
    outbox = normalized(input.outboxStatus);
  if (input.blockedReason || ["rejected", "voided", "cancelled"].includes(status) || clearance === "rejected") return "requires_correction";
  if (email === "failed" || ["failed", "uncertain", "cancelled"].includes(outbox)) return "delivery_failed";
  if (input.documentKind === "b2b_vat" && !["accepted", "not_required"].includes(clearance)) return "ksef_pending";
  if (["sent", "provider_accepted"].includes(email) || outbox === "succeeded") return "email_provider_accepted";
  if (email === "pending" || ["pending", "processing"].includes(outbox)) return "email_pending";
  return input.downloadAvailable ? "pdf_ready" : "not_ready";
}

function normalized(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

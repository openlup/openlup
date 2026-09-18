import { createHash } from "node:crypto";
import type {
  AccountingInvoiceRuntimePort,
  AccountingKsefPollTarget,
} from "../../../src/domains/accounting/ports.js";

export type AccountingDocumentSyncProvider = {
  downloadInvoicePdf(providerInvoiceId: string): Promise<{ content: Uint8Array; contentType: string }>;
  downloadKsefAttachment(
    providerInvoiceId: string,
    kind: "gov" | "gov_upo",
  ): Promise<{ content: Uint8Array; contentType: string }>;
};

export async function syncAcceptedKsefDocuments({
  port,
  provider,
  target,
  status,
}: {
  port: AccountingInvoiceRuntimePort;
  provider: AccountingDocumentSyncProvider;
  target: AccountingKsefPollTarget;
  status: {
    ksefStatus: "accepted";
    ksefNumber: string | null;
    raw: Record<string, unknown>;
  };
}): Promise<void> {
  const [pdf, xml, upo] = await Promise.all([
    provider.downloadInvoicePdf(target.providerInvoiceId),
    provider.downloadKsefAttachment(target.providerInvoiceId, "gov"),
    provider.downloadKsefAttachment(target.providerInvoiceId, "gov_upo"),
  ]);
  const refs = {
    providerPdfRef: providerDocumentRef(target.providerKind, target.providerInvoiceId, "pdf"),
    providerXmlRef: providerDocumentRef(target.providerKind, target.providerInvoiceId, "gov"),
    providerUpoRef: providerDocumentRef(target.providerKind, target.providerInvoiceId, "gov_upo"),
  };
  const payload = {
    provider: target.providerKind,
    providerInvoiceId: target.providerInvoiceId,
    ksefStatus: status.ksefStatus,
    ksefNumber: status.ksefNumber,
    documents: {
      pdf: documentMetadata(pdf),
      xml: documentMetadata(xml),
      upo: documentMetadata(upo),
    },
    providerStatus: status.raw,
  };
  await port.recordProviderDocumentSync({
    invoiceId: target.invoiceId,
    providerKind: target.providerKind,
    providerEventId: `${target.providerInvoiceId}:ksef-documents:${status.ksefNumber ?? "accepted"}`,
    eventType: "ksef.accepted",
    providerInvoiceId: target.providerInvoiceId,
    providerInvoiceNumber: target.providerInvoiceNumber,
    ksefNumber: status.ksefNumber,
    ksefStatus: status.ksefStatus,
    ...refs,
    observedAt: new Date().toISOString(),
    payloadHash: hashPayload(payload),
    payload,
  });
}

function providerDocumentRef(providerKind: string, providerInvoiceId: string, documentKind: string): string {
  return `${providerKind}:invoice:${providerInvoiceId}:${documentKind}`;
}

function documentMetadata(document: { content: Uint8Array; contentType: string }): Record<string, unknown> {
  return {
    contentType: document.contentType,
    bytes: document.content.byteLength,
  };
}

function hashPayload(payload: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

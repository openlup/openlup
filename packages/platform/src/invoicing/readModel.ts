import type { InvoiceHostPorts, InvoiceIdentity, InvoiceProviderPort, InvoiceStorePort } from "./contracts/index.js";
import { assertInvoicePdf } from "./artifacts.js";
import { opaqueReference, readInvoiceReadback } from "./readback.js";

const unsupported = () => ({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const);
const unknown = () => ({ kind: "unknown", code: "unknown" } as const);

/** Read-only orchestration. Auth, owner resolution and queries stay in host
 * callbacks. Safe native account projections preserve negative correction totals,
 * currency and parent identity without exposing provider payloads or URLs.
 * @consumer Customer download/history and authorized operator host facades.
 */
export function createInvoiceReadModel(ports: {
  accountHistory?: InvoiceHostPorts["accountHistory"];
  artifacts?: Pick<InvoiceHostPorts["artifacts"], "download">;
  provider?: Pick<InvoiceProviderPort, "read">;
  duties?: Pick<InvoiceStorePort, "readDuties">;
} = {}) {
  return {
    async history(input: Parameters<InvoiceHostPorts["accountHistory"]["read"]>[0]): ReturnType<InvoiceHostPorts["accountHistory"]["read"]> {
      if (!ports.accountHistory) return unsupported();
      try {
        const result = await ports.accountHistory.read(input);
        if (result.kind !== "found") return result.kind === "unsupported" ? unsupported() : result.kind === "denied" ? { kind: "denied" } : unknown();
        if (result.accountRef !== input.accountRef || result.orderId !== input.orderId) return { kind: "denied" };
        return {
          kind: "found", accountRef: input.accountRef, orderId: input.orderId,
          documents: result.documents.map(document => ({
            documentRef: document.documentRef, invoiceRef: document.invoiceRef,
            parentDocumentRef: document.parentDocumentRef, role: document.role,
            status: document.status, issuedAt: document.issuedAt,
            clearance: document.clearance ? { state: document.clearance.state, reference: document.clearance.reference } : null,
            documentKind: document.documentKind, artifact: document.artifact,
            providerDocumentNumber: document.providerDocumentNumber,
            totalGrossMinor: document.totalGrossMinor, currency: document.currency,
            emailState: document.emailState, isCurrent: document.isCurrent,
            createdAt: document.createdAt, downloadAvailable: document.downloadAvailable,
          })),
        };
      } catch { return unknown(); }
    },
    async download(input: Parameters<InvoiceHostPorts["accountHistory"]["resolveDownload"]>[0]) {
      if (!ports.accountHistory || !ports.artifacts) return unsupported();
      try {
        const ticket = await ports.accountHistory.resolveDownload(input);
        if (ticket.kind !== "authorized") return ticket.kind === "unsupported" ? unsupported() : ticket.kind === "denied" ? { kind: "denied" as const } : unknown();
        if (ticket.identity.documentRef !== input.documentRef || !opaqueReference(ticket.artifactRef)) return { kind: "denied" as const };
        const pdf = await ports.artifacts.download({ identity: ticket.identity, artifactRef: ticket.artifactRef });
        if (pdf.kind !== "downloaded") return pdf.kind === "unsupported" ? unsupported() : unknown();
        assertInvoicePdf(pdf);
        return { kind: "downloaded" as const, content: pdf.content, contentType: pdf.contentType, fileName: ticket.fileName, parentDocumentRef: ticket.parentDocumentRef };
      } catch { return unknown(); }
    },
    async readback(identity: InvoiceIdentity) {
      return ports.provider ? readInvoiceReadback(ports.provider, identity) : unsupported();
    },
    /** Operator-only duty readback. The host must authorize the caller before
     * invoking it, as operator() does; this method has no auth hook of its own. */
    async readDuties(orderId: string) {
      if (!ports.duties) return unsupported();
      try { return await ports.duties.readDuties(orderId); } catch { return unknown(); }
    },
    /** The authorize callback runs before the query. HTTP status mapping stays host-owned. */
    async operator<Summary>(input: { authorize(): Promise<boolean>; read(): Promise<Summary> }) {
      if (!await input.authorize()) return { kind: "denied" as const };
      return { kind: "found" as const, value: await input.read() };
    },
    /** Legacy ticket resolver verifies the real order owner before any PDF I/O. */
    async ownedPdf<Ticket, Pdf extends { content: Uint8Array; contentType: string }>(input: {
      resolve(): Promise<Ticket | null>;
      download(ticket: Ticket): Promise<Pdf>;
    }) {
      const ticket = await input.resolve();
      if (!ticket) return { kind: "denied" as const };
      const pdf = await input.download(ticket);
      assertInvoicePdf(pdf);
      return { kind: "downloaded" as const, ticket, pdf };
    },
  };
}

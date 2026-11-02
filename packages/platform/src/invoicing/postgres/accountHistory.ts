import type { InvoiceDocumentIdentity, InvoiceHostPorts } from "../contracts/index.js";
import { invoicePdfFilename } from "../artifacts.js";
import { artifactRef, capturedReceipt, receiptKey, unknown, type InvoicePostgresExecutor } from "./captured.js";

type History = Extract<Awaited<ReturnType<InvoiceHostPorts["accountHistory"]["read"]>>, { kind: "found" }>;
type Document = History["documents"][number];
type NativeDocument = { id: string; invoice_ref: string; status: string; parent_id: string | null;
  issued_at: string | null; created_at: string; total: string; currency: string; document_kind: string | null;
  submission_state: string | null; submission_reference: string | null; provider: string | null;
  provider_reference: string | null; provider_number: string | null; order_ref: string; receipt: unknown; delivery_status: string | null; delivery_state: string | null };

/** accountRef is the authenticated principal UUID, never a request-body claim or
 * a client UUID. Ownership joins clients.principal_id to commerce_orders.client_id
 * in the same statement as document selection. Host authentication remains required.
 * The safe history includes pending/voided documents; only eligible documents
 * with a matching captured artifact can resolve a download ticket.
 */
export function createPostgresInvoiceAccountHistory(db: InvoicePostgresExecutor): InvoiceHostPorts["accountHistory"] {
  async function owned(input: { accountRef: string; orderId: string }): Promise<NativeDocument[] | null> {
    const result = await db.query(`SELECT coalesce((SELECT jsonb_agg(x ORDER BY x.created_at,x.id) FROM (
      SELECT a.id,a.document_ref AS invoice_ref,a.status,a.correction_of_document_id AS parent_id,
        a.issued_at::text,a.created_at::text,a.total_gross_minor::text AS total,
        coalesce(f.facts->>'currency',a.metadata->>'currency',o.currency_code) AS currency,f.facts->>'documentKind' AS document_kind,
        a.submission_state,a.submission_reference,d.provider,a.provider_reference,d.last_result->>'number' AS provider_number,
        coalesce(f.facts->'refs'->>'orderRef',o.id::text) AS order_ref,
        observation.observation AS receipt,delivery.status AS delivery_status,r.state AS delivery_state
      FROM public.accounting_documents a
      LEFT JOIN public.invoicing_duties d ON d.document_id=a.id
      LEFT JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
      LEFT JOIN public.invoicing_document_observations observation ON observation.document_id=a.id
        AND observation.observation->>'format'='openlup.captured-invoice.v1'
        AND observation.observation->'identity'->>'providerCreateIdentity'='invoicing:'||d.id::text
      LEFT JOIN public.accounting_document_deliveries delivery ON delivery.document_id=a.id AND delivery.channel='email'
      LEFT JOIN public.invoicing_delivery_receipts r ON r.delivery_id=delivery.id
      WHERE a.order_id=o.id
    ) x),'[]'::jsonb) AS documents
    FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
    WHERE o.id=$2::uuid AND c.principal_id=$1::uuid`, [input.accountRef, input.orderId]);
    if (!result.rows.length) return null;
    return result.rows[0]!.documents as NativeDocument[];
  }
  function project(rows: NativeDocument[]): Document[] {
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("native_invoice_history_ambiguous");
    const current = [...rows].reverse().find(row => !row.parent_id && ["issued", "accepted"].includes(row.status) && row.provider_reference);
    return rows.map(row => {
      const total = Number(row.total);
      if (!Number.isSafeInteger(total) || !/^[A-Z]{3}$/.test(row.currency)) throw new Error("native_invoice_history_invalid");
      const receipt = matchingReceipt(row);
      const clearanceStates = ["not_submitted", "pending", "accepted", "rejected", "not_required", "unsupported"] as const;
      const state = clearanceStates.find(state => state === row.submission_state);
      if (row.submission_state !== null && !state) throw new Error("native_invoice_clearance_invalid");
      return { documentRef: row.id, invoiceRef: row.invoice_ref, parentDocumentRef: row.parent_id,
        role: row.parent_id ? "correction" : "original", status: row.status, issuedAt: row.issued_at,
        clearance: state ? { state, reference: row.submission_reference } : null, documentKind: row.document_kind,
        artifact: row.parent_id ? "correction" : "invoice", providerDocumentNumber: receipt?.providerDocumentNumber ?? row.provider_number,
        totalGrossMinor: total, currency: row.currency,
        emailState: row.delivery_state === "sent" || row.delivery_status === "succeeded" ? "provider_accepted"
          : ["failed", "uncertain"].includes(row.delivery_state ?? "") || ["failed", "abandoned"].includes(row.delivery_status ?? "") ? "failed"
            : ["pending", "processing"].includes(row.delivery_status ?? "") ? "pending" : "not_requested",
        isCurrent: current?.id === row.id,
        createdAt: row.created_at, downloadAvailable: Boolean(receipt && ["issued", "accepted", "corrected"].includes(row.status)) };
    });
  }
  return {
    async read(input) {
      try {
        const rows = await owned(input);
        return rows === null ? { kind: "denied" } : { kind: "found", accountRef: input.accountRef, orderId: input.orderId, documents: project(rows) };
      } catch { return unknown; }
    },
    async resolveDownload(input) {
      try {
        const rows = await owned(input);
        if (!rows) return { kind: "denied" };
        // Membership and eligibility precede any ticket or PDF access, including
        // when this lower-level port is called without createInvoiceAccess.
        const document = project(rows).find(document => document.documentRef === input.documentRef);
        if (!document) return { kind: "denied" };
        if (!document.downloadAvailable) return unknown;
        const row = rows.find(row => row.id === input.documentRef)!;
        const receipt = matchingReceipt(row)!;
        const identity: InvoiceDocumentIdentity = { providerRef: row.provider!, documentRef: row.id,
          providerDocumentRef: row.provider_reference, orderRef: row.order_ref,
          invoiceRef: receipt.identity.invoiceRef, parentProviderDocumentRef: receipt.identity.parentProviderDocumentRef };
        return { kind: "authorized", identity, artifactRef: artifactRef(receiptKey(receipt.identity)),
          fileName: invoicePdfFilename(document.invoiceRef), parentDocumentRef: document.parentDocumentRef };
      } catch { return unknown; }
    },
  };
}

function matchingReceipt(row: NativeDocument) {
  const receipt = capturedReceipt(row.receipt);
  return receipt && receipt.identity.providerRef === row.provider && receipt.providerDocumentRef === row.provider_reference
    && receipt.identity.orderRef === row.order_ref ? receipt : null;
}

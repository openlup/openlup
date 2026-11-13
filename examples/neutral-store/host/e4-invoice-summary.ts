import { createPostgresBillingInvoiceStore } from '@openlup/platform/invoicing';
import type { InvoicePostgresExecutor } from '@openlup/platform/invoicing/postgres';

/** Authorized local evidence only. No artifact bytes, provider URL
 * or unfiltered error is returned to the operator. Caller owns authorization. */
export async function readOperatorInvoiceSummary(db: InvoicePostgresExecutor, orderId: string) {
  const order = await db.query(`SELECT c.principal_id FROM public.commerce_orders o
    LEFT JOIN public.clients c ON c.id=o.client_id WHERE o.id=$1::uuid`, [orderId]);
  if (!order.rows.length) return { kind: 'missing' as const };
  const result = await db.query(`SELECT a.id,a.document_ref,a.status,a.correction_of_document_id AS parent_id,
    a.correction_status,a.created_at::text,a.issued_at::text,a.total_gross_minor::text AS total,
    coalesce(f.facts->>'currency',a.metadata->>'currency',o.currency_code) AS currency,
    coalesce(f.facts->'before',f.facts)->>'documentKind' AS document_kind,
    CASE WHEN coalesce(f.facts->'before',f.facts)->'buyer' IS NULL THEN NULL
      WHEN coalesce(f.facts->'before',f.facts)->'buyer'->'taxIdentifier' <> 'null'::jsonb
        OR nullif(coalesce(f.facts->'before',f.facts)->'buyer'->>'companyName','') IS NOT NULL
      THEN 'business' ELSE 'consumer' END AS buyer_kind,
    (coalesce(f.facts->'before',f.facts)->>'clearanceRequired')::boolean AS clearance_required,
    a.submission_state,a.submission_reference,d.provider,a.provider_reference,
    observation.observation->>'providerDocumentNumber' AS provider_number,
    request.status AS request_status,request.attempts AS request_attempts,
    coalesce((SELECT jsonb_agg(jsonb_build_object('status',delivery.status,'state',receipt.state)
      ORDER BY delivery.id) FROM public.accounting_document_deliveries delivery
      LEFT JOIN public.invoicing_delivery_receipts receipt ON receipt.delivery_id=delivery.id
      WHERE delivery.document_id=a.id),'[]'::jsonb) AS deliveries
    FROM public.accounting_documents a JOIN public.commerce_orders o ON o.id=a.order_id
    LEFT JOIN public.invoicing_duties d ON d.document_id=a.id
    LEFT JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
    LEFT JOIN public.accounting_document_requests request ON request.id=d.request_id
    LEFT JOIN public.invoicing_document_observations observation ON observation.document_id=a.id
      AND observation.observation->>'format'='openlup.captured-invoice.v1'
      AND observation.observation->'identity'->>'providerCreateIdentity'='invoicing:'||d.id::text
    WHERE a.order_id=$1::uuid ORDER BY a.created_at,a.id`, [orderId]);
  const duties = await createPostgresBillingInvoiceStore(db).readDuties(orderId);
  if ('kind' in duties) return { kind: 'unknown' as const };
  const documents = result.rows.map(row => {
    const totalGrossMinor = Number(row.total);
    if (typeof row.total !== 'string' || !Number.isSafeInteger(totalGrossMinor) || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)
      || typeof row.id !== 'string' || typeof row.status !== 'string') throw new Error('starter_invoice_evidence_invalid');
    return { documentRef: row.id, invoiceRef: row.document_ref, parentDocumentRef: row.parent_id,
      role: row.parent_id === null ? 'original' : 'correction', status: row.status,
      correctionStatus: row.correction_status, createdAt: row.created_at, issuedAt: row.issued_at,
      totalGrossMinor, currency: row.currency, documentKind: row.document_kind, buyerKind: row.buyer_kind,
      clearanceRequired: row.clearance_required, clearance: { state: row.submission_state, reference: row.submission_reference },
      provider: row.provider, providerDocumentRef: row.provider_reference, providerDocumentNumber: row.provider_number,
      request: row.request_status === null ? null : { status: row.request_status, attempts: row.request_attempts },
      deliveries: row.deliveries };
  });
  const current = [...documents].reverse().find(document => document.parentDocumentRef === null
    && ['issued', 'accepted'].includes(document.status) && document.providerDocumentRef);
  const invoice = current ?? documents.at(-1) ?? null;
  const failed = invoice?.request?.status === 'failed';
  return { kind: 'found' as const, summary: { orderId,
    customerPrincipalRef: order.rows[0]!.principal_id,
    status: failed ? 'outbox_failed' : invoice?.status ?? 'missing',
    invoice, documents: documents.map(document => ({ ...document, isCurrent: document === current })),
    recoveryGuidance: failed ? 'review_and_retry'
      : invoice?.request && ['pending', 'processing'].includes(String(invoice.request.status)) ? 'wait_for_retry'
        : invoice && ['issued', 'accepted', 'corrected', 'voided'].includes(invoice.status) ? 'none' : 'not_requested',
    duties, buyerSnapshot: await createPostgresBillingInvoiceStore(db).readCapturedBuyer(orderId),
  } };
}

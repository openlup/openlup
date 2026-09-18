import type {
  AccountingInvoiceIssueResponse,
  AccountingPaidOrderInvoiceIssuePort,
} from "../../../src/domains/accounting/ports.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const REQUEST_PAID_ORDER_DOCUMENT_SQL = `
  WITH snapshot AS (
    SELECT
      order_row.total_amount_minor,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'description', 'order position ' || item.line_ordinal::text,
            'quantity', item.quantity,
            'unitGrossMinor', item.unit_amount_minor,
            'totalGrossMinor', item.line_amount_minor,
            'taxRateBps', 0
          ) ORDER BY item.line_ordinal
        ) FILTER (WHERE item.id IS NOT NULL),
        '[]'::jsonb
      ) AS positions
    FROM public.commerce_orders order_row
    LEFT JOIN public.commerce_order_items item ON item.order_id = order_row.id
    WHERE order_row.id = $2::uuid
    GROUP BY order_row.id, order_row.total_amount_minor
  )
  SELECT public.accounting_document_request_from_paid_order(
    $1, $2::uuid, snapshot.positions, snapshot.total_amount_minor,
    jsonb_build_object('providerKind', $3::text)
  ) AS response
  FROM snapshot`;

const READ_DOCUMENT_REFERENCE_SQL = `
  SELECT document_ref
  FROM public.accounting_documents
  WHERE id = $1::uuid`;

type AccountingDocumentRailResponse = {
  replayed?: unknown;
  document?: {
    id?: unknown;
    status?: unknown;
  };
};

/** Direct-PG binding for the one provider-neutral action shared by both bundles. */
export function createPostgresAccountingPaidOrderDocumentPort(
  executor: PgQueryExecutor,
): AccountingPaidOrderInvoiceIssuePort {
  return {
    async requestInvoiceIssueFromPaidOrder(request) {
      const result = await executor.query(REQUEST_PAID_ORDER_DOCUMENT_SQL, [
        request.idempotencyKey,
        request.orderId,
        request.providerKind,
      ]);
      const response = asRecord(result.rows[0])?.response as AccountingDocumentRailResponse | undefined;
      const document = asRecord(response?.document);
      if (
        typeof document?.id !== "string"
        || typeof document.status !== "string"
        || typeof response?.replayed !== "boolean"
      ) {
        throw new Error("accounting_paid_order_document_response_invalid");
      }
      const invoiceRef = asRecord((await executor.query(READ_DOCUMENT_REFERENCE_SQL, [document.id])).rows[0])?.document_ref;
      if (typeof invoiceRef !== "string") throw new Error("accounting_paid_order_document_reference_missing");
      return {
        invoice: {
          id: document.id,
          invoiceRef,
          status: document.status,
          replayed: response.replayed,
        },
      } satisfies AccountingInvoiceIssueResponse;
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

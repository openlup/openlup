import { createPostgresInvoiceStore } from "@openlup/platform/invoicing";
import type {
  AccountingInvoiceIssueResponse,
  AccountingPaidOrderInvoiceIssuePort,
} from "../../../src/domains/accounting/ports.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

/** Direct-PG binding for the one provider-neutral action shared by both bundles. */
export function createPostgresAccountingPaidOrderDocumentPort(
  executor: PgQueryExecutor,
): AccountingPaidOrderInvoiceIssuePort {
  return {
    async requestInvoiceIssueFromPaidOrder(request) {
      const result = await createPostgresInvoiceStore(executor).requestLocalDocument({
        requestKey: request.idempotencyKey, orderId: request.orderId, providerRef: request.providerKind,
      });
      if (result.kind !== "requested") throw new Error("accounting_paid_order_document_response_invalid");
      return {
        invoice: {
          id: result.documentId,
          invoiceRef: result.invoiceRef,
          status: result.status,
          replayed: result.replayed,
        },
      } satisfies AccountingInvoiceIssueResponse;
    },
  };
}

import type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow } from "../../../model/omsReadModel.js";
import { CommerceOmsPersistenceError } from "../../../oms/omsPorts.js";
import type { CommerceOmsStore } from "./types.js";

export async function readAccountingOutbox(
  client: CommerceOmsStore,
  invoices: OmsAccountingInvoiceRow[],
): Promise<OmsAccountingOutboxRow[]> {
  const result = invoices.length
    ? await client
      .query("accounting_invoice_issue_outbox")
      .select("invoice_id, status, attempt_count, next_attempt_at, last_error, created_at")
      .in("invoice_id", invoices.map((invoice) => invoice.id))
      .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS accounting outbox list read failed");
  return (result.data ?? []) as OmsAccountingOutboxRow[];
}

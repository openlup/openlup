const ACCOUNTING_INVOICES_TABLE = "accounting_invoices";
const ACCOUNTING_E2E_INVOICE_COLUMNS =
  "id, order_id, invoice_ref, status, document_kind, ksef_required, ksef_status, provider_kind, provider_invoice_id, provider_invoice_number, email_status, blocked_reason, updated_at";

export type AccountingE2eInvoiceRow = Record<string, unknown>;

export interface AccountingE2eInvoiceReadSupabaseClient {
  from(table: typeof ACCOUNTING_INVOICES_TABLE): AccountingE2eInvoiceReadQuery;
}

interface AccountingE2eInvoiceReadQuery {
  select(columns: typeof ACCOUNTING_E2E_INVOICE_COLUMNS): AccountingE2eInvoiceReadQuery;
  eq(column: "id", value: string): AccountingE2eInvoiceReadQuery;
  maybeSingle(): PromiseLike<{
    data: AccountingE2eInvoiceRow | null;
    error: { message?: string } | null;
  }>;
}

export async function readAccountingE2eInvoice(
  client: AccountingE2eInvoiceReadSupabaseClient,
  invoiceId: string,
): Promise<AccountingE2eInvoiceRow | null> {
  const { data, error } = await client
    .from(ACCOUNTING_INVOICES_TABLE)
    .select(ACCOUNTING_E2E_INVOICE_COLUMNS)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message ?? "accounting_e2e_invoice_read_failed");
  return data;
}

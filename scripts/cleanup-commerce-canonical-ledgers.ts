type JsonRecord = Record<string, unknown>;
type QueryResult = { data?: unknown; error?: { message?: string } | null };
type QueryBuilder = PromiseLike<QueryResult> & Record<string, (...args: unknown[]) => QueryBuilder>;
type SupabaseLike = { from: (table: string) => QueryBuilder };

export type CanonicalLedgerIds = {
  paymentReconciliationRunIds: string[];
  settlementItemIds: string[];
};

export type CanonicalLedgerReadback = {
  remainingAccountingInvoices: number | null;
  remainingPaymentReconciliationRuns: number | null;
  remainingProviderSettlementItems: number | null;
  remainingProviderSettlementBatches: number | null;
  remainingPayments: number | null;
  remainingPaymentIntents: number | null;
  remainingPaymentAttempts: number | null;
};

type LedgerSelectionIds = {
  invoiceIds: string[];
  paymentIds: string[];
  paymentIntentIds: string[];
  paymentAttemptIds: string[];
};

type LedgerReadbackIds = LedgerSelectionIds & CanonicalLedgerIds;

export async function selectCanonicalLedgerRows(
  client: SupabaseLike,
  ids: LedgerSelectionIds,
  options: { allCommerce: boolean; maxRows: number },
): Promise<{
  payments: JsonRecord[];
  settlementItems: JsonRecord[];
  settlementBatches: JsonRecord[];
  paymentReconciliationRuns: JsonRecord[];
}> {
  const payments = options.allCommerce
    ? await selectAll(client, "commerce_payments", "id", options.maxRows)
    : [];
  const settlementItems = options.allCommerce
    ? await selectAll(client, "payment_provider_settlement_items", "id,batch_id", options.maxRows)
    : mergeRowsById([
      ...await selectByIds(client, "payment_provider_settlement_items", "id,batch_id", "invoice_id", ids.invoiceIds),
      ...await selectByIds(client, "payment_provider_settlement_items", "id,batch_id", "payment_intent_id", ids.paymentIntentIds),
      ...await selectByIds(client, "payment_provider_settlement_items", "id,batch_id", "payment_id", ids.paymentIds),
    ]);
  const settlementBatches = options.allCommerce
    ? await selectAll(client, "payment_provider_settlement_batches", "id", options.maxRows)
    : await selectByIds(
      client,
      "payment_provider_settlement_batches",
      "id",
      "id",
      settlementItems.map((row) => text(row.batch_id)),
    );
  const paymentReconciliationRuns = options.allCommerce
    ? await selectAll(client, "commerce_payment_reconciliation_runs", "id", options.maxRows)
    : mergeRowsById([
      ...await selectByIds(client, "commerce_payment_reconciliation_runs", "id", "payment_intent_id", ids.paymentIntentIds),
      ...await selectByIds(client, "commerce_payment_reconciliation_runs", "id", "payment_attempt_id", ids.paymentAttemptIds),
    ]);
  return { payments, settlementItems, settlementBatches, paymentReconciliationRuns };
}

export function deriveCanonicalLedgerIds(
  existingPaymentIds: string[],
  rows: Awaited<ReturnType<typeof selectCanonicalLedgerRows>>,
): CanonicalLedgerIds & { paymentIds: string[]; settlementBatchIds: string[] } {
  return {
    paymentIds: uniqueStrings([...existingPaymentIds, ...rows.payments.map((row) => text(row.id))]),
    paymentReconciliationRunIds: uniqueStrings(rows.paymentReconciliationRuns.map((row) => text(row.id))),
    settlementItemIds: uniqueStrings(rows.settlementItems.map((row) => text(row.id))),
    settlementBatchIds: uniqueStrings(rows.settlementBatches.map((row) => text(row.id))),
  };
}

export async function readCanonicalLedgerEvidence(
  client: SupabaseLike,
  ids: LedgerReadbackIds & { settlementBatchIds: string[] },
  options: { allCommerce: boolean },
): Promise<CanonicalLedgerReadback> {
  const [
    remainingAccountingInvoices,
    remainingPaymentReconciliationRuns,
    remainingProviderSettlementItems,
    remainingProviderSettlementBatches,
    remainingPayments,
    remainingPaymentIntents,
    remainingPaymentAttempts,
  ] = await Promise.all([
    countRowsByIds(client, "accounting_invoices", ids.invoiceIds),
    countRowsByIds(client, "commerce_payment_reconciliation_runs", ids.paymentReconciliationRunIds),
    countRowsByIds(client, "payment_provider_settlement_items", ids.settlementItemIds),
    options.allCommerce
      ? countRowsByIds(client, "payment_provider_settlement_batches", ids.settlementBatchIds)
      : null,
    countRowsByIds(client, "commerce_payments", ids.paymentIds),
    countRowsByIds(client, "commerce_payment_intents", ids.paymentIntentIds),
    countRowsByIds(client, "commerce_payment_attempts", ids.paymentAttemptIds),
  ]);
  return {
    remainingAccountingInvoices,
    remainingPaymentReconciliationRuns,
    remainingProviderSettlementItems,
    remainingProviderSettlementBatches,
    remainingPayments,
    remainingPaymentIntents,
    remainingPaymentAttempts,
  };
}

export function emptyCanonicalLedgerReadback(): CanonicalLedgerReadback {
  return {
    remainingAccountingInvoices: null,
    remainingPaymentReconciliationRuns: null,
    remainingProviderSettlementItems: null,
    remainingProviderSettlementBatches: null,
    remainingPayments: null,
    remainingPaymentIntents: null,
    remainingPaymentAttempts: null,
  };
}

export function assertCanonicalLedgerReadbackEmpty(readback: CanonicalLedgerReadback): void {
  const remainingRows = [
    ["accounting_invoices", readback.remainingAccountingInvoices],
    ["commerce_payment_reconciliation_runs", readback.remainingPaymentReconciliationRuns],
    ["payment_provider_settlement_items", readback.remainingProviderSettlementItems],
    ["payment_provider_settlement_batches", readback.remainingProviderSettlementBatches],
    ["commerce_payments", readback.remainingPayments],
    ["commerce_payment_intents", readback.remainingPaymentIntents],
    ["commerce_payment_attempts", readback.remainingPaymentAttempts],
  ] as const;
  for (const [table, remaining] of remainingRows) {
    if ((remaining ?? 0) > 0) {
      throw new Error(`Staging commerce cleanup left ${remaining} selected ${table} rows`);
    }
  }
}

async function countRowsByIds(client: SupabaseLike, table: string, ids: string[]): Promise<number> {
  return (await selectByIds(client, table, "id", "id", ids)).length;
}

async function selectAll(client: SupabaseLike, table: string, columns: string, maxRows: number): Promise<JsonRecord[]> {
  const pageSize = 1000;
  const rows: JsonRecord[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const end = Math.min(offset + pageSize - 1, maxRows - 1);
    const result = await client.from(table).select(columns).range(offset, end);
    if (result.error) throw new Error(`${table}: ${result.error.message ?? "query failed"}`);
    const page = rowsFrom(result.data);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw new Error(`${table}: selected ${maxRows} rows; increase --max-rows to avoid a partial cleanup`);
}

async function selectByIds(
  client: SupabaseLike,
  table: string,
  columns: string,
  column: string,
  values: string[],
): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  const uniqueValues = [...new Set(values)];
  for (let index = 0; index < uniqueValues.length; index += 100) {
    const batch = uniqueValues.slice(index, index + 100);
    if (batch.length === 0) continue;
    const result = await client.from(table).select(columns).in(column, batch);
    if (result.error) throw new Error(`${table}.${column}: ${result.error.message ?? "query failed"}`);
    rows.push(...rowsFrom(result.data));
  }
  return mergeRowsById(rows);
}

function mergeRowsById(rows: JsonRecord[]): JsonRecord[] {
  return [...new Map(rows.map((row) => [String(row.id ?? ""), row])).values()];
}

function rowsFrom(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((row): row is JsonRecord => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

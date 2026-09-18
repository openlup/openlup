import type {
  AccountingInvoiceMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderSettlementMoneyRow,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";

export function correlateSettlementRows(
  rows: ProviderSettlementMoneyRow[],
  intents: PaymentIntentMoneyRow[],
  attempts: PaymentAttemptMoneyRow[],
  invoices: AccountingInvoiceMoneyRow[],
): ProviderSettlementMoneyRow[] {
  const knownIntentIds = new Set(intents.map((row) => row.id));
  const intentIdsByPayment = groupRelation(intents, (row) => row.payment_id);
  const intentIdsByProviderPayment = groupOptionalRelation(intents, (row) => row.provider_payment_id);
  appendOptionalRelation(
    intentIdsByProviderPayment,
    attempts,
    (row) => row.provider_attempt_id,
    (row) => row.payment_intent_id,
  );
  const intentIdsByOrder = groupRelation(intents, (row) => row.order_id);
  const invoiceOrderById = new Map(invoices.map((row) => [row.id, row.order_id]));

  return rows.flatMap((row) => {
    const links = settlementLinkCandidates(
      row,
      knownIntentIds,
      intentIdsByPayment,
      intentIdsByProviderPayment,
      intentIdsByOrder,
      invoiceOrderById,
    );
    const union = [...new Set(links.flat())];
    if (union.length === 0) {
      throw new Error(`order_money_settlement_correlation_unresolved:${row.id}`);
    }
    const intersection = links.length > 0 && links.every((values) => values.length > 0)
      ? links.slice(1).reduce(
        (values, link) => values.filter((intentId) => link.includes(intentId)),
        links[0],
      )
      : [];
    const resolvedIntentId = intersection.length === 1 ? intersection[0] : null;
    const intentIds = resolvedIntentId ? [resolvedIntentId] : union;
    return intentIds.map((intentId) => ({
      ...row,
      payment_intent_id: intentId,
      correlation_issue: resolvedIntentId ? undefined : "conflicting_links" as const,
    }));
  });
}

function settlementLinkCandidates(
  row: ProviderSettlementMoneyRow,
  knownIntentIds: Set<string>,
  intentIdsByPayment: Map<string, string[]>,
  intentIdsByProviderPayment: Map<string, string[]>,
  intentIdsByOrder: Map<string, string[]>,
  invoiceOrderById: Map<string, string>,
): string[][] {
  const links: string[][] = [];
  if (row.payment_intent_id) {
    links.push(knownIntentIds.has(row.payment_intent_id) ? [row.payment_intent_id] : []);
  }
  if (row.payment_id) links.push(intentIdsByPayment.get(row.payment_id) ?? []);
  links.push(intentIdsByProviderPayment.get(row.provider_payment_id) ?? []);
  if (row.invoice_id) {
    const orderId = invoiceOrderById.get(row.invoice_id);
    links.push(orderId ? intentIdsByOrder.get(orderId) ?? [] : []);
  }
  return links;
}

function groupRelation<T>(rows: T[], keyOf: (row: T) => string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows as Array<T & { id: string }>) {
    const key = keyOf(row);
    result.set(key, [...(result.get(key) ?? []), row.id]);
  }
  return result;
}

function groupOptionalRelation<T>(
  rows: T[],
  keyOf: (row: T) => string | null,
): Map<string, string[]> {
  return groupRelation(rows.filter((row) => keyOf(row) !== null), (row) => keyOf(row)!);
}

function appendOptionalRelation<T>(
  relation: Map<string, string[]>,
  rows: T[],
  keyOf: (row: T) => string | null,
  valueOf: (row: T) => string,
): void {
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const value = valueOf(row);
    const existing = relation.get(key) ?? [];
    if (!existing.includes(value)) relation.set(key, [...existing, value]);
  }
}

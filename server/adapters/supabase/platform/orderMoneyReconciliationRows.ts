import {
  selectAllRows,
  type SupabaseObservabilityClient,
  type SupabaseQuery,
} from "./observabilityEvidenceQueries.js";
import { correlateSettlementRows } from "../../../domains/platform/orderMoneySettlementCorrelation.js";
import type {
  AccountingInvoiceMoneyRow,
  FulfillmentMoneyRow,
  OrderItemMoneyRow,
  OrderMoneyReconciliationRows,
  PaidOrderMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderEventMoneyRow,
  ProviderReconciliationMoneyRow,
  ProviderSettlementMoneyRow,
  SubscriptionCycleMoneyRow,
} from "../../../../src/domains/platform/orderMoneyReconciliationContracts.js";

export type {
  AccountingInvoiceMoneyRow,
  FulfillmentMoneyRow,
  OrderItemMoneyRow,
  OrderMoneyReconciliationRows,
  PaidOrderMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderEventMoneyRow,
  ProviderReconciliationMoneyRow,
  ProviderSettlementMoneyRow,
  SubscriptionCycleMoneyRow,
} from "../../../../src/domains/platform/orderMoneyReconciliationContracts.js";

const ORDER_BATCH_SIZE = 100;
const RECONCILABLE_ORDER_STATUSES = ["paid", "fulfillment_pending", "fulfilled", "refunded"];

export async function readOrderMoneyReconciliationRows(
  client: SupabaseObservabilityClient,
): Promise<OrderMoneyReconciliationRows> {
  const [statusOrders, providerInvoices] = await Promise.all([
    selectAllRows<PaidOrderMoneyRow>(
      (from, to) => client.from<PaidOrderMoneyRow>("commerce_orders")
        .select("id,order_number,mode,status,subtotal_cents,discount_cents,shipping_cents,shipping_discount_cents,tax_cents,total_cents,currency,subscription_cycle_id,updated_at")
        .in("status", RECONCILABLE_ORDER_STATUSES)
        .order("id", { ascending: true })
        .range(from, to),
      "commerce_orders_money_reconciliation",
    ),
    selectAllRows<AccountingInvoiceMoneyRow>(
      (from, to) => client.from<AccountingInvoiceMoneyRow>("accounting_invoices")
        .select(INVOICE_MONEY_SELECT)
        .not("provider_invoice_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to),
      "accounting_provider_invoices_money_reconciliation",
    ),
  ]);
  const providerBaseInvoices = providerInvoices.filter((row) => row.correction_of_invoice_id == null);
  const invoicedOrders = await selectByIds<PaidOrderMoneyRow>(
    client,
    "commerce_orders",
    "id",
    providerBaseInvoices.map((row) => row.order_id),
    "id,order_number,mode,status,subtotal_cents,discount_cents,shipping_cents,shipping_discount_cents,tax_cents,total_cents,currency,subscription_cycle_id,updated_at",
    "commerce_invoiced_orders_money_reconciliation",
  );
  const orders = uniqueById([...statusOrders, ...invoicedOrders]);
  const orderIds = orders.map((row) => row.id);
  const cycleIds = orders.flatMap((row) => row.subscription_cycle_id ? [row.subscription_cycle_id] : []);
  const [items, cycles, intents, orderInvoices, fulfillment] = await Promise.all([
    selectByIds<OrderItemMoneyRow>(client, "commerce_order_items", "order_id", orderIds,
      "id,order_id,allocation_ordinal,quantity,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps", "commerce_order_items_money_reconciliation"),
    selectByIds<SubscriptionCycleMoneyRow>(client, "subscription_cycles", "id", cycleIds,
      "id,cycle_number", "subscription_cycles_money_reconciliation"),
    selectByIds<PaymentIntentMoneyRow>(client, "commerce_payment_intents", "order_id", orderIds,
      "id,order_id,payment_id,status,amount_cents,currency,active_attempt_id,provider_payment_id,updated_at", "commerce_payment_intents_money_reconciliation"),
    selectByIds<AccountingInvoiceMoneyRow>(client, "accounting_invoices", "order_id", orderIds,
      INVOICE_MONEY_SELECT, "accounting_invoices_money_reconciliation"),
    selectByIds<FulfillmentMoneyRow>(client, "commerce_fulfillment_orders", "order_id", orderIds,
      "id,order_id,status,handed_over_at", "commerce_fulfillment_orders_money_reconciliation"),
  ]);
  const intentIds = intents.map((row) => row.id);
  const [attempts, events, reconciliations] = await Promise.all([
    selectByIds<PaymentAttemptMoneyRow>(client, "commerce_payment_attempts", "payment_intent_id", intentIds,
      "id,created_at,updated_at,payment_intent_id,provider,status,amount_cents,currency,provider_attempt_id", "commerce_payment_attempts_money_reconciliation"),
    selectByIds<ProviderEventMoneyRow>(client, "inbound_provider_events", "payment_intent_id", intentIds,
      "id,created_at,provider,provider_event_id,provider_payment_id,payment_intent_id,payment_attempt_id,event_type,amount_cents,currency,signature_verified", "inbound_provider_events_money_reconciliation"),
    selectByIds<ProviderReconciliationMoneyRow>(client, "commerce_payment_reconciliation_runs", "payment_intent_id", intentIds,
      "id,payment_intent_id,payment_attempt_id,correction_status,provider_status,checked_at,payload", "commerce_payment_reconciliation_runs_money_reconciliation"),
  ]);
  const settlements = await readSettlements(client, intents, attempts, orderInvoices);
  return {
    orders,
    items,
    cycles,
    intents,
    attempts,
    events,
    reconciliations,
    settlements,
    invoices: uniqueById([...providerInvoices, ...orderInvoices])
      .filter((row) => row.provider_invoice_id != null || row.status !== "voided"),
    fulfillment,
  };
}

const INVOICE_MONEY_SELECT = "id,order_id,invoice_ref,status,correction_of_invoice_id,provider_kind,provider_invoice_id,blocked_reason,total_gross_cents,total_net_cents,currency,lines_snapshot,metadata,created_at,updated_at,ksef_status";

async function selectByIds<T>(
  client: SupabaseObservabilityClient,
  table: string,
  column: string,
  ids: string[],
  select: string,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += ORDER_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + ORDER_BATCH_SIZE);
    rows.push(...await selectAllRows<T>(
      (from, to) => byIdsQuery(client.from<T>(table), select, column, batch, from, to),
      label,
    ));
  }
  return rows;
}

function byIdsQuery<T>(
  query: SupabaseQuery<T>,
  select: string,
  column: string,
  ids: string[],
  from: number,
  to: number,
): SupabaseQuery<T> {
  return query.select(select).in(column, ids).order("id", { ascending: true }).range(from, to);
}

async function readSettlements(
  client: SupabaseObservabilityClient,
  intents: PaymentIntentMoneyRow[],
  attempts: PaymentAttemptMoneyRow[],
  invoices: AccountingInvoiceMoneyRow[],
): Promise<ProviderSettlementMoneyRow[]> {
  const select = "id,created_at,batch_id,provider_kind,provider_payment_id,payment_intent_id,payment_id,invoice_id,status,gross_cents,currency,evidence";
  const [byIntent, byPayment, byInvoice, byProviderPayment] = await Promise.all([
    selectByIds<ProviderSettlementMoneyRow>(client, "payment_provider_settlement_items", "payment_intent_id", intents.map((row) => row.id),
      select, "payment_provider_settlement_items_by_intent_money_reconciliation"),
    selectByIds<ProviderSettlementMoneyRow>(client, "payment_provider_settlement_items", "payment_id", intents.map((row) => row.payment_id),
      select, "payment_provider_settlement_items_by_payment_money_reconciliation"),
    selectByIds<ProviderSettlementMoneyRow>(client, "payment_provider_settlement_items", "invoice_id", invoices.map((row) => row.id),
      select, "payment_provider_settlement_items_by_invoice_money_reconciliation"),
    selectByIds<ProviderSettlementMoneyRow>(client, "payment_provider_settlement_items", "provider_payment_id", [
      ...intents.flatMap((row) => row.provider_payment_id ? [row.provider_payment_id] : []),
      ...attempts.flatMap((row) => row.provider_attempt_id ? [row.provider_attempt_id] : []),
    ],
      select, "payment_provider_settlement_items_by_provider_payment_money_reconciliation"),
  ]);
  return correlateSettlementRows(
    uniqueById([...byIntent, ...byPayment, ...byInvoice, ...byProviderPayment]),
    intents,
    attempts,
    invoices,
  );
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

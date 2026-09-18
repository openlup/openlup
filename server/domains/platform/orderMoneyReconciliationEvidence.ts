import type {
  AccountingInvoiceIssueTrigger,
  MoneyLedgerValue,
  OrderMoneyMismatchCode,
  OrderMoneyReconciliationEvidence,
  OrderMoneyReconciliationMode,
  OrderMoneyReconciliationRows,
  OrderMoneyReconciliationSnapshot,
  FulfillmentMoneyRow,
  PaidOrderMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderEventMoneyRow,
  ProviderReconciliationMoneyRow,
  ProviderSettlementMoneyRow,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";
import { matchCanonicalMoneyLegacyException } from "../../../src/domains/platform/orderMoneyLegacyExceptions.js";
import { hasValidCanonicalOrderHeader } from "./orderMoneyInvoiceComparison.js";
import { reconcileOrderInvoice } from "./orderMoneyInvoiceEvidence.js";
import {
  hasComparableMoney,
  isChargeBearingIntentStatus,
  isTrustedSucceededReconciliation,
  resolvePaymentConfirmedAt,
} from "./orderMoneyPaymentEvidence.js";
import {
  hasTrustedProviderSettlementProvenance,
  reconcileProviderSettlement,
} from "./orderMoneySettlementEvidence.js";

export function summarizeOrderMoneyReconciliation(
  rows: OrderMoneyReconciliationRows,
  now: Date,
  options: { issueTrigger: AccountingInvoiceIssueTrigger } = { issueTrigger: "paid" },
): OrderMoneyReconciliationSnapshot {
  const cycles = new Map(rows.cycles.map((row) => [row.id, row]));
  const orderItems = groupBy(rows.items, (row) => row.order_id);
  const intents = groupBy(rows.intents, (row) => row.order_id);
  const attempts = groupBy(rows.attempts, (row) => row.payment_intent_id);
  const events = groupBy(rows.events, (row) => row.payment_intent_id ?? "");
  const reconciliations = groupBy(rows.reconciliations, (row) => row.payment_intent_id ?? "");
  const settlements = groupBy(rows.settlements, (row) => row.payment_intent_id ?? "");
  const invoices = groupBy(rows.invoices, (row) => row.order_id);
  const fulfillment = groupBy(rows.fulfillment ?? [], (row) => row.order_id);
  const evidence = rows.orders.map((order) => reconcileOrder({
    order,
    orderItems: orderItems.get(order.id) ?? [],
    cycleNumber: order.subscription_cycle_id ? cycles.get(order.subscription_cycle_id)?.cycle_number : undefined,
    intents: intents.get(order.id) ?? [],
    attempts,
    events,
    reconciliations,
    settlements,
    invoices: invoices.get(order.id) ?? [],
    fulfillment: fulfillment.get(order.id) ?? [],
    issueTrigger: options.issueTrigger,
    now,
  }));
  const byMode = Object.fromEntries(
    (["one_time", "subscription_initial", "subscription_renewal"] as const).map((mode) => {
      const matching = evidence.filter((row) => row.mode === mode);
      return [mode, {
        checkedCount: matching.length,
        mismatchCount: matching.filter((row) => row.mismatchCodes.length > 0).length,
        providerUnavailableCount: matching.filter(hasIncompleteProviderSettlement).length,
        providerUnsupportedCount: matching.filter((row) => row.providerSettlement.state === "unsupported").length,
        providerPendingCount: matching.filter((row) => row.providerSettlement.state === "pending").length,
        providerOverdueCount: matching.filter((row) => row.providerSettlement.state === "overdue").length,
        providerEventMoneyUnavailableCount: matching.filter((row) => row.providerEvent?.state === "unavailable").length,
      }];
    }),
  ) as OrderMoneyReconciliationSnapshot["byMode"];
  return {
    checkedCount: evidence.length,
    mismatchCount: evidence.filter((row) => row.mismatchCodes.length > 0).length,
    providerUnavailableCount: evidence.filter(hasIncompleteProviderSettlement).length,
    providerUnsupportedCount: evidence.filter((row) => row.providerSettlement.state === "unsupported").length,
    providerPendingCount: evidence.filter((row) => row.providerSettlement.state === "pending").length,
    providerOverdueCount: evidence.filter((row) => row.providerSettlement.state === "overdue").length,
    providerEventMoneyUnavailableCount: evidence.filter((row) => row.providerEvent?.state === "unavailable").length,
    byMode,
    evidence,
  };
}

function reconcileOrder(input: {
  order: PaidOrderMoneyRow;
  orderItems: OrderMoneyReconciliationRows["items"];
  cycleNumber: number | undefined;
  intents: PaymentIntentMoneyRow[];
  attempts: Map<string, PaymentAttemptMoneyRow[]>;
  events: Map<string, ProviderEventMoneyRow[]>;
  reconciliations: Map<string, ProviderReconciliationMoneyRow[]>;
  settlements: Map<string, ProviderSettlementMoneyRow[]>;
  invoices: OrderMoneyReconciliationRows["invoices"];
  fulfillment: FulfillmentMoneyRow[];
  issueTrigger: AccountingInvoiceIssueTrigger;
  now: Date;
}): OrderMoneyReconciliationEvidence {
  const mismatchCodes: OrderMoneyMismatchCode[] = [];
  const mode = orderMode(input.order, input.cycleNumber, mismatchCodes);
  const chargeIntents = input.intents.filter((row) => isChargeBearingIntentStatus(row.status));
  if (chargeIntents.length !== 1) mismatchCodes.push("charge_intent_count");
  const intent = chargeIntents[0] ?? null;
  if (intent) compareLedger(mismatchCodes, input.order, intent, "intent_amount", "intent_currency");
  const intentAttempts = intent ? input.attempts.get(intent.id) ?? [] : [];
  const succeededAttempts = intentAttempts.filter((row) => row.status === "succeeded");
  if (intent && succeededAttempts.length !== 1) mismatchCodes.push("succeeded_attempt_count");
  const attempt = succeededAttempts[0] ?? null;
  if (intent && attempt && intent.active_attempt_id !== attempt.id) mismatchCodes.push("intent_active_attempt");
  if (intent && attempt && intent.provider_payment_id !== attempt.provider_attempt_id) {
    mismatchCodes.push("intent_attempt_payment_ref");
  }
  if (attempt) compareLedger(mismatchCodes, input.order, attempt, "attempt_amount", "attempt_currency");
  const signedSuccessEvents = intent
    ? (input.events.get(intent.id) ?? []).filter((row) =>
      row.event_type === "payment.succeeded" && row.signature_verified === true &&
      (!row.payment_attempt_id || !attempt || row.payment_attempt_id === attempt.id))
    : [];
  const expectedProviderPaymentId = intent?.provider_payment_id ?? attempt?.provider_attempt_id ?? null;
  for (const event of signedSuccessEvents) {
    if (!attempt || normalizeProvider(event.provider) !== normalizeProvider(attempt.provider)) {
      mismatchCodes.push("provider_event_provider");
    }
    if (!expectedProviderPaymentId || event.provider_payment_id !== expectedProviderPaymentId) {
      mismatchCodes.push("provider_event_payment_ref");
    }
  }
  const trustedEvents = signedSuccessEvents.filter((row) =>
    attempt !== null && expectedProviderPaymentId !== null &&
    normalizeProvider(row.provider) === normalizeProvider(attempt.provider) &&
    row.provider_payment_id === expectedProviderPaymentId);
  const trustedReconciliations = intent && attempt
    ? (input.reconciliations.get(intent.id) ?? []).filter((row) =>
      isTrustedSucceededReconciliation(row, attempt))
    : [];
  if (intent && trustedEvents.length === 0 && trustedReconciliations.length === 0) {
    mismatchCodes.push("trusted_provider_event_missing");
  }
  for (const event of trustedEvents.filter(hasComparableMoney)) {
    compareLedger(mismatchCodes, input.order, event, "provider_event_amount", "provider_event_currency");
  }
  const event = trustedEvents.find((row) => hasComparableMoney(row) && (
    row.amount_cents !== input.order.total_cents ||
    normalizeCurrency(row.currency) !== normalizeCurrency(input.order.currency)
  )) ?? trustedEvents.find(hasComparableMoney) ?? trustedEvents.find((row) => !hasComparableMoney(row)) ?? null;
  for (const reconciliation of trustedReconciliations) {
    const currency = reconciliation.payload?.currency;
    if (typeof currency === "string" && currency.trim() &&
      normalizeCurrency(currency) !== normalizeCurrency(input.order.currency)) {
      mismatchCodes.push("provider_reconciliation_currency");
    }
  }
  const { localSettlement, providerSettlement } = reconcileProviderSettlement({
    rows: intent ? input.settlements.get(intent.id) ?? [] : [],
    order: input.order,
    intent,
    attempt,
    intentAttempts,
    mismatches: mismatchCodes,
    now: input.now,
  });
  if (!hasValidCanonicalOrderHeader(input.order)) mismatchCodes.push("order_header");
  const invoiceEvidence = reconcileOrderInvoice({
    order: input.order,
    orderItems: input.orderItems,
    paymentConfirmedAt: resolvePaymentConfirmedAt({
      events: trustedEvents,
      reconciliations: trustedReconciliations,
      attempt,
    }),
    invoices: input.invoices,
    fulfillment: input.fulfillment,
    issueTrigger: input.issueTrigger,
    now: input.now,
    mismatches: mismatchCodes,
  });
  const invoice = invoiceEvidence.current;
  const positionTotals = invoiceEvidence.positionTotals;
  const providerEvent = event ? {
    ...ledger(event.id, event.amount_cents, event.currency),
    state: !hasComparableMoney(event)
      ? "unavailable" as const
      : event.amount_cents === input.order.total_cents && normalizeCurrency(event.currency) === normalizeCurrency(input.order.currency)
        ? "matched" as const : "mismatch" as const,
  } : reconciliationUnavailableMoney(trustedReconciliations[0] ?? null);

  const evidence: OrderMoneyReconciliationEvidence = {
    orderId: input.order.id,
    orderRef: input.order.order_number,
    mode,
    paymentProvider: attempt?.provider ?? null,
    subscriptionCycleId: input.order.subscription_cycle_id,
    mismatchCodes: unique(mismatchCodes),
    order: {
      ...ledger(input.order.id, input.order.total_cents, input.order.currency),
      subtotalCents: input.order.subtotal_cents,
      discountCents: input.order.discount_cents,
      shippingCents: input.order.shipping_cents,
      shippingDiscountCents: input.order.shipping_discount_cents,
      taxCents: input.order.tax_cents,
      netCents: input.order.total_cents - input.order.tax_cents,
    },
    intent: intent ? ledger(intent.id, intent.amount_cents, intent.currency) : null,
    attempt: attempt ? ledger(attempt.id, attempt.amount_cents, attempt.currency) : null,
    providerEvent,
    localSettlement,
    providerSettlement,
    fulfillment: invoiceEvidence.fulfillment,
    invoiceExpectation: invoiceEvidence.expectation,
    invoiceLineageIds: invoiceEvidence.lineage,
    disposition: mismatchCodes.length === 0 ? "matched" : "mismatch",
    invoice: invoice ? {
      ...ledger(invoice.id, invoice.total_gross_cents, invoice.currency),
      netCents: invoice.total_net_cents,
      positionGrossCents: positionTotals?.grossCents ?? null,
      positionNetCents: positionTotals?.netCents ?? null,
    } : null,
    relatedIds: {
      chargeIntentIds: chargeIntents.map((row) => row.id),
      succeededAttemptIds: succeededAttempts.map((row) => row.id),
      trustedProviderEventIds: trustedEvents.map((row) => row.id),
      trustedProviderReconciliationIds: trustedReconciliations.map((row) => row.id),
      localSettlementIds: (intent ? input.settlements.get(intent.id) ?? [] : []).map((row) => row.id),
      trustedProviderSettlementIds: (intent ? input.settlements.get(intent.id) ?? [] : [])
        .filter(hasTrustedProviderSettlementProvenance)
        .map((row) => row.id),
      baseInvoiceIds: invoiceEvidence.lineage.rootInvoiceIds,
    },
    observedAt: input.now.toISOString(),
  };
  if (matchCanonicalMoneyLegacyException(evidence)) {
    evidence.disposition = "accepted_legacy_exception";
  } else if (evidence.mismatchCodes.length === 1 &&
    evidence.mismatchCodes[0] === "base_invoice_count" &&
    evidence.invoiceExpectation.issueTrigger === "handoff" &&
    evidence.invoiceExpectation.state === "required") {
    evidence.disposition = "accounting_missing_invoice_owner";
  }
  return evidence;
}

function hasIncompleteProviderSettlement(row: OrderMoneyReconciliationEvidence): boolean {
  return ["unsupported", "pending", "overdue"].includes(row.providerSettlement.state);
}

function reconciliationUnavailableMoney(
  row: ProviderReconciliationMoneyRow | null,
): OrderMoneyReconciliationEvidence["providerEvent"] {
  if (!row) return null;
  const currency = typeof row.payload?.currency === "string" ? row.payload.currency : null;
  return { ...ledger(row.id, null, currency), state: "unavailable" };
}

function compareLedger(
  mismatches: OrderMoneyMismatchCode[],
  order: PaidOrderMoneyRow,
  row: { amount_cents?: number | null; gross_cents?: number | null; total_gross_cents?: number | null; currency?: string | null },
  amountCode: OrderMoneyMismatchCode,
  currencyCode: OrderMoneyMismatchCode,
) {
  const amount = row.amount_cents ?? row.gross_cents ?? row.total_gross_cents;
  if (!Number.isSafeInteger(amount) || amount !== order.total_cents) mismatches.push(amountCode);
  if (!row.currency || normalizeCurrency(row.currency) !== normalizeCurrency(order.currency)) mismatches.push(currencyCode);
}

function orderMode(
  order: PaidOrderMoneyRow,
  cycleNumber: number | undefined,
  mismatches: OrderMoneyMismatchCode[],
): OrderMoneyReconciliationMode {
  if (order.mode === "one_time") return "one_time";
  if (!Number.isSafeInteger(cycleNumber) || Number(cycleNumber) < 1) mismatches.push("subscription_cycle_missing");
  return cycleNumber === 1 ? "subscription_initial" : "subscription_renewal";
}

function ledger(id: string, amountCents: number | null, currency: string | null): MoneyLedgerValue {
  return { id, amountCents, currency: currency ? normalizeCurrency(currency) : null };
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

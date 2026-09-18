import { randomUUID } from "node:crypto";
import type { OrderMoneyReconciliationRows } from "../server/adapters/supabase/platform/orderMoneyReconciliationRows.ts";
import {
  requireOrderMoneyEvidence,
  type OrderMoneyReconciliationEvidenceFixture,
} from "./order-money-reconciliation-local-rehearsal-contracts.ts";

const MONEY = {
  subtotalCents: 10_000,
  discountCents: 1_000,
  shippingCents: 1_500,
  shippingDiscountCents: 500,
  totalCents: 10_000,
  totalNetCents: 9_259,
  taxCents: 741,
} as const;

type Scenario = "healthy" | "unavailable_one_time" | "unavailable_initial" | "mismatch_renewal";

export function createExactHeadOrderMoneyEvidenceFixture(
  namespace = `canonical-money-reconciliation-${randomUUID()}`,
): OrderMoneyReconciliationEvidenceFixture {
  const safeNamespace = normalizeNamespace(namespace);
  const healthy = scenarioRows(safeNamespace, "healthy");
  const unavailableOneTime = scenarioRows(safeNamespace, "unavailable_one_time");
  const unavailableInitial = scenarioRows(safeNamespace, "unavailable_initial");
  const mismatchRenewal = scenarioRows(safeNamespace, "mismatch_renewal");
  const rows = mergeRows(healthy, unavailableOneTime, unavailableInitial, mismatchRenewal);
  let cleaned = false;

  return {
    namespace: safeNamespace,
    ids: {
      healthyOrderId: healthy.orders[0].id,
      unavailableByMode: {
        one_time: unavailableOneTime.orders[0].id,
        subscription_initial: unavailableInitial.orders[0].id,
        subscription_renewal: mismatchRenewal.orders[0].id,
      },
      mismatchOrderId: mismatchRenewal.orders[0].id,
    },
    async loadRows() {
      requireOrderMoneyEvidence(!cleaned, "fixture was already cleaned");
      return structuredClone(rows);
    },
    async cleanup() {
      cleaned = true;
    },
  };
}

function scenarioRows(namespace: string, scenario: Scenario): OrderMoneyReconciliationRows {
  const isInitial = scenario === "unavailable_initial";
  const isRenewal = scenario === "mismatch_renewal";
  const subscription = isInitial || isRenewal;
  const suffix = `${namespace}:${scenario}`;
  const orderId = `${suffix}:order`;
  const itemId = `${suffix}:item`;
  const intentId = `${suffix}:intent`;
  const attemptId = `${suffix}:attempt`;
  const paymentId = `${suffix}:payment`;
  const invoiceId = `${suffix}:invoice`;
  const cycleId = subscription ? `${suffix}:cycle` : null;
  const providerPaymentId = `${suffix}:provider-payment`;

  return {
    orders: [{
      id: orderId,
      order_number: `EVIDENCE-${scenario}`,
      mode: subscription ? "subscription_cycle" : "one_time",
      status: "paid",
      subtotal_cents: MONEY.subtotalCents,
      discount_cents: MONEY.discountCents,
      shipping_cents: MONEY.shippingCents,
      shipping_discount_cents: MONEY.shippingDiscountCents,
      tax_cents: MONEY.taxCents,
      total_cents: MONEY.totalCents,
      currency: "PLN",
      subscription_cycle_id: cycleId,
      updated_at: "2026-07-14T11:00:00.000Z",
    }],
    items: [{
      id: itemId,
      order_id: orderId,
      allocation_ordinal: 1,
      quantity: 2,
      total_cents: MONEY.subtotalCents,
      discount_allocated_cents: MONEY.discountCents,
      effective_total_cents: 9_000,
      effective_net_cents: 8_333,
      vat_rate_bps: 800,
    }],
    cycles: cycleId ? [{ id: cycleId, cycle_number: isInitial ? 1 : 2 }] : [],
    intents: [{
      id: intentId,
      order_id: orderId,
      payment_id: paymentId,
      status: "succeeded",
      amount_cents: isRenewal ? MONEY.totalCents - 1 : MONEY.totalCents,
      currency: "PLN",
      active_attempt_id: attemptId,
      provider_payment_id: providerPaymentId,
      updated_at: "2026-07-14T11:00:00.000Z",
    }],
    attempts: [{
      id: attemptId,
      payment_intent_id: intentId,
      provider: "tpay",
      status: "succeeded",
      amount_cents: MONEY.totalCents,
      currency: "PLN",
      provider_attempt_id: providerPaymentId,
    }],
    events: [{
      id: `${suffix}:event`,
      provider: "tpay",
      provider_event_id: `${suffix}:provider-event`,
      provider_payment_id: providerPaymentId,
      payment_intent_id: intentId,
      payment_attempt_id: attemptId,
      event_type: "payment.succeeded",
      amount_cents: MONEY.totalCents,
      currency: "PLN",
      signature_verified: true,
    }],
    reconciliations: [],
    settlements: scenario === "healthy" ? [{
      id: `${suffix}:settlement`,
      created_at: "2026-07-14T11:30:00.000Z",
      batch_id: `${suffix}:batch`,
      provider_kind: "tpay",
      provider_payment_id: providerPaymentId,
      payment_intent_id: intentId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      status: "matched",
      gross_cents: MONEY.totalCents,
      currency: "PLN",
      evidence: { providerReadbackSource: "provider_api" },
    }] : [],
    invoices: [{
      id: invoiceId,
      order_id: orderId,
      invoice_ref: `${suffix}:invoice-ref`,
      status: "issued",
      correction_of_invoice_id: null,
      provider_kind: "fakturownia",
      provider_invoice_id: `${suffix}:provider-invoice`,
      blocked_reason: null,
      total_gross_cents: MONEY.totalCents,
      total_net_cents: MONEY.totalNetCents,
      currency: "PLN",
      lines_snapshot: canonicalInvoicePositions(itemId),
      metadata: {},
      created_at: "2026-07-14T11:05:00.000Z",
      updated_at: "2026-07-14T11:05:00.000Z",
      ksef_status: "not_required",
    }],
    fulfillment: [],
  };
}

function canonicalInvoicePositions(orderItemId: string): unknown[] {
  return [{
    positionKind: "item",
    orderItemId,
    allocationOrdinal: 1,
    name: "Evidence item",
    quantity: 2,
    catalogTotalGrossMinor: MONEY.subtotalCents,
    discountAllocatedMinor: MONEY.discountCents,
    unitGrossMinor: 4_500,
    unitNetMinor: 4_167,
    totalGrossMinor: 9_000,
    totalNetMinor: 8_333,
    vatRate: "8",
    vatRateBps: 800,
  }, {
    positionKind: "delivery",
    orderItemId: null,
    name: "Dostawa",
    quantity: 1,
    shippingGrossMinor: MONEY.shippingCents,
    shippingDiscountMinor: MONEY.shippingDiscountCents,
    unitGrossMinor: 1_000,
    unitNetMinor: 926,
    totalGrossMinor: 1_000,
    totalNetMinor: 926,
    vatRate: "8",
    vatRateBps: 800,
  }];
}

function mergeRows(...fixtures: OrderMoneyReconciliationRows[]): OrderMoneyReconciliationRows {
  return {
    orders: fixtures.flatMap((row) => row.orders),
    items: fixtures.flatMap((row) => row.items),
    cycles: fixtures.flatMap((row) => row.cycles),
    intents: fixtures.flatMap((row) => row.intents),
    attempts: fixtures.flatMap((row) => row.attempts),
    events: fixtures.flatMap((row) => row.events),
    reconciliations: fixtures.flatMap((row) => row.reconciliations),
    settlements: fixtures.flatMap((row) => row.settlements),
    invoices: fixtures.flatMap((row) => row.invoices),
    fulfillment: fixtures.flatMap((row) => row.fulfillment),
  };
}

function normalizeNamespace(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  requireOrderMoneyEvidence(normalized.length >= 8, "fixture namespace must contain at least 8 safe characters");
  return normalized.slice(0, 72);
}

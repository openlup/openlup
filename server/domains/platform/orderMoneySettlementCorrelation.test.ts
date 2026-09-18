import { describe, expect, it } from "vitest";
import type {
  AccountingInvoiceMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderSettlementMoneyRow,
} from "../../adapters/supabase/platform/orderMoneyReconciliationRows.js";
import { correlateSettlementRows } from "./orderMoneySettlementCorrelation.js";

describe("settlement row correlation", () => {
  it("resolves provider-reference-only rows through current intents and historical attempts", () => {
    const intents = [paymentIntent("intent-final", "order-final", "provider-final")];
    const attempts = [paymentAttempt("attempt-prior", "intent-final", "provider-prior")];
    const rows = [
      settlement("settlement-final", "provider-final"),
      settlement("settlement-prior", "provider-prior"),
    ];

    expect(correlateSettlementRows(rows, intents, attempts, [])).toEqual([
      expect.objectContaining({
        id: "settlement-final",
        payment_intent_id: "intent-final",
        correlation_issue: undefined,
      }),
      expect.objectContaining({
        id: "settlement-prior",
        payment_intent_id: "intent-final",
        correlation_issue: undefined,
      }),
    ]);
  });

  it("uses a direct link to disambiguate an invoice shared by multiple intents", () => {
    const intents = [
      paymentIntent("intent-first", "order-shared", "provider-first"),
      paymentIntent("intent-retry", "order-shared", "provider-retry"),
    ];
    const row = settlement("settlement-first", "provider-first", {
      payment_intent_id: "intent-first",
      invoice_id: "invoice-shared",
    });

    const result = correlateSettlementRows(
      [row],
      intents,
      [],
      [invoice("invoice-shared", "order-shared")],
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "settlement-first",
        payment_intent_id: "intent-first",
        correlation_issue: undefined,
      }),
    ]);
  });

  it("clones conflicting references to every candidate with a correlation issue", () => {
    const intents = [
      paymentIntent("intent-direct", "order-direct", "provider-direct"),
      paymentIntent("intent-provider", "order-provider", "provider-conflict"),
    ];
    const row = settlement("settlement-conflict", "provider-conflict", {
      payment_intent_id: "intent-direct",
    });

    const result = correlateSettlementRows([row], intents, [], []);

    expect(result.map(({ payment_intent_id, correlation_issue }) => ({
      payment_intent_id,
      correlation_issue,
    }))).toEqual([
      { payment_intent_id: "intent-direct", correlation_issue: "conflicting_links" },
      { payment_intent_id: "intent-provider", correlation_issue: "conflicting_links" },
    ]);
  });

  it("throws when no settlement link resolves to a candidate intent", () => {
    const row = settlement("settlement-unresolved", "provider-unknown");

    expect(() => correlateSettlementRows([row], [], [], []))
      .toThrow("order_money_settlement_correlation_unresolved:settlement-unresolved");
  });
});

function paymentIntent(
  id: string,
  orderId: string,
  providerPaymentId: string,
): PaymentIntentMoneyRow {
  return {
    id,
    order_id: orderId,
    payment_id: `payment-${id}`,
    status: "succeeded",
    amount_cents: 1000,
    currency: "PLN",
    active_attempt_id: null,
    provider_payment_id: providerPaymentId,
    updated_at: "2026-07-14T10:00:00.000Z",
  };
}

function paymentAttempt(
  id: string,
  paymentIntentId: string,
  providerAttemptId: string,
): PaymentAttemptMoneyRow {
  return {
    id,
    payment_intent_id: paymentIntentId,
    provider: "tpay",
    status: "failed",
    amount_cents: 1000,
    currency: "PLN",
    provider_attempt_id: providerAttemptId,
  };
}

function settlement(
  id: string,
  providerPaymentId: string,
  overrides: Partial<ProviderSettlementMoneyRow> = {},
): ProviderSettlementMoneyRow {
  return {
    id,
    created_at: "2026-07-14T10:00:00.000Z",
    batch_id: "batch-1",
    provider_kind: "tpay",
    provider_payment_id: providerPaymentId,
    payment_intent_id: null,
    payment_id: null,
    invoice_id: null,
    status: "matched",
    gross_cents: 1000,
    currency: "PLN",
    evidence: { providerReadbackSource: "provider_api" },
    ...overrides,
  };
}

function invoice(id: string, orderId: string): AccountingInvoiceMoneyRow {
  return {
    id,
    order_id: orderId,
    status: "issued",
    correction_of_invoice_id: null,
    provider_invoice_id: `provider-${id}`,
    total_gross_cents: 1000,
    total_net_cents: 926,
    currency: "PLN",
    lines_snapshot: [],
  };
}

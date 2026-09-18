import { describe, expect, it } from "vitest";
import { reconcileProviderSettlement } from "./orderMoneySettlementEvidence.js";
import type {
  PaidOrderMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderSettlementMoneyRow,
} from "../../adapters/supabase/platform/orderMoneyReconciliationRows.js";
import type { OrderMoneyMismatchCode } from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";

describe("order money settlement reconciliation", () => {
  it("does not let the newest matched import hide an older confirmed mismatch", () => {
    const input = fixture();
    input.rows.unshift(settlement({
      id: "settlement-older-mismatch",
      created_at: "2026-07-12T12:00:00.000Z",
      gross_cents: 9_999,
      status: "mismatch",
    }));

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement).toMatchObject({ state: "mismatch", id: "settlement-older-mismatch" });
    expect(result.providerSettlement).toMatchObject({ state: "mismatch", id: "settlement-older-mismatch" });
    expect(input.mismatches).toEqual(expect.arrayContaining([
      "provider_settlement_amount",
    ]));
  });

  it("pages on an untrusted local mismatch while keeping provider readback unavailable", () => {
    const input = fixture();
    input.rows = [settlement({
      evidence: { source: "manual_entry" },
      gross_cents: 9_999,
    })];

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement).toMatchObject({ state: "mismatch", amountCents: 9_999 });
    expect(result.providerSettlement).toEqual({
      state: "unsupported",
      reason: "provider_settlement_import_unsupported:tpay",
    });
    expect(input.mismatches).toContain("provider_settlement_amount");
  });

  it("treats a wrong-only untrusted reference as a local mismatch", () => {
    const input = fixture();
    input.rows = [settlement({
      provider_payment_id: "provider-payment-wrong",
      evidence: { source: "manual_entry" },
    })];

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement).toMatchObject({ state: "mismatch", id: "settlement-current" });
    expect(result.providerSettlement).toEqual({
      state: "unsupported",
      reason: "provider_settlement_import_unsupported:tpay",
    });
    expect(input.mismatches).toContain("provider_settlement_payment_ref");
  });

  it("keeps history for prior failed attempt references unavailable", () => {
    const input = fixture();
    input.intentAttempts.unshift(attempt({
      id: "attempt-prior",
      status: "failed",
      provider_attempt_id: "provider-payment-prior",
    }));
    input.rows = [settlement({ provider_payment_id: "provider-payment-prior" })];

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement).toEqual({
      state: "not_applicable",
      reason: "local_settlement_prior_failed_attempt_only",
    });
    expect(result.providerSettlement).toEqual({
      state: "unsupported",
      reason: "provider_settlement_import_unsupported:tpay",
    });
    expect(input.mismatches).toEqual([]);
  });

  it("keeps clean bank-pending rows unavailable in both layers", () => {
    const input = fixture();
    input.rows = [settlement({ status: "bank_pending" })];

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement).toEqual({ state: "pending", reason: "local_settlement_pending" });
    expect(result.providerSettlement).toEqual({
      state: "pending",
      reason: "trusted_provider_settlement_pending",
    });
    expect(input.mismatches).toEqual([]);
  });

  it("uses a later matched import after a clean pending observation", () => {
    const input = fixture();
    input.rows.unshift(settlement({
      id: "settlement-older-pending",
      created_at: "2026-07-12T12:00:00.000Z",
      status: "bank_pending",
    }));

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement).toMatchObject({ state: "matched", id: "settlement-current" });
    expect(result.providerSettlement).toMatchObject({ state: "matched", id: "settlement-current" });
    expect(input.mismatches).toEqual([]);
  });

  it("classifies missing Stripe payout proof as pending and then overdue without a mismatch", () => {
    const input = fixture();
    input.rows = [];
    input.attempt.provider = "stripe";
    input.attempt.updated_at = "2026-07-13T12:00:00.000Z";

    expect(reconcileProviderSettlement(input).providerSettlement).toEqual({
      state: "pending",
      reason: "trusted_provider_settlement_pending",
    });

    input.now = new Date("2026-07-28T12:00:00.000Z");
    expect(reconcileProviderSettlement(input).providerSettlement).toEqual({
      state: "overdue",
      reason: "trusted_provider_settlement_overdue",
    });
    expect(input.mismatches).toEqual([]);
  });

  it("keeps rehearsal settlement readback not applicable", () => {
    const input = fixture();
    input.rows = [];
    input.attempt.provider = "hidden_rehearsal";

    expect(reconcileProviderSettlement(input).providerSettlement).toEqual({
      state: "not_applicable",
      reason: "provider_settlement_not_applicable",
    });
  });

  it("marks conflicting local ledger links as a confirmed mismatch", () => {
    const input = fixture();
    input.rows[0].correlation_issue = "conflicting_links";

    const result = reconcileProviderSettlement(input);

    expect(result.localSettlement.state).toBe("matched");
    expect(input.mismatches).toContain("provider_settlement_correlation");
  });
});

function fixture(): {
  rows: ProviderSettlementMoneyRow[];
  order: PaidOrderMoneyRow;
  intent: PaymentIntentMoneyRow;
  attempt: PaymentAttemptMoneyRow;
  intentAttempts: PaymentAttemptMoneyRow[];
  mismatches: OrderMoneyMismatchCode[];
  now: Date;
} {
  const succeededAttempt = attempt();
  return {
    rows: [settlement()],
    order: {
      id: "order-one",
      order_number: "OPENLUP-ONE",
      mode: "one_time",
      status: "paid",
      subtotal_cents: 10_000,
      discount_cents: 0,
      shipping_cents: 0,
      shipping_discount_cents: 0,
      tax_cents: 1_870,
      total_cents: 10_000,
      currency: "PLN",
      subscription_cycle_id: null,
      updated_at: "2026-07-13T12:00:00.000Z",
    },
    intent: {
      id: "intent-one",
      order_id: "order-one",
      payment_id: "payment-one",
      status: "succeeded",
      amount_cents: 10_000,
      currency: "PLN",
      active_attempt_id: succeededAttempt.id,
      provider_payment_id: "provider-payment-final",
      updated_at: "2026-07-13T12:00:00.000Z",
    },
    attempt: succeededAttempt,
    intentAttempts: [succeededAttempt],
    mismatches: [],
    now: new Date("2026-07-13T12:00:00.000Z"),
  };
}

function attempt(overrides: Partial<PaymentAttemptMoneyRow> = {}): PaymentAttemptMoneyRow {
  return {
    id: "attempt-current",
    payment_intent_id: "intent-one",
    provider: "tpay",
    status: "succeeded",
    amount_cents: 10_000,
    currency: "PLN",
    provider_attempt_id: "provider-payment-final",
    ...overrides,
  };
}

function settlement(overrides: Partial<ProviderSettlementMoneyRow> = {}): ProviderSettlementMoneyRow {
  return {
    id: "settlement-current",
    created_at: "2026-07-13T12:00:00.000Z",
    batch_id: "batch-current",
    provider_kind: "tpay",
    provider_payment_id: "provider-payment-final",
    payment_intent_id: "intent-one",
    payment_id: "payment-one",
    invoice_id: null,
    status: "matched",
    gross_cents: 10_000,
    currency: "PLN",
    evidence: { providerReadbackSource: "provider_api" },
    ...overrides,
  };
}

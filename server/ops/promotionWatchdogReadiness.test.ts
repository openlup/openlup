import { describe, expect, it } from "vitest";
import { promotionWatchdogReady } from "./promotionWatchdogReadiness.js";
import {
  isStagingSyntheticCanonicalMoneyDecision,
  normalizeStagingSyntheticMoneyDecision,
} from "./promotionWatchdogReadiness.js";

describe("promotion watchdog readiness", () => {
  it("requires enabled health, claim sweep and error-free evidence", () => {
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [],
    })).toBe(true);
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [{ dedupeKey: "canonical_order_money_mismatch:order" }],
    })).toBe(false);
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: false,
      claimSweepEnabled: true,
      decisions: [],
    })).toBe(false);
  });

  it("does not let persistent staging fixtures block promotion readiness", () => {
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [{
        dedupeKey: "canonical_order_money_mismatch:rehearsal",
        payload: { orderRef: "HP-REHEARSAL", paymentProvider: "hidden_rehearsal" },
      }, {
        dedupeKey: "canonical_order_money_mismatch:account-fixture",
        payload: { orderRef: "HP-ACC-customer-account-fixture", paymentProvider: null },
      }],
    })).toBe(true);
  });

  it("does not let no-op provider rehearsal checkouts block promotion readiness", () => {
    // Staging rehearsal checkouts run the real checkout, so they carry ordinary
    // `OPENLUP-*` references; only the no-op provider identifies them.
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [{
        dedupeKey: "canonical_order_money_mismatch:rehearsal-checkout",
        payload: {
          orderRef: "OPENLUP-0D2640D8",
          paymentProvider: "hidden_rehearsal",
          mismatchCodes: ["trusted_provider_event_missing"],
        },
      }, {
        dedupeKey: "canonical_order_money_mismatch:noop-checkout",
        payload: {
          orderRef: "OPENLUP-138FD9A9",
          paymentProvider: "noop_payment",
          mismatchCodes: ["trusted_provider_event_missing", "provider_settlement_status"],
        },
      }],
    })).toBe(true);
  });

  it("keeps money drift beyond the no-op provider shape blocking on staging", () => {
    for (const mismatchCodes of [
      ["trusted_provider_event_missing", "invoice_positions_invalid"],
      ["attempt_amount"],
      ["promotion_product_total"],
      [],
    ]) {
      expect(promotionWatchdogReady({
        environment: "staging",
        healthEnabled: true,
        claimSweepEnabled: true,
        decisions: [{
          dedupeKey: "canonical_order_money_mismatch:rehearsal-with-drift",
          payload: {
            orderRef: "OPENLUP-0D2640D8",
            paymentProvider: "hidden_rehearsal",
            mismatchCodes,
          },
        }],
      })).toBe(false);
    }
  });

  it("keeps production, unknown and ordinary staging money mismatches fail-closed", () => {
    for (const environment of ["production", "unknown"]) {
      expect(promotionWatchdogReady({
        environment,
        healthEnabled: true,
        claimSweepEnabled: true,
        decisions: [{
          dedupeKey: "canonical_order_money_mismatch:fixture-shaped",
          payload: { orderRef: "HP-ACC-fixture", paymentProvider: "hidden_rehearsal" },
        }],
      })).toBe(false);
    }
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [{
        dedupeKey: "canonical_order_money_mismatch:real-order",
        payload: { orderRef: "OPENLUP-REAL", paymentProvider: "tpay" },
      }],
    })).toBe(false);
    // The fallback provider alone excuses nothing: without mismatch-code
    // evidence there is no proof the finding is structural.
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [{
        dedupeKey: "canonical_order_money_mismatch:real-order-fallback-provider",
        payload: { orderRef: "OPENLUP-REAL", paymentProvider: "hidden_rehearsal" },
      }],
    })).toBe(false);
    for (const environment of ["production", "unknown"]) {
      expect(promotionWatchdogReady({
        environment,
        healthEnabled: true,
        claimSweepEnabled: true,
        decisions: [{
          dedupeKey: "canonical_order_money_mismatch:prod-no-op-provider",
          payload: {
            orderRef: "OPENLUP-REAL",
            paymentProvider: "hidden_rehearsal",
            mismatchCodes: ["trusted_provider_event_missing"],
          },
        }],
      })).toBe(false);
    }
    expect(promotionWatchdogReady({
      environment: "staging",
      healthEnabled: true,
      claimSweepEnabled: true,
      decisions: [{
        dedupeKey: "canonical_order_money_mismatch:hp-real-provider",
        payload: { orderRef: "HP-REAL", paymentProvider: "tpay" },
      }],
    })).toBe(false);
  });

  it("keeps promotion and claim-sweep failures blocking on staging", () => {
    for (const dedupeKey of ["promotion_code_capacity_excess", "job_missed:promotion-claim-sweep"]) {
      expect(promotionWatchdogReady({
        environment: "staging",
        healthEnabled: true,
        claimSweepEnabled: true,
        decisions: [{ dedupeKey }],
      })).toBe(false);
    }
  });

  it("classifies only exact staging synthetic canonical-money decisions", () => {
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:rehearsal",
      payload: { orderRef: "HP-REHEARSAL", paymentProvider: "hidden_rehearsal" },
    })).toBe(true);
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:account-fixture",
      payload: { orderRef: "HP-ACC-fixture", paymentProvider: null },
    })).toBe(true);
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:real-order-fallback-provider",
      payload: { orderRef: "OPENLUP-REAL", paymentProvider: "hidden_rehearsal" },
    })).toBe(false);
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:rehearsal-checkout",
      payload: {
        orderRef: "OPENLUP-REAL",
        paymentProvider: "hidden_rehearsal",
        mismatchCodes: ["trusted_provider_event_missing"],
      },
    })).toBe(true);
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:rehearsal-checkout-with-drift",
      payload: {
        orderRef: "OPENLUP-REAL",
        paymentProvider: "hidden_rehearsal",
        mismatchCodes: ["trusted_provider_event_missing", "invoice_amount"],
      },
    })).toBe(false);
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:hp-real-provider",
      payload: { orderRef: "HP-REAL", paymentProvider: "tpay" },
    })).toBe(false);
    expect(isStagingSyntheticCanonicalMoneyDecision("production", {
      dedupeKey: "canonical_order_money_mismatch:fixture-shaped",
      payload: { orderRef: "HP-ACC-fixture", paymentProvider: "hidden_rehearsal" },
    })).toBe(false);
    expect(isStagingSyntheticCanonicalMoneyDecision("staging", {
      dedupeKey: "promotion_code_capacity_excess",
      payload: { orderRef: "HP-ACC-fixture", paymentProvider: "hidden_rehearsal" },
    })).toBe(false);
  });

  it("downgrades staging synthetic canonical-money decisions into non-pageable diagnostics", () => {
    const decision = normalizeStagingSyntheticMoneyDecision("staging", {
      dedupeKey: "canonical_order_money_mismatch:fixture",
      severity: "p1",
      owner: "commerce/payment-accounting",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      title: "Canonical order money ledger mismatch",
      message: "fixture has confirmed cross-ledger money mismatches.",
      channels: ["webhook"],
      payload: { orderRef: "HP-ACC-fixture", paymentProvider: null, orderId: "fixture" },
    });

    expect(decision).toMatchObject({
      dedupeKey: "canonical_order_money_mismatch:fixture",
      severity: "p3",
      paging: "never",
      payload: {
        orderRef: "HP-ACC-fixture",
        paymentProvider: null,
        stagingSyntheticFixture: true,
        originalSeverity: "p1",
      },
    });
  });
});

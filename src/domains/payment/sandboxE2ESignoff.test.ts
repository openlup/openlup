import { describe, expect, it } from "vitest";
import {
  PSP_SANDBOX_E2E_CASES,
  evaluatePspSandboxE2ESignoff,
  type PspSandboxE2ECaseEvidence,
} from "./sandboxE2ESignoff";

describe("PSP sandbox E2E sign-off gate", () => {
  it("blocks public activation when any sandbox journey is missing or not passed", () => {
    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: true,
      cases: [{
        caseId: "stripe_one_time",
        status: "passed",
        providerDashboardEvidence: "Stripe dashboard event evt_1",
        localDatabaseEvidence: "payment_intent intent_1 succeeded",
      }],
    });

    expect(decision.readyForPublicActivationPlan).toBe(false);
    expect(decision.missingCases).toContain("tpay_recurring_charge");
    expect(decision.reasons).toContain("public activation is blocked until every sandbox E2E case passes with evidence");
  });

  it("requires both provider dashboard evidence and local DB evidence for every passed journey", () => {
    const cases = allPassedCases();
    cases[0] = {
      ...cases[0],
      providerDashboardEvidence: "",
    };

    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: false,
      cases,
    });

    expect(decision.readyForPublicActivationPlan).toBe(false);
    expect(decision.missingEvidenceCases).toEqual(["stripe_one_time"]);
  });

  it("allows a separate public activation plan only after every sandbox journey has evidence", () => {
    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: false,
      cases: allPassedCases(),
    });

    expect(decision).toEqual({
      readyForPublicActivationPlan: true,
      missingCases: [],
      failedCases: [],
      missingEvidenceCases: [],
      reasons: [],
    });
  });

  it("with providerScope=stripe, signs off when all stripe-tagged + cross-provider cases pass", () => {
    const stripeAndCrossCases = allPassedCases().filter((c) =>
      ["stripe_one_time", "stripe_reusable_method", "stripe_off_session_requires_recovery",
       "missing_webhook_then_reconciliation", "duplicate_submit", "late_success_after_timeout"].includes(c.caseId),
    );

    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: true,
      providerScope: ["stripe"],
      cases: stripeAndCrossCases,
    });

    expect(decision.readyForPublicActivationPlan).toBe(true);
    expect(decision.missingCases).toEqual([]);
    expect(decision.failedCases).toEqual([]);
  });

  it("with providerScope=stripe, surfaces only stripe-relevant missing cases (no tpay noise)", () => {
    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: true,
      providerScope: ["stripe"],
      cases: [{
        caseId: "stripe_one_time",
        status: "passed",
        providerDashboardEvidence: "evt_1",
        localDatabaseEvidence: "intent_1 succeeded",
      }],
    });

    expect(decision.readyForPublicActivationPlan).toBe(false);
    expect(decision.missingCases).not.toContain("tpay_blik_one_time");
    expect(decision.missingCases).not.toContain("tpay_recurring_charge");
    expect(decision.missingCases).toContain("stripe_reusable_method");
    expect(decision.missingCases).toContain("missing_webhook_then_reconciliation");
  });

  it("with providerScope=tpay, signs off when all tpay-tagged + cross-provider cases pass", () => {
    const tpayAndCrossCases = allPassedCases().filter((c) => TPAY_AND_CROSS_CASE_IDS.has(c.caseId));

    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: true,
      providerScope: ["tpay"],
      cases: tpayAndCrossCases,
    });

    expect(decision.readyForPublicActivationPlan).toBe(true);
    expect(decision.missingCases).toEqual([]);
    expect(decision.failedCases).toEqual([]);
  });

  it("with providerScope=tpay, surfaces only tpay-relevant missing cases (no stripe noise)", () => {
    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: true,
      providerScope: ["tpay"],
      cases: [{
        caseId: "tpay_blik_one_time",
        status: "passed",
        providerDashboardEvidence: "Tpay dashboard transaction TR-1",
        localDatabaseEvidence: "commerce_payment_intents intent_1 succeeded",
      }],
    });

    expect(decision.readyForPublicActivationPlan).toBe(false);
    expect(decision.missingCases).not.toContain("stripe_one_time");
    expect(decision.missingCases).not.toContain("stripe_reusable_method");
    expect(decision.missingCases).not.toContain("stripe_off_session_requires_recovery");
    expect(decision.missingCases).toContain("tpay_blik_recurring_activation");
    expect(decision.missingCases).toContain("missing_webhook_then_reconciliation");
  });

  it("empty providerScope falls back to all-providers required (back-compat)", () => {
    const decision = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: false,
      providerScope: [],
      cases: allPassedCases(),
    });
    expect(decision.readyForPublicActivationPlan).toBe(true);
  });
});

function allPassedCases(): PspSandboxE2ECaseEvidence[] {
  return PSP_SANDBOX_E2E_CASES.map((caseId) => ({
    caseId,
    status: "passed",
    providerDashboardEvidence: `${caseId}: provider dashboard evidence`,
    localDatabaseEvidence: `${caseId}: local payment-control evidence`,
  }));
}

const TPAY_AND_CROSS_CASE_IDS = new Set<string>([
  "tpay_blik_one_time",
  "tpay_pbl_one_time",
  "tpay_blik_recurring_activation",
  "tpay_recurring_charge",
  "missing_webhook_then_reconciliation",
  "duplicate_submit",
  "late_success_after_timeout",
]);

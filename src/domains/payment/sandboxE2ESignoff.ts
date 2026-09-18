export const PSP_SANDBOX_E2E_CASES = [
  "stripe_one_time",
  "stripe_reusable_method",
  "stripe_off_session_requires_recovery",
  "tpay_blik_one_time",
  "tpay_pbl_one_time",
  "tpay_blik_recurring_activation",
  "tpay_recurring_charge",
  "missing_webhook_then_reconciliation",
  "duplicate_submit",
  "late_success_after_timeout",
] as const;

export type PspSandboxE2ECase = (typeof PSP_SANDBOX_E2E_CASES)[number];

export type PspSandboxE2ECaseStatus = "not_run" | "failed" | "passed";

export type PspSandboxE2EProvider = "stripe" | "tpay";

/**
 * Provider tagging for the canonical sandbox E2E case inventory. Used by
 * `evaluatePspSandboxE2ESignoff`'s `providerScope` filter so Stripe can sign
 * off independently of Tpay. Cross-provider cases (missing webhook, duplicate
 * submit, late success) are tagged with BOTH providers and are required as
 * soon as either provider is in scope — they exercise webhook-shaped
 * invariants that are provider-agnostic.
 */
export const PSP_SANDBOX_E2E_CASE_PROVIDERS: Record<PspSandboxE2ECase, PspSandboxE2EProvider[]> = {
  stripe_one_time: ["stripe"],
  stripe_reusable_method: ["stripe"],
  stripe_off_session_requires_recovery: ["stripe"],
  tpay_blik_one_time: ["tpay"],
  tpay_pbl_one_time: ["tpay"],
  tpay_blik_recurring_activation: ["tpay"],
  tpay_recurring_charge: ["tpay"],
  missing_webhook_then_reconciliation: ["stripe", "tpay"],
  duplicate_submit: ["stripe", "tpay"],
  late_success_after_timeout: ["stripe", "tpay"],
};

export type PspSandboxE2ECaseEvidence = {
  caseId: PspSandboxE2ECase;
  status: PspSandboxE2ECaseStatus;
  providerDashboardEvidence: string | null;
  localDatabaseEvidence: string | null;
  notes?: string | null;
};

export type PspSandboxE2ESignoffInput = {
  cases: PspSandboxE2ECaseEvidence[];
  publicActivationRequested: boolean;
  /**
   * Optional filter narrowing the case set to those tagged with at least one
   * provider in scope. Omit (or set undefined) to require every case in
   * `PSP_SANDBOX_E2E_CASES` — the original Wave 8 sign-off semantics.
   */
  providerScope?: PspSandboxE2EProvider[];
};

export type PspSandboxE2ESignoffDecision = {
  readyForPublicActivationPlan: boolean;
  missingCases: PspSandboxE2ECase[];
  failedCases: PspSandboxE2ECase[];
  missingEvidenceCases: PspSandboxE2ECase[];
  reasons: string[];
};

export function evaluatePspSandboxE2ESignoff(
  input: PspSandboxE2ESignoffInput,
): PspSandboxE2ESignoffDecision {
  const requiredCases = scopedCases(input.providerScope);
  const byCase = new Map(input.cases.map((entry) => [entry.caseId, entry]));
  const missingCases = requiredCases.filter((caseId) => !byCase.has(caseId));
  const failedCases = requiredCases.filter((caseId) => {
    const entry = byCase.get(caseId);
    return entry?.status === "failed" || entry?.status === "not_run";
  });
  const missingEvidenceCases = requiredCases.filter((caseId) => {
    const entry = byCase.get(caseId);
    if (!entry || entry.status !== "passed") return false;
    return !entry.providerDashboardEvidence?.trim() || !entry.localDatabaseEvidence?.trim();
  });
  const reasons = [
    ...missingCases.map((caseId) => `${caseId}: sandbox journey evidence missing`),
    ...failedCases.map((caseId) => `${caseId}: sandbox journey not passed`),
    ...missingEvidenceCases.map((caseId) => `${caseId}: provider dashboard and local DB evidence required`),
  ];

  if (input.publicActivationRequested && reasons.length > 0) {
    reasons.push("public activation is blocked until every sandbox E2E case passes with evidence");
  }

  return {
    readyForPublicActivationPlan: reasons.length === 0,
    missingCases,
    failedCases,
    missingEvidenceCases,
    reasons,
  };
}

function scopedCases(scope: PspSandboxE2EProvider[] | undefined): readonly PspSandboxE2ECase[] {
  if (!scope || scope.length === 0) return PSP_SANDBOX_E2E_CASES;
  const set = new Set(scope);
  return PSP_SANDBOX_E2E_CASES.filter((caseId) =>
    PSP_SANDBOX_E2E_CASE_PROVIDERS[caseId].some((provider) => set.has(provider)),
  );
}

import type {
  PspSandboxE2ECase,
  PspSandboxE2ECaseEvidence,
  PspSandboxE2ECaseStatus,
} from "./sandboxE2ESignoff.js";

export const STRIPE_ACCOUNTING_PREVIEW_PAYMENT_CASES = [
  "stripe_one_time",
  "duplicate_submit",
  "missing_webhook_then_reconciliation",
  "late_success_after_timeout",
] as const satisfies readonly PspSandboxE2ECase[];

export type StripeAccountingPreviewPaymentCase =
  (typeof STRIPE_ACCOUNTING_PREVIEW_PAYMENT_CASES)[number];

export type StripePreviewPaymentProofInput = {
  providerScope: readonly ["stripe"];
  capturedAt: string;
  previewHost: string;
  cases: StripePreviewPaymentProofCase[];
};

export type StripePreviewPaymentProofCase = {
  caseId: StripeAccountingPreviewPaymentCase;
  status: PspSandboxE2ECaseStatus;
  provider: {
    mode: "sandbox";
    paymentIntentId: string;
    dashboardEvidence: string;
    eventId?: string | null;
  };
  local: {
    orderId: string;
    paymentIntentId: string;
    paymentIntentStatus: string;
    orderPaymentStatus: string;
    provider: "stripe";
    providerPaymentId: string;
    paymentAttemptCount: number;
    providerEventId?: string | null;
    inboundEventSignatureVerified?: boolean | null;
    appliedResultStatus?: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null;
    browserReturnAppliedResult?: boolean;
    processingObservedBeforeProviderEvent?: boolean;
  };
  duplicateSubmit?: {
    checkoutSubmitCount: number;
    providerDashboardPaymentIntentCount: number;
    localProviderAttemptCount: number;
    sameProviderIdempotencyKey: boolean;
  } | null;
  recovery?: {
    source: "stripe_event_resend" | "operator_replay" | "reconciliation";
    processingObservedBeforeRecovery: boolean;
    paidObservedAfterRecovery: boolean;
  } | null;
  lateSuccess?: {
    processingOrExpiredObservedBeforeSuccess: boolean;
    successDelaySeconds: number;
    transitionRecorded: boolean;
  } | null;
  notes?: string | null;
};

export type StripePreviewPaymentProofDecision = {
  readyForAccountingPreviewPaymentProof: boolean;
  missingCases: StripeAccountingPreviewPaymentCase[];
  failedCases: StripeAccountingPreviewPaymentCase[];
  invalidCases: StripeAccountingPreviewPaymentCase[];
  reasons: string[];
  signoffCases: PspSandboxE2ECaseEvidence[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9_]+$/;
const STRIPE_EVENT_RE = /^evt_[A-Za-z0-9_]+$/;
const SECRET_SHAPE_RE =
  /(sk_(?:test|live)_[A-Za-z0-9_]+|rk_(?:test|live)_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|pi_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+|client_secret|clientSecret|authorization:\s*bearer|bearer\s+[A-Za-z0-9._-]+)/i;

export function evaluateStripeAccountingPreviewPaymentProof(
  input: StripePreviewPaymentProofInput,
): StripePreviewPaymentProofDecision {
  const reasons: string[] = [];
  const byCase = new Map(input.cases.map((entry) => [entry.caseId, entry]));
  const missingCases = STRIPE_ACCOUNTING_PREVIEW_PAYMENT_CASES.filter((caseId) => !byCase.has(caseId));
  const failedCases = STRIPE_ACCOUNTING_PREVIEW_PAYMENT_CASES.filter((caseId) => {
    const entry = byCase.get(caseId);
    return entry?.status === "failed" || entry?.status === "not_run";
  });
  const invalidCases: StripeAccountingPreviewPaymentCase[] = [];

  if (input.providerScope.length !== 1 || input.providerScope[0] !== "stripe") {
    reasons.push("providerScope must be exactly [\"stripe\"]");
  }
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    reasons.push("capturedAt must be an ISO-compatible timestamp");
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+/.test(input.previewHost)) {
    reasons.push("previewHost must be an https preview host");
  }
  if (containsSecretShape(input)) {
    reasons.push("proof payload contains secret-shaped data");
  }

  for (const caseId of missingCases) {
    reasons.push(`${caseId}: payment proof case missing`);
  }
  for (const caseId of failedCases) {
    reasons.push(`${caseId}: payment proof case not passed`);
  }

  for (const caseId of STRIPE_ACCOUNTING_PREVIEW_PAYMENT_CASES) {
    const entry = byCase.get(caseId);
    if (!entry || entry.status !== "passed") continue;
    const caseReasons = validateCase(entry);
    if (caseReasons.length > 0) {
      invalidCases.push(caseId);
      reasons.push(...caseReasons.map((reason) => `${caseId}: ${reason}`));
    }
  }

  return {
    readyForAccountingPreviewPaymentProof: reasons.length === 0,
    missingCases,
    failedCases,
    invalidCases,
    reasons,
    signoffCases: input.cases.map(toSignoffCase),
  };
}

function validateCase(entry: StripePreviewPaymentProofCase): string[] {
  const reasons: string[] = [];
  if (entry.provider.mode !== "sandbox") reasons.push("provider evidence must be Stripe sandbox mode");
  if (!STRIPE_PAYMENT_INTENT_RE.test(entry.provider.paymentIntentId)) {
    reasons.push("provider paymentIntentId must be a Stripe pi_* id");
  }
  if (!entry.provider.dashboardEvidence.trim()) reasons.push("provider dashboard evidence is required");
  if (!UUID_RE.test(entry.local.paymentIntentId)) reasons.push("local paymentIntentId must be a UUID");
  if (!UUID_RE.test(entry.local.orderId)) reasons.push("local orderId must be a UUID");
  if (entry.local.provider !== "stripe") reasons.push("local provider must be stripe");
  if (entry.local.providerPaymentId !== entry.provider.paymentIntentId) {
    reasons.push("local providerPaymentId must match Stripe PaymentIntent id");
  }
  if (entry.local.paymentIntentStatus !== "succeeded") {
    reasons.push("local payment intent must finish as succeeded");
  }
  if (!["paid", "succeeded"].includes(entry.local.orderPaymentStatus)) {
    reasons.push("local order must finish paid/succeeded");
  }
  if (entry.local.paymentAttemptCount < 1) reasons.push("local payment attempt evidence is required");
  if (entry.local.browserReturnAppliedResult === true) {
    reasons.push("browser return/callback must not apply payment result");
  }
  if (!entry.provider.eventId || !STRIPE_EVENT_RE.test(entry.provider.eventId)) {
    reasons.push("Stripe evt_* webhook/dashboard event evidence is required");
  }
  if (!entry.local.providerEventId || entry.local.providerEventId !== entry.provider.eventId) {
    reasons.push("local inbound provider event must match Stripe evt_* evidence");
  }
  if (entry.local.inboundEventSignatureVerified !== true) {
    reasons.push("local inbound event must be signature verified");
  }
  if (entry.local.appliedResultStatus !== "succeeded") {
    reasons.push("local applied result must be succeeded");
  }

  if (entry.caseId === "duplicate_submit") {
    const proof = entry.duplicateSubmit;
    if (!proof) reasons.push("duplicate-submit proof is required");
    if (proof && proof.checkoutSubmitCount < 2) reasons.push("duplicate-submit proof must show at least two submit attempts");
    if (proof && proof.providerDashboardPaymentIntentCount !== 1) {
      reasons.push("duplicate submit must create exactly one Stripe PaymentIntent");
    }
    if (proof && proof.localProviderAttemptCount !== 1) {
      reasons.push("duplicate submit must create exactly one local provider attempt");
    }
    if (proof && proof.sameProviderIdempotencyKey !== true) {
      reasons.push("duplicate submit must reuse the deterministic provider idempotency key");
    }
  }

  if (entry.caseId === "missing_webhook_then_reconciliation") {
    const proof = entry.recovery;
    if (!proof) reasons.push("missing-webhook recovery proof is required");
    if (proof && proof.processingObservedBeforeRecovery !== true) {
      reasons.push("missing-webhook proof must observe local processing before recovery");
    }
    if (proof && proof.paidObservedAfterRecovery !== true) {
      reasons.push("missing-webhook proof must observe paid after recovery/replay");
    }
  }

  if (entry.caseId === "late_success_after_timeout") {
    const proof = entry.lateSuccess;
    if (!proof) reasons.push("late-success proof is required");
    if (proof && proof.processingOrExpiredObservedBeforeSuccess !== true) {
      reasons.push("late success must observe processing/expired before success");
    }
    if (proof && proof.successDelaySeconds < 60) {
      reasons.push("late success must prove a delayed success, not an immediate webhook");
    }
    if (proof && proof.transitionRecorded !== true) {
      reasons.push("late success must include local transition evidence");
    }
  }

  return reasons;
}

function toSignoffCase(entry: StripePreviewPaymentProofCase): PspSandboxE2ECaseEvidence {
  return {
    caseId: entry.caseId,
    status: entry.status,
    providerDashboardEvidence: entry.provider.dashboardEvidence,
    localDatabaseEvidence: [
      `order ${entry.local.orderId} ${entry.local.orderPaymentStatus}`,
      `intent ${entry.local.paymentIntentId} ${entry.local.paymentIntentStatus}`,
      `providerPaymentId ${entry.local.providerPaymentId}`,
      entry.local.providerEventId ? `event ${entry.local.providerEventId}` : null,
    ].filter(Boolean).join("; "),
    notes: entry.notes ?? null,
  };
}

function containsSecretShape(value: unknown): boolean {
  if (typeof value === "string") return SECRET_SHAPE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsSecretShape);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    SECRET_SHAPE_RE.test(key) || containsSecretShape(nested),
  );
}

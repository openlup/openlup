import { stripeFailureEvidence } from "./stripeFailureEvidence.js";
import { failureEvidencePayload, type PaymentFailureEvidence } from "../paymentFailureEvidence.js";
import type { PaymentExecutionResult } from "../../../src/domains/payment/types.js";
import { declineCodeHints } from "./declineFailureHints.js";

/**
 * Normalization of a refusal the provider throws instead of returning.
 *
 * Split from the execution adapter because it is a different job: the adapter
 * creates intents and reports what came back, this reads an exception and
 * decides whether it is evidence of a refusal at all — the decision that keeps a
 * possibly-paid charge out of the terminal `failed` path.
 */

/**
 * The provider's error type for an issuer refusal, spelled exactly as the SDK
 * sets it. Exported so the decline branch and its proofs cannot drift apart.
 */
export const PROVIDER_DECLINE_ERROR_TYPE = "StripeCardError";

/** Used when the provider refuses without naming a code of its own. */
const UNSPECIFIED_DECLINE_CODE = "provider_declined";

/** What the adapter learned from a refusal: the fact itself plus its correlation handle. */
export interface ExecutionDecline {
  diagnosticFailureEvidence?: PaymentFailureEvidence;
  decline: NonNullable<PaymentExecutionResult["providerDecline"]>;
  /** The intent the provider had already created, when the refusal names one. */
  providerAttemptId: string | null;
  providerStatus: string | null;
}

/** The half of an execution result a refusal determines; the adapter owns the rest. */
type DeclinedExecutionFacts = Omit<PaymentExecutionResult, "provider" | "requestPayload">;

/**
 * Reads an issuer refusal out of a thrown provider error, or returns null.
 *
 * Deliberately narrow: only the provider's own refusal type qualifies. Codes
 * alone would not — an infrastructure error can also carry a `code`, and
 * treating one as a decline would apply a terminal `failed` result to a charge
 * that may have gone through.
 */
export function declineFromError(error: unknown): ExecutionDecline | null {
  if (!error || typeof error !== "object") return null;
  const raw = error as Record<string, unknown>;
  if (raw.type !== PROVIDER_DECLINE_ERROR_TYPE) return null;
  const intent = raw.payment_intent && typeof raw.payment_intent === "object"
    ? raw.payment_intent as Record<string, unknown>
    : null;
  const declineCode = readOptionalString(raw, "decline_code");
  const adviceCode = readOptionalString(raw, "advice_code");
  // Translated here, where the code vocabulary is owned, so the control plane
  // classifies the refusal without ever seeing an acquirer code.
  const neutralReasonHints = declineCodeHints(declineCode);
  const evidence = stripeFailureEvidence(raw, { source: "execution" });
  return {
    ...(evidence ? { diagnosticFailureEvidence: evidence } : {}),
    decline: {
      code: readOptionalString(raw, "code") ?? UNSPECIFIED_DECLINE_CODE,
      // Reserved for a payer bank that cannot hold a reusable mandate at all.
      // A refused charge on an already-registered method proves the opposite,
      // so this rail never claims it.
      mandateUnsupported: false,
      ...(declineCode ? { declineCode } : {}),
      ...(adviceCode ? { adviceCode } : {}),
      ...(neutralReasonHints.length > 0 ? { neutralReasonHints } : {}),
    },
    providerAttemptId: intent ? readOptionalString(intent, "id") ?? null : null,
    providerStatus: intent ? readOptionalString(intent, "status") ?? null : null,
  };
}

/**
 * Turns a refusal into attempt facts, DELIBERATELY without a correlation handle.
 *
 * `attemptStatus` stays non-terminal by contract — only the control plane makes
 * terminal transitions, and it does so from `providerDecline`.
 *
 * The refused intent's id is reported ONLY inside `responsePayload`, never as
 * `providerAttemptId`. That is not an oversight: event ingest matches a callback
 * to an attempt by `provider_attempt_id`, and the control plane's failed branch
 * has no guard against applying `failed` to an already-failed intent. So a
 * correlation handle would let the provider's later failure callback re-apply the
 * same refusal under its own idempotency key — advancing the retry ladder a
 * second rung, rewriting the failure reason, and sending the customer a second
 * dunning email minutes after the first. Until that branch is idempotent
 * (planned PR-0c), a refusal this rail already reported must stay uncorrelated,
 * and the callback must stay inert.
 */
export function declinedExecutionFacts(declined: ExecutionDecline): DeclinedExecutionFacts {
  const { decline, providerAttemptId, providerStatus } = declined;
  return {
    providerAttemptId: null,
    providerSessionId: null,
    attemptStatus: "processing",
    nextActionKind: null,
    providerDecline: decline,
    clientSecret: null,
    customerProviderRef: null,
    paymentMethodRef: null,
    // This rail already reported the refusal synchronously; the callback that
    // repeats it must not be waited for, and must not be able to land twice.
    webhookExpected: false,
    recoveryRequired: false,
    responsePayload: {
      // Forensics only. This payload is stored on the attempt but nothing joins
      // on it, so an operator can still trace the refused intent by hand without
      // the ingest matcher ever finding it.
      providerStatus,
      providerAttemptId,
      providerDeclined: true,
      ...failureEvidencePayload(declined.diagnosticFailureEvidence),
      // Codes only, never the provider's message: that text is free-form and can
      // carry payer-identifying detail, and this payload is persisted and logged.
      providerErrorCodes: [decline.code, decline.declineCode, decline.adviceCode].filter(
        (code): code is string => Boolean(code),
      ),
    },
  };
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

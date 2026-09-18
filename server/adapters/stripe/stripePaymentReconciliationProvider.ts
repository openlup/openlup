import { failureEvidencePayload } from "../paymentFailureEvidence.js";
import type {
  ProviderReconciliationStatus,
} from "../../domains/payment/paymentProviderReconciliationWorker.js";
import type {
  PaymentProviderRecoveryProvider,
  ProviderRecoveryAction,
} from "../../domains/payment/checkoutRecoveryPaymentResolver.js";
import { classifyDecline } from "../../shared/finalizeDeclinedAttempt.js";
import { declineCodeHints } from "./declineFailureHints.js";
import { noIssuerWasAsked } from "./stripeIntentConfirmationEvidence.js";
import type { StripeIntentLike } from "./stripeSandboxPaymentExecutionAdapter.js";

export interface StripePaymentIntentReader {
  retrievePaymentIntent(paymentIntentId: string): Promise<StripeIntentLike>;
  cancelPaymentIntent?(paymentIntentId: string): Promise<StripeIntentLike>;
}

export interface StripePaymentIntentSearcher {
  /**
   * Search Stripe PaymentIntents by a metadata key/value pair (GET
   * /v1/payment_intents/search). Every intent the payment-control adapter
   * creates carries metadata.paymentIntentId = <local intent uuid>
   * (stripeSandboxPaymentExecutionAdapter metadataFor), so this is the
   * intent-correlated absence probe for prepared attempts that never recorded
   * a provider payment id.
   */
  searchPaymentIntentsByMetadata(input: {
    key: string;
    value: string;
    limit?: number;
  }): Promise<{ ids: string[] }>;
}

export function createStripePaymentReconciliationProvider(
  client: StripePaymentIntentReader & Partial<StripePaymentIntentSearcher>,
): PaymentProviderRecoveryProvider {
  const search = client.searchPaymentIntentsByMetadata?.bind(client);
  const cancel = client.cancelPaymentIntent?.bind(client);
  return {
    resolvePaymentReference(input) {
      return input.providerAttemptId ?? input.intentProviderPaymentId ?? input.providerSessionId;
    },
    async readRecoveryPayment(input) {
      const intent = await client.retrievePaymentIntent(input.providerPaymentId);
      let status = normalizeStripeIntent(intent);
      let clientAction: ProviderRecoveryAction | null = null;
      if (intent.status === "processing" || intent.status === "requires_capture") {
        clientAction = null;
      } else if (input.purpose === "active_checkout" && noIssuerWasAsked(intent)) {
        clientAction = embeddedAction(intent.client_secret);
        // The status is lowered whether or not a form can be handed back. Our
        // inability to reopen the card panel is a fact about US; it is not an
        // issuer's refusal, and it must not be recorded as one.
        status = { ...status, status: "pending" };
      } else if (intent.status === "requires_action" || intent.status === "requires_confirmation") {
        clientAction = embeddedAction(intent.client_secret);
        // Global reconciliation treats requires_action as terminal for
        // off-session dunning. Buyer recovery is different: without a current
        // client secret it is uncertain, not permission to open a new intent.
        if (!clientAction || input.purpose === "active_checkout") {
          status = { ...status, status: "pending" };
        }
      }
      return {
        status,
        identityMatches: intent.id === input.providerPaymentId,
        configuredMoneyMatches: stripeConfiguredMoneyMatches(intent, input.attempt),
        manualReviewRequired: false,
        clientAction,
      };
    },
    async readPayment(input) {
      const intent = await client.retrievePaymentIntent(input.providerPaymentId);
      const status = normalizeStripeIntent(intent);
      // Same rule as the recovery read above, on the rail the buyer's own
      // "check it now" travels: an intent no issuer has been asked about is
      // unsettled, not refused. Only `active_checkout` gets this reading, so
      // the reconciliation worker — which names no purpose — goes on
      // terminalizing abandonment exactly as before.
      return input.purpose === "active_checkout" && noIssuerWasAsked(intent)
        ? { ...status, status: "pending" }
        : status;
    },
    ...(cancel
      ? {
        async closePayment(input): Promise<ProviderReconciliationStatus> {
          return normalizeStripeIntent(await cancel(input.providerPaymentId));
        },
      }
      : {}),
    ...(search
      ? {
        async findPaymentByLocalIntent(input): Promise<"found" | "absent"> {
          const result = await search({
            key: "paymentIntentId",
            value: input.attempt.paymentIntentId,
            limit: 1,
          });
          return result.ids.length > 0 ? "found" : "absent";
        },
      }
      : {}),
  };
}

export function normalizeStripeIntent(intent: StripeIntentLike): ProviderReconciliationStatus {
  const status = normalizeStripeStatus(intent.status);
  return {
    status,
    providerStatus: intent.status,
    occurredAt: null,
    failureReason: failureReason(intent),
    amountMinor: readAmountMinor(intent),
    currency: typeof intent.currency === "string" ? intent.currency.toUpperCase() : null,
    rawPayload: {
      provider: "stripe",
      paymentIntentId: intent.id,
      status: intent.status,
      latestChargePresent: Boolean(intent.latest_charge),
      nextActionType: intent.next_action?.type ?? null,
      lastPaymentErrorCode: intent.last_payment_error?.code ?? null,
      lastPaymentErrorType: intent.last_payment_error?.type ?? null,
      ...failureCapture(intent),
      ...failureEvidencePayload(intent.diagnosticFailureEvidence),
    },
  };
}

/**
 * The disposition of a failed intent nobody actually refused.
 *
 * Deliberately NOT a taxonomy class. The kernel classifies REFUSALS — it answers
 * "may this instrument be charged again, and by whom" — and an absence of
 * attempt is not a refusal, so an "abandonment" class would be a category error
 * inside a vocabulary whose every other member describes an issuer's verdict.
 */
export const ABANDONED_BEFORE_CONFIRMATION = "abandoned_before_confirmation";

/**
 * `requires_payment_method` on an intent that was never confirmed: no
 * `last_payment_error`, no charge. The buyer closed the tab; no issuer was ever
 * asked. Six of the fifteen production failure rows in the historical corpus are
 * this state.
 *
 * Both absences are required before the claim is made. Presence of either is
 * evidence an attempt happened, and mislabelling a real decline as abandonment
 * would silently drop it out of dunning — the more expensive of the two errors.
 */
function abandonedBeforeConfirmation(intent: StripeIntentLike): boolean {
  return intent.status === "requires_payment_method"
    && !intent.last_payment_error
    && !intent.latest_charge;
}

function embeddedAction(clientSecret: unknown): ProviderRecoveryAction | null {
  return typeof clientSecret === "string" && clientSecret.length > 0
    ? { kind: "provider_embedded", provider: "stripe", clientSecret }
    : null;
}

/**
 * The refusal evidence this rail can state, and the class it produces.
 *
 * This rail births most production failure rows, and it used to keep only
 * `last_payment_error.code` — the coarse bucket ("card_declined") — while
 * dropping `decline_code`, the fine code the adapter's hint table is written
 * against, and `advice_code`, the issuer's own retry verdict. With both gone the
 * taxonomy had nothing to read here, so the programme's classification telemetry
 * stayed empty no matter how many refusals arrived.
 *
 * Classification goes through the shared `classifyDecline` seam, the same one
 * the synchronous decline path uses, so there is exactly one place a refusal
 * becomes a class. Only neutral evidence crosses: this provider's own code
 * vocabulary is translated here, by this adapter's table, and travels no further.
 *
 * The class does not stop here. Since wave 3i-b it reaches the attempt and the
 * dunning case through the terminal write's two classification parameters, and
 * from there it becomes the cause sentence the payer is shown. It remains no
 * part of any retry cadence.
 */
function failureCapture(intent: StripeIntentLike): Record<string, unknown> {
  if (normalizeStripeStatus(intent.status) !== "failed") return {};
  if (abandonedBeforeConfirmation(intent)) {
    return { nonDeclineDisposition: ABANDONED_BEFORE_CONFIRMATION };
  }
  const declineCode = readCode(intent.last_payment_error?.decline_code);
  const adviceCode = readCode(intent.last_payment_error?.advice_code);
  const neutralReasonHints = declineCodeHints(declineCode);
  const classification = classifyDecline({
    // Correlation handle only — the kernel never reads it. The intent's own
    // status is the provider-native fact when the refusal named no code.
    code: readCode(intent.last_payment_error?.code) ?? intent.status,
    // A read of an existing intent says nothing about whether the payer's bank
    // can hold a reusable mandate, so this rail never claims it.
    mandateUnsupported: false,
    ...(declineCode ? { declineCode } : {}),
    ...(adviceCode ? { adviceCode } : {}),
    ...(neutralReasonHints.length > 0 ? { neutralReasonHints } : {}),
  }, { failureReasonKey: failureReason(intent) ?? undefined });
  return {
    declineCode: declineCode ?? null,
    adviceCode: adviceCode ?? null,
    neutralReasonHints,
    failureClass: classification.failureClass,
    failureClassDecidedBy: classification.decidedBy,
  };
}

function readCode(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripeConfiguredMoneyMatches(
  intent: StripeIntentLike,
  attempt: { amountMinor: number; currency: string },
): boolean {
  return typeof intent.amount === "number"
    && Number.isFinite(intent.amount)
    && intent.amount === attempt.amountMinor
    && typeof intent.currency === "string"
    && intent.currency.toUpperCase() === attempt.currency.toUpperCase();
}

function normalizeStripeStatus(status: string): ProviderReconciliationStatus["status"] {
  if (status === "succeeded") return "succeeded";
  if (
    status === "requires_action" ||
    status === "requires_confirmation" ||
    status === "requires_payment_method" ||
    status === "canceled"
  ) {
    return "failed";
  }
  if (status === "processing" || status === "requires_capture") return "pending";
  return "unknown";
}

function failureReason(intent: StripeIntentLike): string | null {
  const status = normalizeStripeStatus(intent.status);
  if (status !== "failed") return null;
  return intent.last_payment_error?.code
    ? `stripe_${intent.last_payment_error.code}`
    : `stripe_${intent.status}`;
}

function readAmountMinor(intent: StripeIntentLike): number | null {
  // amount_received is settlement truth only after success. For an incomplete,
  // requires-payment-method, cancelled, or requires-capture intent Stripe
  // legitimately returns 0 while `amount` still holds the configured amount.
  // Comparing that zero to the local order created a false mismatch and made
  // reconciliation 502-loop on an ordinary failed payment.
  if (intent.status === "succeeded" && typeof intent.amount_received === "number" && Number.isFinite(intent.amount_received)) {
    return intent.amount_received;
  }
  if (typeof intent.amount === "number" && Number.isFinite(intent.amount)) {
    return intent.amount;
  }
  if (typeof intent.amount_received === "number" && Number.isFinite(intent.amount_received)) {
    return intent.amount_received;
  }
  return null;
}

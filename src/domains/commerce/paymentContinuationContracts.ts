import { z } from "../../lib/validation/zod.js";
import { paymentStatusRequestSchema } from "./checkoutContracts.js";

export const checkoutContinuationJourneyIdSchema = z
  .string()
  .regex(/^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const paymentStatusContinuationRequestSchema = paymentStatusRequestSchema
  .extend({ journeyId: checkoutContinuationJourneyIdSchema.optional() })
  .strict();

export type PaymentStatusContinuationRequest = z.infer<
  typeof paymentStatusContinuationRequestSchema
>;

/**
 * How long a checkout payment continuation stays true, client and server alike.
 *
 * ⛔ This is NOT bounded by the reconciliation worker's claim threshold, which is
 * what the previous 15 minutes was reasoned from. "The cron may claim from 15
 * minutes" is only half the schedule: the adopter must configure a maximum reconciliation lag of 30 minutes or less, so an
 * attempt that becomes claimable at 15 minutes is actually claimed somewhere
 * between 15 and 45 — and for that entire span the provider-attempt admission
 * gate physically refuses a second provider call. A 15-minute marker therefore
 * expired INSIDE the window the gate was still holding, leaving the buyer with no
 * route back at all: the expired marker is discarded, and every re-submit answers
 * `provider_attempt_in_flight`. That hard dead end is what this value now covers.
 *
 * Raising it does not widen double-charge exposure by one state, because the
 * self-healing is independent of the TTL: a terminal status discards the marker on
 * the next read, and `checkoutActivePaymentActionResolver` re-verifies the attempt
 * identity before and after the provider read, so a marker can only ever be
 * redeemed against the attempt it was minted for.
 *
 * The portable invariant is provider-attempt admission, not deployment cadence. The pair pinned in
 * `checkoutPaymentContinuationCredential.test.ts` and
 * `paymentProviderReconciliationWorker.test.ts` records the relationship in code.
 */
export const CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS = 45 * 60;

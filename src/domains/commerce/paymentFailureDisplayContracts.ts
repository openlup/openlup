import { z } from "../../lib/validation/zod.js";

/** Older strict clients must opt in before the status response gains a field. */
export const PAYMENT_FAILURE_DISPLAY_HEADER = "X-Payment-Failure-Display";

/**
 * The buckets the failed-payment surfaces have copy for.
 *
 * ONE list, deliberately. Before this it was written three times: a `const` in
 * the failure page, a `Set` in the wait page, and implicitly again in whatever
 * the server happened to send. Three copies of a display vocabulary drift, and
 * the way they drifted was silent - a reason the server produced and the page
 * had never heard of rendered the generic message with no signal anywhere.
 *
 * NEUTRAL by construction. No entry names a provider, and none may: the value
 * travels in the buyer's URL, and the surfaces that read it are published
 * platform code. Provider-native reasons are translated INTO this vocabulary at
 * the edge, in `server/adapters/paymentFailureDisplay.ts`.
 *
 * Four of the six are also minted client-side by the wallet rail, which decides
 * them from a wallet error rather than from a server reason. That is why this
 * list lives in the contract rather than in either producer.
 */
export const PAYMENT_FAILURE_DISPLAY_REASONS = [
  "card_declined",
  "expired",
  "cancelled",
  // The one reason an identical retry can never fix, so its copy points at a card.
  "blik_recurring_unsupported_bank",
  "provider_declined",
  "technical",
] as const;
export type PaymentFailureDisplayReason = (typeof PAYMENT_FAILURE_DISPLAY_REASONS)[number];
export const paymentFailureDisplayReasonSchema = z.enum(PAYMENT_FAILURE_DISPLAY_REASONS);

/**
 * Why the payment-status response carries this BESIDE `failureReason` rather
 * than instead of it.
 *
 * `failureReason` is the stable provider-native identity that logs, evidence and
 * the account-recovery surfaces read, and two of those compare it to a literal.
 * This vocabulary is a display bucket and nothing else. `null` means the refusal
 * maps to no bucket, which is an instruction to say the generic thing rather
 * than a gap to fill in. An absent field means an older server: only an exact
 * member of the shared display vocabulary may then be recovered from the reason.
 */

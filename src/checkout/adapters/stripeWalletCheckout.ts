import { submitCheckout } from "@/domains/commerce/commerceClient";
import type { CheckoutRequest } from "@/domains/commerce/checkoutContracts";

import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { buildCheckoutIntent } from "@/checkout/machine/buildCheckoutIntent";
import { buildCheckoutInvoicePreference } from "@/checkout/machine/checkoutInvoicePreference";
import {
  getOrCreateCheckoutAttemptKey,
  readCheckoutPaymentAttempt,
} from "@/checkout/machine/checkoutAttemptStore";
import {
  isJourneyConsumedCheckoutError,
  rotateConsumedJourneyRequest,
} from "@/checkout/machine/checkoutJourneyConsumed";
import { recoverAmbiguousCheckoutSubmit } from "@/checkout/machine/checkoutAmbiguousSubmit";

/**
 * Build + submit a Stripe checkout for the Express Checkout (Apple Pay / Google
 * Pay) path. This is the Stripe-only mirror of the "Place order" submit in
 * `index.tsx#handleComplete` (same intent build, idempotency key, and invoice
 * preference) — kept separate so the wallet can confirm the returned
 * `clientSecret` inside its own Stripe Elements context.
 *
 * The caller is responsible for catching a disabled-checkout `BffClientError`
 * (via `isCheckoutDisabled`); a thrown error here propagates so the wallet can
 * map it to the same thank-you fallback the card path uses.
 */

export interface StripeWalletCheckoutContext {
  locale: "pl" | "en";
  subscriptionCheckoutEnabled: boolean;
  deliverySelectionEnabled: boolean;
  dhlOnlyDeliveryEnabled: boolean;
  /** Line γ seam: the composition vocabulary, threaded to `buildCheckoutIntent`. */
  knownCompositionSlugs: readonly string[];
}

export type StripeWalletCheckoutStart =
  | { kind: "disabled" }
  | { kind: "subscription_unavailable" }
  | { kind: "invoice_required" }
  | { kind: "quote_unavailable" }
  /**
   * No Stripe client context was confirmed. The stored journey key stays in
   * place, so the next wallet click can safely recover the same order.
   */
  | { kind: "retryable" }
  | { kind: "in_flight" }
  | { kind: "price_changed" }
  | { kind: "paid"; orderRef: string }
  | {
      kind: "confirm";
      clientSecret: string;
      orderId: string;
      orderRef: string;
      paymentIntentId: string;
      clientId: string;
      /** The journey this order was submitted under — after any rotation, so
       * the continuation marker names the journey that actually won. */
      journeyId: string;
    }
  | {
      kind: "status";
      orderRef: string;
      orderId?: string;
      paymentIntentId?: string;
      clientId?: string;
    };

export async function startStripeWalletCheckout(
  data: ConfiguratorFormData,
  ctx: StripeWalletCheckoutContext,
): Promise<StripeWalletCheckoutStart> {
  // A selected subscription must never fall through to the legacy disabled
  // checkout success fallback. Keep the choice intact and fail before building
  // an intent, idempotency key, or order.
  if (data.subscription && !ctx.subscriptionCheckoutEnabled) {
    return { kind: "subscription_unavailable" };
  }

  const candidateIntent = buildCheckoutIntent(data, {
    idempotencyKey: "checkout:pending",
    locale: ctx.locale,
    subscriptionCheckoutEnabled: ctx.subscriptionCheckoutEnabled,
    deliverySelectionEnabled: ctx.deliverySelectionEnabled,
    dhlOnlyDeliveryEnabled: ctx.dhlOnlyDeliveryEnabled,
    knownCompositionSlugs: ctx.knownCompositionSlugs,
  });
  if (!candidateIntent) return { kind: "disabled" };

  if (!data.checkoutQuoteExpectation) {
    return { kind: "quote_unavailable" };
  }

  const intent = {
    ...candidateIntent,
    idempotencyKey: getOrCreateCheckoutAttemptKey(candidateIntent, data.checkoutQuoteExpectation),
  };
  const paymentAttempt = readCheckoutPaymentAttempt();

  const invoicePreference = buildCheckoutInvoicePreference(data);
  if (invoicePreference === null) return { kind: "invoice_required" };

  const checkoutRequest: CheckoutRequest = {
    intent,
    ...(invoicePreference ? { invoicePreference } : {}),
    ...(data.checkoutQuoteExpectation ? { expectedQuote: data.checkoutQuoteExpectation } : {}),
    paymentProvider: "stripe" as const,
    // Keep the same journey/order after a terminal retry, but give the PSP a
    // fresh provider-attempt identity. The first attempt deliberately omits 0.
    ...(paymentAttempt > 0 ? { paymentAttemptSequence: paymentAttempt } : {}),
  };

  let requestForAttempt = checkoutRequest;
  let rotatedConsumedJourney = false;
  let result: Awaited<ReturnType<typeof submitCheckout>>;
  for (;;) {
    try {
      result = await submitCheckout(requestForAttempt);
      break;
    } catch (error) {
      // This response is authoritative and happens before we have received a
      // client secret, so it is the only condition allowed to rotate a wallet
      // journey. A second response never rotates again.
      if (isJourneyConsumedCheckoutError(error) && !rotatedConsumedJourney) {
        requestForAttempt = rotateConsumedJourneyRequest(
          candidateIntent,
          data.checkoutQuoteExpectation,
          requestForAttempt,
        );
        rotatedConsumedJourney = true;
        continue;
      }

      // A lost response or active provider attempt might have committed the
      // exact request. Read it back once under the same key; this is also
      // required after a consumed-key rotation, where `requestForAttempt` is
      // the fresh journey. It must never trigger another rotation.
      const ambiguousRecovery = await recoverAmbiguousCheckoutSubmit({
        error,
        request: requestForAttempt,
        options: null,
      });
      if (ambiguousRecovery?.kind === "recovered") {
        result = ambiguousRecovery.response;
        break;
      }
      // The in-flight refusal keeps its own identity all the way out. Flattening it
      // into `retryable` is what made the wallet the one rail that could not be
      // routed to the blocking panel.
      if (ambiguousRecovery?.kind === "in_flight") return { kind: "in_flight" };
      if (ambiguousRecovery) return { kind: "retryable" };
      throw error;
    }
  }

  if (result.status === "price_changed") {
    // The server amount is authoritative evidence that the customer's reviewed
    // quote is stale, not consent to a new amount. The configurator must return
    // to summary and obtain an independently rendered live quote before another
    // payment attempt.
    return { kind: "price_changed" };
  }

  if (result.status === "paid") {
    return { kind: "paid", orderRef: result.orderRef };
  }

  if (
    result.paymentIntentId &&
    result.clientId &&
    result.clientAction?.kind === "provider_embedded" &&
    result.clientAction.provider === "stripe" &&
    result.clientAction.clientSecret
  ) {
    return {
      kind: "confirm",
      clientSecret: result.clientAction.clientSecret,
      orderId: result.orderId,
      orderRef: result.orderRef,
      paymentIntentId: result.paymentIntentId,
      clientId: result.clientId,
      journeyId: requestForAttempt.intent.idempotencyKey,
    };
  }

  return {
    kind: "status",
    orderRef: result.orderRef,
    orderId: result.orderId,
    paymentIntentId: result.paymentIntentId,
    clientId: result.clientId,
  };
}

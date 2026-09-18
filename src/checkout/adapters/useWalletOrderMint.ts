import { useEffect, useRef } from "react";

import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import {
  startStripeWalletCheckout,
  type StripeWalletCheckoutContext,
} from "./stripeWalletCheckout";
import { dhlOnlyDeliveryEnabled } from "@/checkout/composer/deliverySelectionFlags";
import { subscriptionCheckoutContractEnabled } from "@/lib/flags";

/**
 * Mint the wallet order + PaymentIntent at most once per confirmed wallet
 * action, after Elements submission has accepted the payment details. Concurrent
 * callers share one journey-key-idempotent Promise rather than creating a second
 * order. A changed quote drops the cached mint so the next confirmation uses the
 * fresh amount. Inputs are read through a ref because Stripe can capture the
 * confirm handler on mount — avoiding a stale-quote start.
 */
export function useWalletOrderMint(
  data: ConfiguratorFormData,
  checkoutQuoteExpectation: ConfiguratorFormData["checkoutQuoteExpectation"],
  locale: StripeWalletCheckoutContext["locale"],
  /** Line γ seam: the composition vocabulary, threaded to `buildCheckoutIntent`. */
  knownCompositionSlugs: readonly string[],
) {
  const inputsRef = useRef({ data, checkoutQuoteExpectation, locale, knownCompositionSlugs });
  inputsRef.current = { data, checkoutQuoteExpectation, locale, knownCompositionSlugs };
  const promiseRef = useRef<ReturnType<typeof startStripeWalletCheckout> | null>(null);

  useEffect(() => {
    promiseRef.current = null;
  }, [checkoutQuoteExpectation]);

  return function startWalletOrder() {
    const existing = promiseRef.current;
    if (existing) return existing;
    const inputs = inputsRef.current;
    const payload = inputs.checkoutQuoteExpectation
      ? { ...inputs.data, checkoutQuoteExpectation: inputs.checkoutQuoteExpectation }
      : inputs.data;
    const ctx: StripeWalletCheckoutContext = {
      locale: inputs.locale,
      subscriptionCheckoutEnabled: subscriptionCheckoutContractEnabled(),
      deliverySelectionEnabled: true,
      dhlOnlyDeliveryEnabled: dhlOnlyDeliveryEnabled(),
      knownCompositionSlugs: inputs.knownCompositionSlugs,
    };
    const pending = startStripeWalletCheckout(payload, ctx);
    // Clear a rejected mint so the next confirmed wallet action can retry. A
    // resolved retryable readback has no client payment context either, so let
    // the next confirmation replay the same stable journey rather than caching
    // the recovery state forever.
    pending.catch(() => {
      if (promiseRef.current === pending) promiseRef.current = null;
    });
    pending.then(
      (start) => {
        if (start.kind === "retryable" && promiseRef.current === pending) {
          promiseRef.current = null;
        }
      },
      () => {},
    );
    promiseRef.current = pending;
    return pending;
  };
}

import { useMemo, useRef } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

import {
  createCustomerDiagnosticActionKeyWhenEnabled,
  loadCustomerDiagnosticReporterWhenEnabled,
} from "@/lib/flags";

/**
 * Card-setup support for the dunning recovery landing (`RecoverPaymentPage.tsx`):
 * its cached Stripe.js loader and its `account_card_setup` producer. The lifecycle
 * deliberately mirrors the account payments tab (`v2/sections/PaymentCardSetup.tsx`),
 * which keeps its own copy of the reporter: the staging customer-diagnostic
 * journey pins that copy's text in place.
 */

// Module-level cache: one Stripe.js instance per publishable key.
let cachedStripePromise: Promise<Stripe | null> | null = null;
let cachedPublishableKey: string | null = null;

export function useCardSetupStripePromise(): Promise<Stripe | null> | null {
  return useMemo(() => {
    const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey || typeof publishableKey !== "string") return null;
    if (cachedStripePromise && cachedPublishableKey === publishableKey) return cachedStripePromise;
    cachedPublishableKey = publishableKey;
    cachedStripePromise = loadStripe(publishableKey);
    return cachedStripePromise;
  }, []);
}

export interface CardSetupDiagnostic {
  /** Mints a fresh action key and reports `attempted`/`observed` for it. */
  open: () => void;
  /** Reports the one terminal for the open key and closes it; a no-op when none is open. */
  settle: (code: "succeeded" | "failed") => void;
}

/**
 * ⛔ One action key per attempt, one terminal per key.
 *
 * The Stripe form can refuse a card many times before one sticks, and each
 * refusal used to settle the SAME key `failed` — so the history showed one
 * action with several conflicting terminals, and a decline followed by a
 * successful retry read as a contradiction rather than as two attempts. The
 * key is cleared by the first terminal; a surface whose form stays mounted after
 * a refusal opens the next attempt itself, because that is where the retry starts.
 */
export function useCardSetupDiagnostic(accessToken: string | null | undefined): CardSetupDiagnostic {
  const actionKey = useRef<string | null>(null);
  return useMemo(() => ({
    open() {
      try {
        actionKey.current = createCustomerDiagnosticActionKeyWhenEnabled?.() ?? null;
      } catch {
        actionKey.current = null;
      }
      reportCardSetup("attempted", "observed", actionKey.current, accessToken);
    },
    settle(code) {
      const clientActionKey = actionKey.current;
      actionKey.current = null;
      reportCardSetup("settled", code, clientActionKey, accessToken);
    },
  }), [accessToken]);
}

function reportCardSetup(
  phase: "attempted" | "settled",
  code: "observed" | "succeeded" | "failed",
  clientActionKey: string | null,
  accessToken: string | null | undefined,
): void {
  if (!clientActionKey) return;
  try {
    void loadCustomerDiagnosticReporterWhenEnabled?.()?.then((reporter) => {
      try {
        reporter?.reportCustomerJourneyDiagnostic({
          action: "account_card_setup",
          phase,
          code,
          clientActionKey,
        }, accessToken ?? null);
      } catch {
        // Diagnostics never change card setup behavior.
      }
    }).catch(() => undefined);
  } catch {
    // Diagnostics never change card setup behavior.
  }
}

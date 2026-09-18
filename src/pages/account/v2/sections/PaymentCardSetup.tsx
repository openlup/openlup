import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CreditCard, Loader2 } from "lucide-react";
import { Elements } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

import { RecoveryPaymentSetupForm } from "@/domains/payment/components/RecoveryPaymentSetupForm";
import { startCustomerCardSetup } from "@/domains/customers/paymentMethodSetupClient";
import {
  createCustomerDiagnosticActionKeyWhenEnabled,
  loadCustomerDiagnosticReporterWhenEnabled,
} from "@/lib/flags";
import { CoralButton } from "../ui/atoms";

// Module-level cache: one Stripe.js instance per publishable key (mirrors the recovery page).
let cachedStripePromise: Promise<Stripe | null> | null = null;
let cachedPublishableKey: string | null = null;
function useStripePromise(): Promise<Stripe | null> | null {
  return useMemo(() => {
    const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey || typeof publishableKey !== "string") return null;
    if (cachedStripePromise && cachedPublishableKey === publishableKey) return cachedStripePromise;
    cachedPublishableKey = publishableKey;
    cachedStripePromise = loadStripe(publishableKey);
    return cachedStripePromise;
  }, []);
}

type Phase = "idle" | "minting" | "awaiting_card" | "saved" | "failed";

function createIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `account-card:${crypto.randomUUID()}`
    : `account-card:${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * CJ63-A — add/replace the card on a subscription from the account. Mints a session-authed
 * SetupIntent, collects a new card via the Stripe Payment Element, and lets the
 * `setup_intent.succeeded` webhook bind the new subscription-scoped method ref (charged on
 * the next renewal). No card details ever touch our servers.
 */
export function PaymentCardSetup({
  subscriptionId,
  accessToken,
  onSaved,
  inOpenRecovery = false,
}: {
  subscriptionId: string;
  accessToken: string;
  onSaved?: () => void;
  /**
   * True when this subscription has an OPEN dunning case.
   *
   * It changes only what we promise afterwards, and it has to: the default
   * confirmation says the card will be used "at your next renewal", which is
   * false here. An open case has an unpaid cycle already on the retry ladder, so
   * the next charge is that retry — sooner than a renewal, and for money the
   * payer already owes. Telling someone mid-dunning to expect nothing until
   * their next renewal invites them to close the tab on a charge that is about
   * to happen.
   */
  inOpenRecovery?: boolean;
}) {
  const { t } = useTranslation("account");
  const c = (key: string) => t(`account:dashboard.sectionsV2.payments.card.${key}`);
  const stripePromise = useStripePromise();
  const [phase, setPhase] = useState<Phase>("idle");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diagnosticActionKey = useRef<string | null>(null);

  const elementsOptions = useMemo(
    () => (clientSecret ? { clientSecret, appearance: { theme: "stripe" as const } } : null),
    [clientSecret],
  );

  /**
   * ⛔ One action key per submit, one terminal per key.
   *
   * The Stripe form can refuse a card many times before one sticks, and each
   * refusal used to settle the SAME key `failed` — so the history showed one
   * action with several conflicting terminals, and a decline followed by a
   * successful retry read as a contradiction rather than as two attempts. The
   * key is cleared by the first terminal; the form's `onError` opens the next
   * attempt itself, because that is where the buyer's retry starts.
   */
  function mintDiagnosticActionKey() {
    try {
      diagnosticActionKey.current = createCustomerDiagnosticActionKeyWhenEnabled?.() ?? null;
    } catch {
      diagnosticActionKey.current = null;
    }
    reportCardSetup("attempted", "observed", diagnosticActionKey.current, accessToken);
  }

  function settle(code: "succeeded" | "failed") {
    const clientActionKey = diagnosticActionKey.current;
    diagnosticActionKey.current = null;
    reportCardSetup("settled", code, clientActionKey, accessToken);
  }

  async function begin() {
    mintDiagnosticActionKey();
    if (!stripePromise) {
      setError(c("configMissing"));
      setPhase("failed");
      settle("failed");
      return;
    }
    setPhase("minting");
    setError(null);
    try {
      const response = await startCustomerCardSetup(accessToken, {
        subscriptionId,
        idempotencyKey: createIdempotencyKey(),
      });
      setClientSecret(response.setup.clientSecret);
      setPhase("awaiting_card");
    } catch {
      setError(c("startError"));
      setPhase("failed");
      settle("failed");
    }
  }

  function handleMethodReady() {
    setPhase("saved");
    settle("succeeded");
    onSaved?.();
  }

  if (phase === "saved") {
    return (
      <p className="rounded-control bg-teal/10 px-3 py-2 text-sm text-teal" role="status">
        {c(inOpenRecovery ? "savedInRecovery" : "saved")}
      </p>
    );
  }

  if (phase === "awaiting_card" && stripePromise && elementsOptions) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-foreground/60">{c("intro")}</p>
        <Elements stripe={stripePromise} options={elementsOptions}>
          <RecoveryPaymentSetupForm
            returnUrl={`${window.location.origin}${window.location.pathname}`}
            onMethodReady={handleMethodReady}
            onError={(message) => {
              setError(message);
              // The card was refused but the form stays mounted: this attempt is
              // over and the next one starts here, not at another button press.
              settle("failed");
              mintDiagnosticActionKey();
            }}
            copy={{ submitButton: c("submit"), submittingButton: c("submitting"), errorPrefix: c("errorPrefix") }}
          />
        </Elements>
        {error ? <p className="text-sm text-warm-coral" role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <CoralButton
        onClick={begin}
        disabled={phase === "minting"}
        icon={phase === "minting" ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <CreditCard size={16} />}
      >
        {phase === "minting" ? c("preparing") : c("replaceCta")}
      </CoralButton>
      {error ? <p className="text-sm text-warm-coral" role="alert">{error}</p> : null}
    </div>
  );
}

function reportCardSetup(
  phase: "attempted" | "settled",
  code: "observed" | "succeeded" | "failed",
  clientActionKey: string | null,
  accessToken: string,
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
        }, accessToken);
      } catch {
        // Diagnostics never change card setup behavior.
      }
    }).catch(() => undefined);
  } catch {
    // Diagnostics never change card setup behavior.
  }
}

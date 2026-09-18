import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";

import type { StripePayState } from "@/checkout/adapters/SkomponujPakietStripePayPanel";
import { bumpCheckoutPaymentAttempt } from "./checkoutAttemptStore";
import { stashCheckoutDeclineNotice } from "./checkoutDeclineNotice";
import {
  clearCheckoutContinuation,
  readCheckoutContinuation,
  paymentStatusUrlFor,
  setCheckoutContinuationPhase,
  type CheckoutContinuationContext,
} from "./checkoutNavigation";
import type { PspProviderKind } from "@/domains/payment/pspIntegrationPlan";
import { applyPendingResume, resolvePendingResume } from "./checkoutResumeGuard";
import {
  navigatePollerTerminal,
  type CheckoutTerminalStatus,
} from "./checkoutTerminalNav";
import { providerForPaymentMethod, type PaymentMethod } from "@/checkout/adapters/paymentMethodOptions";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import { verifyCommercePaymentNowBounded } from "@/domains/commerce/paymentVerifyClient";
import { useStripePendingResume } from "@/checkout/adapters/useStripePendingResume";
import { reportCustomerJourneyPayment } from "@/lib/diagnostics/customerJourneyPaymentProducer";
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";
type CardConfirmationSettlement = "succeeded" | "failed" | "unknown" | "retryable";
/**
 * A submit the buyer cannot have, because an attempt on another rail is still
 * open and only the server can close it.
 *
 * Carries the marker it was raised from so the controls need no second status
 * read: a re-resolve would pass `isContinuationExpired` first, and past the
 * 45-minute TTL that returns `discard`, destroying the very marker this state
 * exists to protect. The action behind `clientSecret` was read live moments
 * earlier, when the decision was made.
 */
export type PriorAttemptState = {
  /**
   * The rail the open attempt belongs to, or null when the refusal seam raised this
   * state and no answer names one. ⛔ Never guessed: naming the wrong rail in the
   * recap would tell the buyer to go finish a payment they never started.
   */
  provider: PspProviderKind | null;
  clientSecret: string | null;
  pending: CheckoutContinuationContext;
};
/** The blocking state plus the three routes out of it, threaded as one prop. */
export type PriorAttemptController = {
  state: PriorAttemptState | null;
  finish: () => void;
  checkStatus: () => void;
  dismiss: () => void;
};
export function useConfiguratorCheckoutTerminalRouting(input: {
  navigate: NavigateFunction;
  paths: { thankYou: string; paymentFailed: string; paymentPath: string };
  accountStatusPath?: string;
  draftScope: ConfiguratorDraftScope;
}) {
  const { navigate, paths, accountStatusPath, draftScope } = input;
  const { thankYou, paymentFailed, paymentPath } = paths;
  const [stripePay, setPaymentPanel] = useState<StripePayState | null>(null);
  const [priorAttempt, setPriorAttempt] = useState<PriorAttemptState | null>(null);
  const stripePayRef = useRef<StripePayState | null>(null);
  useEffect(() => void (stripePayRef.current = stripePay), [stripePay]);
  useStripePendingResume(stripePay, setPaymentPanel, navigate, paymentPath);

  /**
   * The SUBMIT-time twin of the mount-time resume above: what a live continuation
   * marker makes the buyer's next "order" press do. Returns `true` when the
   * submit must stop because the marker has been acted on.
   *
   * ⛔ A `reopen_embedded` decision reopens the panel HERE rather than sending
   * the buyer to the status poller. The server can still hand the same action
   * back, which means nothing is settling and there is nothing to wait on — and
   * the poller escalates to a live provider read, where an unconfirmed intent
   * answers `requires_payment_method` and the server normalizes that to a
   * terminal `failed`: a decline on an order the issuer was never asked about
   * (the 2026-08-27 checkout dead end). Reopening puts the buyer back on the
   * intent that already exists, so no second attempt is minted either.
   */
  const resumeBeforeSubmit = useCallback(async (
    /**
     * The method the buyer has chosen for THIS submit. Passing it is what lets the
     * decision notice that the marker points somewhere they no longer want to go;
     * the mount-time twin above passes nothing, so it keeps deciding on the same
     * facts it always did.
     *
     * The rail is derived HERE rather than at the call site, so the file that owns
     * resume semantics owns the mapping too and the orchestrator needs no
     * dependency on the payment-method catalog.
     */
    selectedMethod?: PaymentMethod | null,
  ): Promise<boolean> => {
    const pending = readCheckoutContinuation();
    if (!pending) return false;
    const selectedProvider = selectedMethod ? providerForPaymentMethod(selectedMethod) : null;
    return applyPendingResume(await resolvePendingResume(pending, selectedProvider), {
      reopenAction: (clientSecret) => setPaymentPanel({
        orderId: pending.orderId,
        orderRef: pending.orderRef,
        paymentIntentId: pending.paymentIntentId,
        clientId: pending.clientId,
        journeyId: pending.journeyId,
        clientSecret,
        awaitingWebhook: false,
      }),
      // ⛔ The URL is the action. This submit used to fall through to the poller
      // and throw the redirect away, which left the buyer waiting on a payment
      // that could only be completed on a page nobody sent them to.
      followRedirect: (url) => window.location.assign(url),
      waitOnStatus: () => navigate(paymentStatusUrlFor(paymentPath, pending)),
      discardMarker: clearCheckoutContinuation,
      // The server answered with nothing to act on. Act on nothing - and in
      // particular do not destroy the marker the refusal handler routes with.
      keepMarker: () => {},
      // ⛔ KEEP the marker. The previous shape here cleared it and bumped the
      // attempt sequence, on the belief that a fresh prepare key would clear the
      // anti-double-charge gate. It does not: the gate reads the intent's
      // `active_attempt_id`, the bump only suffixes a key, and every state this
      // decision fires in is a state the gate refuses. So the submit was spent on
      // `provider_attempt_in_flight` with the marker - the only thing that could
      // still reach the action or the status page - already destroyed.
      blockOnPriorAttempt: (blocked) => setPriorAttempt({ ...blocked, pending }),
      // ⛔ An unreadable status must not cost the buyer their route back. Letting
      // the submit through would spend the attempt on a `provider_attempt_in_flight`
      // refusal, and clearing the marker first would make that refusal permanent
      // until the reconciliation cron. Refuse HERE instead, keeping the marker, and
      // say the one true thing: we could not check, your details are saved, no
      // second order is created, try again. The next press re-reads the status.
      cannotCheck: () => { throw new Error("checkout:errors.timeout"); },
    });
  }, [navigate, paymentPath]);

  /**
   * Unmount the panel WITHOUT touching the continuation marker. Owned here
   * because the marker is: a back press out of the panel is not a cancellation,
   * so the marker must survive for the re-submit that reopens the same action.
   */
  const closePaymentPanel = useCallback(() => setPaymentPanel(null), []);
  /**
   * Finish the attempt that already exists, in place. Uses the `clientSecret` the
   * decision carried rather than re-resolving: see `PriorAttemptState` for why a
   * second resolve is the one thing this state must not do.
   */
  const resumePriorAttempt = useCallback(() => {
    if (!priorAttempt?.clientSecret) return;
    const { pending, clientSecret } = priorAttempt;
    setPriorAttempt(null);
    setPaymentPanel({
      orderId: pending.orderId,
      orderRef: pending.orderRef,
      paymentIntentId: pending.paymentIntentId,
      clientId: pending.clientId,
      journeyId: pending.journeyId,
      clientSecret,
      awaitingWebhook: false,
    });
  }, [priorAttempt]);

  /** Read what the open attempt is doing. The marker still carries every id. */
  const checkPriorAttemptStatus = useCallback(() => {
    if (!priorAttempt) return;
    navigate(paymentStatusUrlFor(paymentPath, priorAttempt.pending));
  }, [navigate, paymentPath, priorAttempt]);

  /**
   * Raise the blocking state from a refusal rather than from a resume decision.
   *
   * This is the seam every route into the anti-double-charge gate passes through:
   * whatever destroyed or kept the marker on the way here, a
   * `provider_attempt_in_flight` answer means an attempt is open and the buyer needs
   * the panel, not a sentence. Returns false when no marker is left to route with, so
   * the caller falls back to the message rather than rendering controls that resolve
   * to nothing.
   */
  const raisePriorAttemptFromRefusal = useCallback((): boolean => {
    const pending = readCheckoutContinuation();
    if (!pending) return false;
    // ⛔ `provider: null` is deliberate and stays. The marker does not record a
    // rail, and the refusal carries only `reason` - so there is no honest source
    // for it here, and a guessed rail would print the buyer a false name for
    // their own payment. The panel omits the rail recap when it is null. Since
    // the panel no longer replaces the step body, an unnamed rail is a missing
    // sentence rather than a dead end: the method tiles are still on screen.
    setPriorAttempt({ provider: null, clientSecret: null, pending });
    return true;
  }, []);

  /**
   * Dismiss the panel, marker untouched.
   *
   * ⚠️ This used to be the ONLY way back, because the panel replaced the step
   * body. It no longer does: the panel renders above a live step, so the tiles
   * are reachable whether or not the buyer dismisses it. Dismissing is now a
   * convenience, not the exit - which is why the 2026-09-02 P0 existed at all,
   * since dismissing only unmounted the panel and the next submit re-raised it.
   */
  const dismissPriorAttempt = useCallback(() => setPriorAttempt(null), []);

  const onConfirmSettled = useCallback(
    (status: CardConfirmationSettlement) => {
      const current = stripePayRef.current;
      if (!current) return;
      const diagnosticReporter = loadCustomerDiagnosticReporterWhenEnabled?.(), clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
      if (diagnosticReporter && clientActionKey) reportCustomerJourneyPayment("payment_confirm", status, diagnosticReporter, clientActionKey);
      if (status === "retryable") {
        // A locally retryable error is proof the provider was never reached, so
        // the marker is walked BACK to the phase it had before the commit rather
        // than kept or dropped. Kept, a later refresh would send the buyer to the
        // status poller for an intent with no payment method; dropped, a server
        // that can still hand the same action back has nothing left to hand it
        // to. Lowering keeps the action reopenable and the false wait impossible.
        setCheckoutContinuationPhase("action_issued");
        return;
      }
      if (status === "failed") {
        clearCheckoutContinuation();
        // The browser is the ONLY witness of a pre-charge confirm rejection
        // (the PSP emits no webhook for it), so ask the backend to read the
        // provider NOW and terminalize the attempt — that is what mints the
        // recovery token + failure email immediately instead of after waiting for the
        // next adopter-configured reconciliation pass. Bounded:
        // navigation proceeds after ≤2.5 s no matter what.
        const verified = verifyCommercePaymentNowBounded({
          orderId: current.orderId,
          paymentIntentId: current.paymentIntentId,
          clientId: current.clientId,
        }).catch(() => null); // belt-and-braces: the bounded call itself never rejects
        if (accountStatusPath) {
          // Account retry advances at its explicit terminal CTA, not eagerly
          // when the status view is entered.
          void verified.then(() => navigate(paymentStatusUrlFor(accountStatusPath, current)));
          return;
        }
        // A deterministic card failure is terminal for this provider ATTEMPT,
        // not for the purchase: `commerce_payment_control_apply_*` leaves the
        // order `pending_payment` with its stock hold retained, and a later
        // success on the same order still lands as paid. So the buyer stays in
        // the funnel — the panel unmounts and the payment step takes them back
        // with the reason, instead of a separate failure page that offers only
        // "back to the configurator".
        //
        // The panel MUST unmount rather than reopen in place: the PSP forbids
        // swapping `clientSecret` on a mounted `<Elements>`, and payment-control
        // expects every ladder step to record a FRESH attempt. The retry
        // re-enters `/checkout` on the SAME order AND the SAME payment intent,
        // never a new one: `commerce_payment_intents` is `UNIQUE (order_id)` and
        // `create_intent` refuses a second (20260604190000_commerce_v2_w9_payment_control_plane.sql:74, :324-325).
        // The bump below gives the retry its own execution-idempotency namespace;
        // ⛔ the intent id - and the mandate alias `aliasValue` derives from it - does not.
        bumpCheckoutPaymentAttempt();
        stashCheckoutDeclineNotice("checkout:errors.paymentDeclinedCard", current);
        void verified.then(() => setPaymentPanel(null));
        return;
      }
      setPaymentPanel({ ...current, awaitingWebhook: true });
    },
    [navigate, accountStatusPath],
  );

  const onPollerTerminal = useCallback(
    (status: CheckoutTerminalStatus) => {
      const current = stripePayRef.current;
      if (!current) return;
      const diagnosticReporter = loadCustomerDiagnosticReporterWhenEnabled?.(), clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
      if (diagnosticReporter && clientActionKey) reportCustomerJourneyPayment("payment_status", status === "paid" ? "succeeded" : status === "timeout" ? "timeout" : "failed", diagnosticReporter, clientActionKey);
      if (accountStatusPath) {
        clearCheckoutContinuation();
        navigate(paymentStatusUrlFor(accountStatusPath, current));
        return;
      }
      navigatePollerTerminal(
        status,
        current,
        navigate,
        { thankYou, paymentFailed, paymentPath },
        draftScope,
      );
    },
    [navigate, thankYou, paymentFailed, paymentPath, draftScope, accountStatusPath],
  );

  return {
    stripePay,
    // Public key kept for the callers that read it; the local binding is neutral.
    setStripePay: setPaymentPanel,
    closePaymentPanel,
    resumeBeforeSubmit,
    onConfirmSettled,
    onPollerTerminal,
    raisePriorAttemptFromRefusal,
    priorAttempt: {
      state: priorAttempt,
      finish: resumePriorAttempt,
      checkStatus: checkPriorAttemptStatus,
      dismiss: dismissPriorAttempt,
    },
  };
}

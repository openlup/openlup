import type { PaymentStatusContinuationRequest } from "@/domains/commerce/paymentContinuationContracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AsyncCheckoutStatus } from "@/domains/commerce/checkoutContracts";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import {
  emitAnalyticsEvent,
  type AnalyticsPaymentWaitOutcome,
} from "@/lib/analytics/dataLayer";
import { useCheckoutPaymentWait } from "./useCheckoutPaymentWait";

/**
 * Everything a host needs to hold a wait where the buyer already is.
 *
 * `declineMessageKey` is resolved by the router at the moment of the submit,
 * because that module owns the decline vocabulary and knows the method that was
 * actually charged. The host replays the key it was handed rather than deciding
 * again later, from state that may since have moved on.
 */
export interface CheckoutInlineWaitStart {
  journeyId?: string;
  orderId: string;
  orderRef: string;
  paymentIntentId: string;
  clientId: string;
  declineMessageKey: string;
  /** One-time versus recurring. The dimension the rest of the funnel already
   * carries, so a wait can be read beside `begin_checkout` and `purchase`. */
  checkoutMode: "one_time" | "subscription";
}

/** What the payment step renders while the buyer is in their banking app. */
export interface ConfiguratorPaymentWait {
  status: AsyncCheckoutStatus;
  /** The wait cap was reached. NOT a failure — the payment may well have gone through. */
  waitExhausted: boolean;
  /** Paid, but the recurring mandate is still outstanding: a different sentence. */
  awaitingMandate: boolean;
  /**
   * Give the step back to the buyer. The wait is only ours to hold while it can
   * still tell them something; once it cannot, keeping the form unmounted turns
   * a safeguard into a dead end, and their real exit becomes closing the tab.
   */
  abandon: () => void;
}

export interface ConfiguratorPaymentWaitController {
  recoveryRequest?: PaymentStatusContinuationRequest | null;
  /** Non-null exactly while the step must show the waiting panel. */
  wait: ConfiguratorPaymentWait | null;
  /** A decline the buyer can act on, as an i18n key, until the step consumes it. */
  declineMessageKey: string | null;
  begin: (start: CheckoutInlineWaitStart) => void;
  consumeDecline: () => void;
  /** Transfers the terminal refusal identity to its presentation owner once. */
  consumeRecovery: () => void;
}

/**
 * The checkout wait, hosted BY the payment step instead of by a page.
 *
 * {@link useCheckoutPaymentWait} already knows how to turn "the buyer left for
 * their bank" into an answer; what it deliberately does not know is where a wait
 * ENDS. This hook supplies the three endings a buyer who never left the step
 * needs:
 *
 * - settled → the host navigates to its terminal, the only navigation left on
 *   this rail;
 * - refused → no navigation at all. The order stays re-payable and the step
 *   keeps the buyer, holding the message the router already chose;
 * - the cap → the panel says so honestly and offers a re-read. ⛔ Never a
 *   "pay again": at the cap we do not know the payment failed, only that no
 *   confirmation reached us, and a payment that WAS taken looks identical from
 *   here.
 *
 * There is one further ending, and it is a hand-back rather than an answer: an
 * order that is paid while its subscription mandate was REFUSED. That state is
 * neither "waiting for your bank" nor "no confirmation yet", and inventing a
 * third sentence for it here would duplicate a screen the standalone status page
 * already owns, CTA and all. So it leaves.
 */
export function useConfiguratorPaymentWait(input: {
  draftScope: ConfiguratorDraftScope;
  /** The payment settled and the buyer is free to go. */
  onPaid: (order: CheckoutInlineWaitStart) => void;
  /** Paid, but the recurring mandate needs a screen this panel does not have. */
  onActivationActionRequired: (order: CheckoutInlineWaitStart) => void;
}): ConfiguratorPaymentWaitController {
  const { draftScope, onPaid, onActivationActionRequired } = input;
  const [start, setStart] = useState<CheckoutInlineWaitStart | null>(null);
  const [recoveryRequest, setRecoveryRequest] = useState<PaymentStatusContinuationRequest | null>(null);
  const [declineMessageKey, setDeclineMessageKey] = useState<string | null>(null);

  // No `journeyId`: a code-entry rail has no redirect to follow, so the engine's
  // redirect branch stays unreachable and this wait can only end where the three
  // endings above say it ends.
  const statusRequest = useMemo(
    () => (start
      ? { orderId: start.orderId, paymentIntentId: start.paymentIntentId, clientId: start.clientId }
      : null),
    [start],
  );

  /**
   * The funnel's only view of this rail, and it is emitted from HERE because
   * this is the one module that learns every ending. The step component sees the
   * panel appear and disappear but cannot tell settled from refused from capped,
   * which is the entire payload.
   *
   * **First outcome wins, once per wait.** The cap is not a closed ending: the
   * buyer can ask for a re-read from it, that re-read can settle or be refused,
   * and it can also reach the cap a second time. A flag cleared only by a NEW
   * wait is what makes all three of those paths emit nothing further.
   *
   * ⚠️ The consequence is deliberate and is worth knowing when reading the data:
   * a wait that reached the cap and only then settled is recorded `no_answer`,
   * because the moment the promise to answer in place broke is the fact this
   * instrument exists to measure. The recovery is not lost — `purchase` still
   * fires on the terminal page — so the two can be subtracted.
   *
   * ⛔ No re-emission when optional consent arrives later. Both sink attempts
   * describe this exact moment and are dropped rather than replayed minutes
   * afterwards at a different point in the funnel.
   */
  const outcomeSentRef = useRef(false);
  // Held in a ref so the ending can still name its mode after `start` is cleared.
  const modeRef = useRef<"one_time" | "subscription">("one_time");
  const emitOutcome = useCallback((outcome: AnalyticsPaymentWaitOutcome) => {
    if (outcomeSentRef.current) return;
    outcomeSentRef.current = true;
    emitAnalyticsEvent("payment_wait_end", { outcome, checkoutMode: modeRef.current });
  }, []);

  const { status, subscriptionActivation, waitExhausted, checkAgain } = useCheckoutPaymentWait({
    statusRequest,
    draftScope,
    onPaid: () => {
      if (!start) return;
      setStart(null);
      emitOutcome("confirmed");
      onPaid(start);
    },
    onTerminal: () => {
      if (!start) return;
      setStart(null);
      emitOutcome("refused");
      setDeclineMessageKey(start.declineMessageKey);
      setRecoveryRequest({ orderId: start.orderId, paymentIntentId: start.paymentIntentId,
        clientId: start.clientId, ...(start.journeyId ? { journeyId: start.journeyId } : {}) });
    },
  });

  // The cap, as an outcome. Guarded on `start` so it can only describe a wait
  // that is still this step's, and left to the shared flag for the rest.
  useEffect(() => {
    if (!start || !waitExhausted) return;
    emitOutcome("no_answer");
  }, [start, waitExhausted, emitOutcome]);

  useEffect(() => {
    if (!start || subscriptionActivation !== "action_required") return;
    setStart(null);
    // The payment DID confirm here; what is unfinished is the recurring mandate,
    // and that is a different screen rather than a different payment outcome.
    // A fourth member would split the funnel on a question it is not asking.
    emitOutcome("confirmed");
    onActivationActionRequired(start);
  }, [start, subscriptionActivation, onActivationActionRequired, emitOutcome]);

  const begin = useCallback((next: CheckoutInlineWaitStart) => {
    // A new attempt outranks the last one's verdict: leaving the old message up
    // would date-stamp the new wait with an outcome that is no longer this
    // payment's. The once-per-wait guard below is reset for the same reason.
    setRecoveryRequest(null);
    setDeclineMessageKey(null);
    outcomeSentRef.current = false;
    modeRef.current = next.checkoutMode;
    setStart(next);
    emitAnalyticsEvent("payment_wait_start", { checkoutMode: next.checkoutMode });
  }, []);

  const consumeDecline = useCallback(() => setDeclineMessageKey(null), []);
  const consumeRecovery = useCallback(() => {
    setRecoveryRequest(null);
    setDeclineMessageKey(null);
  }, []);

  const abandon = useCallback(() => {
    setStart(null);
    // No answer ever arrived for this wait, which is exactly what the third
    // outcome names; the once-per-wait guard keeps a later cap from re-emitting.
    emitOutcome("no_answer");
    // ⛔ Neither the bump nor the clear happens any more. The bump could not open
    // the anti-double-charge gate - that gate reads the intent's active attempt,
    // not a prepare key - and the clear destroyed the buyer's only route back on
    // the way out. Leaving the wait is not an answer about the payment, so the
    // marker survives it and the next submit is routed rather than refused blind.
  }, [emitOutcome]);

  const wait = useMemo(
    () =>
      start
        ? {
            status,
            waitExhausted,
            awaitingMandate: status === "paid" && subscriptionActivation === "waiting_for_mandate",
            abandon,
          }
        : null,
    [start, status, waitExhausted, subscriptionActivation, abandon],
  );

  return { wait, declineMessageKey, recoveryRequest, begin, consumeDecline, consumeRecovery };
}

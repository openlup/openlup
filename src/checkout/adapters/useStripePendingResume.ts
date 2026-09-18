import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";

import type { StripePayState } from "./SkomponujPakietStripePayPanel";
import { applyPendingResume, resolvePendingResume } from "@/checkout/machine/checkoutResumeGuard";
import {
  type CheckoutContinuationContext,
  clearCheckoutContinuation,
  paymentStatusUrlFor,
  readCheckoutContinuation,
} from "@/checkout/machine/checkoutNavigation";

/**
 * Has a wait on this marker already run past `PAYMENT_WAIT_CAP_MS`?
 *
 * ⛔ Lives here, with its ONLY consumer, and must never reach
 * `decidePendingResume`: what a payment IS does not change with how long a
 * browser has been looking at it, and an exhausted wait says nothing about
 * whether money is in flight.
 */
export function continuationWaitExhausted(
  pending: CheckoutContinuationContext,
): boolean {
  return typeof pending.waitExhaustedAt === "number";
}

export function useStripePendingResume(
  stripePay: StripePayState | null,
  setStripePay: (state: StripePayState) => void,
  navigate: NavigateFunction,
  paymentPath: string,
): void {
  useEffect(() => {
    if (stripePay) return;
    const pending = readCheckoutContinuation();
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      // One resolver AND one executor for both resume moments — this one and the
      // submit-time `resumeBeforeSubmit` — so neither the decision rules nor what
      // a decision does can drift apart between them.
      const decision = await resolvePendingResume(pending);
      if (cancelled) return;
      applyPendingResume(decision, {
        reopenAction: (clientSecret) => setStripePay({
          orderId: pending.orderId,
          orderRef: pending.orderRef,
          paymentIntentId: pending.paymentIntentId,
          clientId: pending.clientId,
          journeyId: pending.journeyId,
          clientSecret,
          awaitingWebhook: false,
        }),
        followRedirect: (url) => window.location.assign(url),
        // ⛔ MOUNT ONLY. The identical line in `useConfiguratorCheckoutTerminalRouting`
        // is the SUBMIT twin and must keep stopping the buyer — that refusal is what
        // stops a second attempt being minted against an open one. Suppressing both
        // "so they agree" looks tidier and is the double-charge bug.
        //
        // Past the cap the poller has nothing left to earn attention with: its
        // readbacks are spent and the reconciliation cron owns the attempt. So the
        // capture stops and the MARKER STAYS — the route back is a link, not a cell.
        // Before the cap the capture is correct: money may be seconds from settling.
        waitOnStatus: () => {
          if (continuationWaitExhausted(pending)) return;
          navigate(paymentStatusUrlFor(paymentPath, pending));
        },
        discardMarker: clearCheckoutContinuation,
        // Nothing to act on, and the mount path has no surface to raise. Keeping
        // the marker is the point: the next submit's refusal can still route it.
        keepMarker: () => {},
        // Unreachable by construction: this call names no selected provider, so
        // `decidePendingResume` cannot return the blocked decision here. The mount
        // path also has no surface to raise it on. ⛔ Deliberately a no-op rather
        // than `clearCheckoutContinuation`: this decision means an attempt is still
        // open, and dropping the marker over an open attempt is the defect the
        // decision was renamed to stop describing.
        blockOnPriorAttempt: () => {},
        // Keep the marker, change nothing: the card form stays and the next
        // mount or submit can still reopen the action. Dropping it would strand
        // the buyer behind the anti-double-charge gate with no route back.
        cannotCheck: () => {},
      });
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount.
  }, []);
}

import { useCallback, useEffect, useRef, useState } from "react";

import { getCommercePaymentStatus } from "@/domains/commerce/commerceClient";
import { paymentFailureDisplayReasonSchema } from "@/domains/commerce/paymentFailureDisplayContracts";
import type {
  AsyncCheckoutStatus,
  PaymentStatusRequest,
  PaymentStatusResponse,
} from "@/domains/commerce/checkoutContracts";
import { verifyCommercePaymentNowBounded } from "@/domains/commerce/paymentVerifyClient";
import { clearPersistedConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import { bumpCheckoutPaymentAttempt, clearCheckoutAttemptKey } from "./checkoutAttemptStore";
import { clearCheckoutContinuation, readCheckoutContinuation } from "./checkoutNavigation";
import { hasExhaustedPaymentWait, shouldReadBackProvider } from "./paymentVerifyEscalation";

/**
 * The checkout payment wait, as an engine rather than as a page.
 *
 * This is the loop that turns "the buyer left for their bank" into an answer:
 * it polls payment-control state, escalates to a live provider readback once our
 * own database has failed to explain the wait (see `paymentVerifyEscalation`),
 * and stops at the cap rather than go on promising "a few seconds" forever.
 *
 * It is deliberately host-agnostic. It knows nothing about routing, query
 * params, SEO, or the simulator controls, and it never navigates: the three
 * moments where a wait ENDS in a place the host owns are handed back as callbacks
 * ({@link CheckoutPaymentWaitOptions.onPaid}, `onTerminal`, `onRedirect`). That
 * is the whole difference between the standalone wait page, which leaves for a
 * terminal route, and a caller mounted inside the configurator's payment step,
 * which must stay exactly where it is.
 */
/**
 * What this engine polls with. `PaymentStatusRequest` is `.strict()` and does not
 * carry `journeyId`, but the same identity gates the redirect resume, so the
 * engine accepts it alongside — exactly the shape the wait page has always built
 * and handed to `getCommercePaymentStatus`.
 */
export type CheckoutPaymentWaitRequest = PaymentStatusRequest & { journeyId?: string };

export interface CheckoutPaymentWaitOptions {
  /**
   * The identity of the wait, already assembled by the host. `null` means there
   * is nothing pollable, and the engine stays completely idle — it never reads
   * a URL or a store to try to find one.
   */
  statusRequest: CheckoutPaymentWaitRequest | null;
  /**
   * Which configurator draft a successful payment consumes.
   *
   * ⚠️ Required on purpose. `clearPersistedConfiguratorFormData` defaults to the
   * PUBLIC scope when called with no argument, which is right for the standalone
   * wait page and wrong for any caller running inside an account-scoped
   * configurator — it would wipe a draft that is not this payment's. Making the
   * scope an explicit input is what stops a future caller getting it wrong by
   * omission.
   */
  draftScope: ConfiguratorDraftScope;
  /**
   * Seed for the provider payment id the host may already know (the simulator
   * controls key off it). Plain data — the engine does not care where it came from.
   */
  initialProviderPaymentId?: string;
  /**
   * The payment is settled AND the subscription no longer needs the buyer here.
   * Not called while activation is still `waiting_for_mandate` / `action_required`:
   * the engine keeps polling through that, because a paid order whose
   * subscription has not activated is not yet a finished story.
   */
  onPaid: (response: PaymentStatusResponse) => void;
  /**
   * The attempt is over and did not settle. The second argument is the DISPLAY
   * bucket, normally resolved by the server. The raw reason remains in the BFF
   * response; only this closed display vocabulary is passed to the host for
   * choosing copy and URL parameters. `null` means the refusal maps to no
   * bucket. The final argument distinguishes a recorded unknown cause from no
   * recorded cause, so a local hint cannot override the former.
   */
  onTerminal: (status: AsyncCheckoutStatus, failureDisplay: string | null, hasRecordedFailureReason: boolean) => void;
  /**
   * The provider wants the browser back. Defaults to a full-page
   * `location.assign`, which is what a standalone wait page wants; a host that
   * must keep its own shell alive passes its own.
   */
  onRedirect?: (url: string) => void;
}

export interface CheckoutPaymentWait {
  status: AsyncCheckoutStatus;
  subscriptionActivation: PaymentStatusResponse["subscriptionActivation"]["status"];
  activationSubscriptionId: string | null;
  providerPaymentId: string;
  /** The cap was reached. NOT a failure — see `PAYMENT_WAIT_CAP_MS`. */
  waitExhausted: boolean;
  /** The buyer asked for a re-read. Restarts the wait; never re-pays. */
  checkAgain: () => void;
}

export function useCheckoutPaymentWait(
  options: CheckoutPaymentWaitOptions,
): CheckoutPaymentWait {
  const statusRequest = options.statusRequest;
  const [status, setStatus] = useState<AsyncCheckoutStatus>("pending_provider_action");
  const [subscriptionActivation, setSubscriptionActivation] = useState<
    PaymentStatusResponse["subscriptionActivation"]["status"]
  >("not_applicable");
  const [activationSubscriptionId, setActivationSubscriptionId] = useState<string | null>(null);
  const [providerPaymentId, setProviderPaymentId] = useState(options.initialProviderPaymentId ?? "");
  const [waitEpoch, setWaitEpoch] = useState(0);
  const [waitExhausted, setWaitExhausted] = useState(false);

  /**
   * The host's callbacks and draft scope are read through a ref and are
   * deliberately NOT effect dependencies. Every real caller passes inline
   * arrows, so listing them would tear the loop down and rebuild it on every
   * render — and each rebuild resets `startedAt`, which is the clock both the
   * readback threshold and the wait cap are measured against. A wait that
   * restarts its own clock never escalates and never exhausts.
   */
  const hostRef = useRef(options);
  hostRef.current = options;

  /**
   * An explicit "check again" is the buyer overriding the stamp for one more
   * round, so the seed below must not immediately undo it. Without this the
   * press bumped `waitEpoch`, the effect re-read the still-stamped marker and
   * set exhaustion straight back — the panel never moved and the page's only
   * recovery control looked broken.
   *
   * A ref and not state: this must not itself re-run the effect, and it is
   * consumed by the very run the press triggers.
   */
  const recheckRequestedRef = useRef(false);

  useEffect(() => {
    // No request means no wait, so the exhaustion flag must not survive into the
    // next one. It is set only on the way up, and a controller that outlives its
    // request would otherwise open the following wait already marked exhausted —
    // which the funnel instrument would then report as an ending that never began.
    if (!statusRequest) {
      setWaitExhausted(false);
      return;
    }
    // Captured so the narrowing survives into `poll` below: TypeScript drops it
    // at the closure boundary, and the strict lane is the only one that says so.
    const request = statusRequest;
    // A returning buyer must not be told "this usually takes a few seconds" a
    // second time: if a wait on this marker already passed the cap, open on the
    // honest answer. Seeded HERE and not as a `useState` initializer, so the
    // `statusRequest: null` reset above still clears it between waits.
    //
    // The stamp belongs to the ARRIVAL, not to every run of this effect. A
    // `checkAgain` press re-runs it through `waitEpoch`, and seeding there would
    // re-assert the state the press just cleared.
    const seedFromArrival = !recheckRequestedRef.current;
    recheckRequestedRef.current = false;
    const persisted = readCheckoutContinuation();
    // `typeof === "number"`, matching every other reader of this field.
    // NOT `continuationWaitExhausted`: that predicate carries a ⛔ saying it lives
    // with its only consumer and must never spread, and honouring that is worth
    // more than removing two lines of duplication.
    if (seedFromArrival && typeof persisted?.waitExhaustedAt === "number"
      && persisted.orderId === request.orderId
      && persisted.paymentIntentId === request.paymentIntentId) setWaitExhausted(true);
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    let readbackCount = 0;
    let lastReadbackAtMs: number | null = null;
    async function poll() {
      try {
        const response = await getCommercePaymentStatus(request);
        if (cancelled) return;
        setStatus(response.status);
        setSubscriptionActivation(response.subscriptionActivation.status);
        setActivationSubscriptionId(response.subscriptionActivation.subscriptionId);
        setProviderPaymentId(response.payment?.providerPaymentId ?? "");
        if (response.status === "paid") {
          clearCheckoutContinuation();
          clearCheckoutAttemptKey();
          clearPersistedConfiguratorFormData(hostRef.current.draftScope);
          if (
            response.subscriptionActivation.status === "waiting_for_mandate" ||
            response.subscriptionActivation.status === "action_required"
          ) {
            timer = window.setTimeout(poll, response.subscriptionActivation.status === "waiting_for_mandate" ? 2500 : 5000);
            return;
          }
          hostRef.current.onPaid(response);
          return;
        }
        if (response.status === "failed" || response.status === "expired") {
          clearCheckoutContinuation();
          // This attempt is dead but the ORDER deliberately stays re-payable, so
          // the buyer retries onto the same order. Without a fresh attempt
          // identity that retry collides with this attempt's prepare key — fatally
          // so when they switch provider, which is exactly what an unsupported
          // bank forces them to do.
          bumpCheckoutPaymentAttempt();
          const legacyDisplay = response.failureDisplay === undefined
            ? paymentFailureDisplayReasonSchema.safeParse(response.failureReason)
            : null;
          const failureDisplay = response.failureDisplay === undefined
            ? legacyDisplay?.success ? legacyDisplay.data : null
            : response.failureDisplay;
          const hasRecordedFailureReason = typeof response.failureReason === "string"
            && response.failureReason.trim().length > 0;
          hostRef.current.onTerminal(response.status, failureDisplay, hasRecordedFailureReason);
          return;
        }
        if (request.journeyId && response.nextAction?.kind === "redirect") {
          const url = response.nextAction.url;
          const onRedirect = hostRef.current.onRedirect;
          if (onRedirect) onRedirect(url);
          else window.location.assign(url);
          return;
        }
        // Our own state cannot explain this wait yet. On a rail that reports
        // declines through no webhook at all — BLIK — it never will until
        // the next configured reconciliation pass runs, so ask the server to read the
        // provider now. Fire-and-forget by design: the readback's only job is
        // to terminalize the attempt through the canonical apply RPC, and the
        // next tick above observes the result, so there is exactly one place
        // this engine learns a payment is over.
        const elapsedMs = Date.now() - startedAt;
        if (shouldReadBackProvider({ elapsedMs, readbackCount, lastReadbackAtMs })) {
          readbackCount += 1;
          lastReadbackAtMs = elapsedMs;
          void verifyCommercePaymentNowBounded(request);
        }
        // Past the cap the wait stops PROMISING, not listening: it says so and
        // keeps reading at a slower cadence, so a late webhook still lands the
        // buyer on their terminal without asking them to press anything. Ending
        // the loop here is what made a button necessary in the first place.
        const exhausted = hasExhaustedPaymentWait(elapsedMs);
        if (exhausted) setWaitExhausted(true);
        timer = window.setTimeout(poll, exhausted ? 10_000 : 2500);
      } catch {
        // A failing read is our own transport, not the provider's: escalating
        // here would add load without adding truth.
        if (!cancelled) timer = window.setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [statusRequest, waitEpoch]);

  const checkAgain = useCallback(() => {
    recheckRequestedRef.current = true;
    setWaitExhausted(false);
    setWaitEpoch((e) => e + 1);
  }, []);

  return {
    status,
    subscriptionActivation,
    activationSubscriptionId,
    providerPaymentId,
    waitExhausted,
    checkAgain,
  };
}

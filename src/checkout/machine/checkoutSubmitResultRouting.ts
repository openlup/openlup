import { declineMessageKeyFor, isCodeEntryPaymentMethod } from "./checkoutDeclineNotice";
import { recoveryPaymentMethodVisibility, visiblePaymentMethods } from "@/checkout/adapters/paymentMethodOptions";
import type { NavigateFunction } from "react-router-dom";

import type { CheckoutResponse } from "@/domains/commerce/checkoutContracts";
import type { CheckoutInlineRecoveryPayResponse } from "@/domains/commerce/checkoutInlineRecoveryContracts";

import type { StripePayState } from "@/checkout/adapters/SkomponujPakietStripePayPanel";
import {
  type ConfiguratorFormData,
  clearPersistedConfiguratorFormData,
} from "@/checkout/composer/configuratorFormStore";
import { bumpCheckoutPaymentAttempt, clearCheckoutAttemptKey } from "./checkoutAttemptStore";
import {
  clearCheckoutContinuation,
  paymentStatusUrlFor,
  persistCheckoutContinuation,
  persistAccountOrderReturn,
  thankYouUrlFor,
} from "./checkoutNavigation";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";

import type { CheckoutInlineWaitStart } from "./useConfiguratorPaymentWait";

export function routeConfiguratorCheckoutResult(input: {
  result: CheckoutResponse | CheckoutInlineRecoveryPayResponse;
  source: "submit" | "ambiguous_readback" | "inline_recovery";
  journeyId: string;
  data: ConfiguratorFormData;
  navigate: NavigateFunction;
  paths: { thankYou: string; paymentPath: string; accountStatusPath?: string };
  accountMode: boolean;
  hasTpayPatch: boolean;
  useStripe: boolean;
  draftScope: ConfiguratorDraftScope;
  setStripePay: (state: StripePayState) => void;
  onAccountOrderComplete?: (summary: { orderRef: string; petName: string; isSubscription: boolean }) => void;
  /** Holds a code-entry wait in place; every other caller keeps navigating. */
  onInlineWait?: (start: CheckoutInlineWaitStart) => void;
}): void {
  const {
    result,
    source,
    journeyId,
    data,
    navigate,
    paths,
    accountMode,
    hasTpayPatch,
    useStripe,
    draftScope,
    setStripePay,
    onAccountOrderComplete,
    onInlineWait,
  } = input;
  const { thankYou, paymentPath, accountStatusPath } = paths;
  const statusPath = accountMode && accountStatusPath ? accountStatusPath : paymentPath;

  if (result.status === "price_changed") {
    throw new Error("checkout:errors.priceChanged");
  }

  if (accountMode && accountStatusPath && result.orderId && result.orderRef) {
    persistAccountOrderReturn({
      orderId: result.orderId,
      orderRef: result.orderRef,
      petName: data.dogName,
      isSubscription: Boolean(data.subscription),
      petId: data.accountPetId ?? null,
    });
  }

  if (result.status === "paid") {
    clearCheckoutAttemptKey();
    clearPersistedConfiguratorFormData(draftScope);
    clearCheckoutContinuation();
    if (onAccountOrderComplete) {
      onAccountOrderComplete({
        orderRef: result.orderRef,
        petName: data.dogName,
        isSubscription: Boolean(data.subscription),
      });
      return;
    }
    navigate(thankYouUrlFor(thankYou, result));
    return;
  }

  // A decline is not a destination. The server has authoritatively closed THIS
  // provider attempt while the buyer is still standing on the payment step, so
  // the step keeps them: `useConfiguratorNavigation` turns a `checkout:` error
  // into the step's own alert without navigating anywhere. The order survives
  // and stays `pending_payment`; only the provider-attempt identity is renewed,
  // so the next try cannot collide with the dead one. Reached from `submit` and
  // from `ambiguous_readback` alike — both mean the same thing to the buyer.
  //
  // MUST stay above the readback branch and above the missing-payment-intent
  // throw below: a refusal comes back as `status: "failed"` AND
  // `clientAction: {kind: "none"}`, so anything keyed on the action shape alone
  // would swallow it.
  if (result.status === "failed") {
    bumpCheckoutPaymentAttempt();
    clearCheckoutContinuation();
    throw Object.assign(new Error(declineMessageKeyFor(data.paymentMethod)), {
      checkoutRecoveryRequest: { orderId: result.orderId, paymentIntentId: result.paymentIntentId,
        clientId: result.clientId, journeyId },
    });
  }

  // The server's readback outranks a replayed action: it has just told us what
  // this attempt really IS, while the action beside it may be a replay of one
  // already consumed. Reopening that action would put the buyer back on a form
  // for an attempt the server has already moved past.
  if (source === "ambiguous_readback") {
    routeAmbiguousReadback({ result, navigate, statusPath });
    return;
  }

  if (
    !hasTpayPatch &&
    useStripe &&
    result.paymentIntentId &&
    result.clientId &&
    result.clientAction?.kind === "provider_embedded" &&
    result.clientAction.provider === "stripe" &&
    result.clientAction.clientSecret
  ) {
    persistCheckoutContinuation({
      orderId: result.orderId,
      orderRef: result.orderRef,
      paymentIntentId: result.paymentIntentId,
      clientId: result.clientId,
      journeyId,
      actionKind: "embedded",
    });
    setStripePay({
      hasAlternativePaymentMethod: visiblePaymentMethods(data.subscription ? "subscription" : "one_time", recoveryPaymentMethodVisibility()).some(({ value }) => value !== "card"),
      orderId: result.orderId,
      orderRef: result.orderRef,
      paymentIntentId: result.paymentIntentId,
      clientId: result.clientId,
      journeyId,
      clientSecret: result.clientAction.clientSecret,
      awaitingWebhook: false,
    });
    return;
  }

  if (result.clientAction?.kind === "redirect") {
    if (result.paymentIntentId && result.clientId) {
      persistCheckoutContinuation({
        orderId: result.orderId,
        orderRef: result.orderRef,
        paymentIntentId: result.paymentIntentId,
        clientId: result.clientId,
        journeyId,
        actionKind: "redirect",
      });
    }
    window.location.assign(result.clientAction.url);
    return;
  }

  // An actionless, still-pollable response. TWO different things arrive here:
  //
  // 1. A RESUMED order: the server recognised an attempt already in flight for
  //    this buyer and answered with it rather than opening a second one, so
  //    there is no fresh action to drive and the wait belongs on the status
  //    page. The redirect rail has always routed this correctly; the embedded
  //    rail fell through to the throw below and showed "could not place your
  //    order" for an order that was very much placed.
  // 2. A FRESH actionless submit — BLIK Level 0. The buyer has already typed a
  //    code into this page, the provider call has gone out, and the only thing
  //    left is the push notification in their banking app.
  //
  // Gated on a NON-terminal status on purpose: a terminal `failed` can arrive
  // carrying the same actionless shape, and that case belongs to the inline
  // decline branch above, not here.
  if (
    result.clientAction?.kind === "none"
    && isPollableCheckoutStatus(result.status as string)
    && hasPollableCheckoutIds(result)
  ) {
    // `authoritativeQuote` is what separates the two cases, and it is not a
    // proxy: only the orchestrated FRESH checkout re-prices the basket and
    // returns the quote it charged against, so its presence means a provider
    // call was dispatched in THIS request. The resume guard answers with an
    // order it merely recognised and never quotes — writing a marker for that
    // one would claim a commit this request never made. `clientAction.kind`
    // alone cannot tell them apart, which is why it is not the discriminator.
    //
    // The phase is `confirm_dispatched` and not `action_issued` because the
    // buyer has already handed over a credential: money CAN be moving, so a
    // refresh must be allowed to wait it out rather than drop the marker and
    // re-open a form for an attempt that may already be settling.
    const freshActionless = source === "inline_recovery"
      || (source === "submit" && "authoritativeQuote" in result && Boolean(result.authoritativeQuote));
    if (freshActionless) {
      persistCheckoutContinuation({
        orderId: result.orderId,
        orderRef: result.orderRef,
        paymentIntentId: result.paymentIntentId,
        clientId: result.clientId,
        journeyId,
        actionKind: "none",
        phase: "confirm_dispatched",
      });
      // From here the required action is the BUYER'S, in another application, and
      // a code-entry rail never sends the browser anywhere to get it. A host that
      // can hold the wait is handed it instead of a URL, and the step's controls
      // unmount behind it — which makes a second charge unreachable, not merely
      // discouraged. Gated on the SAME `authoritativeQuote` as the marker above:
      // a resumed order wears this shape without having been dispatched here.
      if (onInlineWait && isCodeEntryPaymentMethod(data.paymentMethod)) {
        const { orderId, orderRef, paymentIntentId, clientId } = result;
        if (orderId && orderRef && paymentIntentId && clientId) {
          onInlineWait({
            orderId,
            orderRef,
            paymentIntentId,
            clientId,
            journeyId,
            declineMessageKey: declineMessageKeyFor(data.paymentMethod),
            checkoutMode: data.subscription ? "subscription" : "one_time",
          });
          return;
        }
      }
    }
    navigate(paymentStatusUrlFor(statusPath, result));
    return;
  }

  // Only a `submit` can still be here: the readback branch above returns for
  // the other source, which is why TypeScript now proves the second, lower copy
  // of it that the gate used to make reachable is dead.
  if (!hasTpayPatch && useStripe) {
    clearCheckoutAttemptKey();
    clearCheckoutContinuation();
    throw new Error("stripe_checkout_missing_payment_intent");
  }
  navigate(paymentStatusUrlFor(statusPath, result));
}

/**
 * A decline the buyer can act on deserves the instruction that actually applies
 * to the method they picked, not one sentence for every rail. The method is
 * already in hand, so this costs no extra field on the wire and no second
 * request — the reason vocabulary itself never reaches the browser, because
 * `checkoutSuccessResponseSchema` is `.strict()` and a new field would reject
 * every bundle already loaded in a paying browser.
 */
/**
 * An ambiguous readback carries the server's own account of the attempt: it
 * either resumes the wait (navigate) or reports an authoritative close (throw).
 * Either way the caller must stop routing.
 */
function routeAmbiguousReadback(input: {
  result: CheckoutResponse | CheckoutInlineRecoveryPayResponse;
  navigate: NavigateFunction;
  statusPath: string;
}): void {
  const { result, navigate, statusPath } = input;
  const readbackStatus = result.status as string;
  if (isPollableCheckoutStatus(readbackStatus) && hasPollableCheckoutIds(result)) {
    navigate(paymentStatusUrlFor(statusPath, result));
    return;
  }
  throw new Error("checkout:errors.paymentStatusUnknown");
}

/**
 * Narrows the four ids to `string`, not just the status. The runtime check below
 * has always proved all four are present; until now the predicate did not SAY so,
 * so every caller re-derived it and the app tsconfig's non-strict mode hid the
 * gap. Saying it here is what lets a caller persist them without a cast.
 */
function hasPollableCheckoutIds(
  result: CheckoutResponse | CheckoutInlineRecoveryPayResponse,
): result is (Exclude<CheckoutResponse, { status: "price_changed" }> | CheckoutInlineRecoveryPayResponse)
  & { orderId: string; orderRef: string; paymentIntentId: string; clientId: string } {
  if (result.status === "price_changed") return false;
  return Boolean(result.orderId && result.orderRef && result.paymentIntentId && result.clientId);
}

function isPollableCheckoutStatus(status: string): boolean {
  return status === "pending_provider_action" ||
    status === "requires_action" ||
    status === "processing";
}

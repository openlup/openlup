import type { NavigateFunction } from "react-router-dom";

import {
  clearPersistedConfiguratorFormData,
  getConfiguratorFormData,
  setConfiguratorFormData,
} from "@/checkout/composer/configuratorFormStore";
import { bumpCheckoutPaymentAttempt, clearCheckoutAttemptKey } from "@/checkout/machine/checkoutAttemptStore";
import {
  clearCheckoutContinuation,
  paymentFailedUrlFor,
  paymentStatusUrlFor,
  thankYouUrlFor,
} from "@/checkout/machine/checkoutNavigation";
import type { WalletCheckoutSettlement } from "./WalletExpressRow";
import { walletDeclineStaysInPlace } from "./walletExpressSettlement";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";

export function routeWalletCheckoutSettlement(input: {
  settlement: WalletCheckoutSettlement;
  navigate: NavigateFunction;
  paths: { thankYou: string; paymentFailed: string; paymentPath: string };
  draftScope?: ConfiguratorDraftScope;
}): void {
  const { settlement, navigate, paths, draftScope } = input;
  switch (settlement.kind) {
    case "in_flight":
      // ⛔ The marker is NOT cleared here. An open attempt is exactly the state the
      // buyer needs it for; the orchestrator raises the blocking panel instead.
      return;
    case "retryable":
      // A local pre-dispatch failure can occur after an earlier wallet attempt
      // left a provisional resume marker. Clear that marker, but stay on the
      // live wallet form and keep the provider-attempt sequence unchanged.
      clearCheckoutContinuation();
      return;
    case "subscription_unavailable":
      // WalletExpressRow renders the actionable error in place. In particular,
      // do not reuse the legacy disabled fallback, which would falsely imply
      // that an order exists by routing to the thank-you page.
      return;
    case "disabled":
      // A null intent (missing pickup point, empty flavors, invalid weight, or a
      // gated subscription) means no order was minted and no payment was taken.
      // Do NOT route to thank-you — that falsely tells the shopper the order
      // succeeded. Like `subscription_unavailable`, WalletExpressRow surfaces an
      // actionable "complete your details" error in place, so navigate nowhere.
      return;
    case "price_changed":
      setConfiguratorFormData({
        ...getConfiguratorFormData(draftScope),
        checkoutQuoteExpectation: null,
      }, { scope: draftScope });
      return;
    case "paid":
      clearCheckoutAttemptKey();
      clearPersistedConfiguratorFormData(draftScope);
      navigate(thankYouUrlFor(paths.thankYou, settlement));
      return;
    case "processing":
      navigate(
        paymentStatusUrlFor(paths.paymentPath, {
          orderRef: settlement.orderRef,
          orderId: settlement.orderId,
          paymentIntentId: settlement.paymentIntentId,
          clientId: settlement.clientId,
        }),
      );
      return;
    case "status":
      navigate(paymentStatusUrlFor(paths.paymentPath, settlement));
      return;
    case "failed": {
      if (
        settlement.reason === "technical" &&
        !settlement.forceFailurePage &&
        settlement.orderId &&
        settlement.paymentIntentId &&
        settlement.clientId
      ) {
        navigate(
          paymentStatusUrlFor(paths.paymentPath, {
            orderRef: settlement.orderRef,
            orderId: settlement.orderId,
            paymentIntentId: settlement.paymentIntentId,
            clientId: settlement.clientId,
            reason: "technical",
          }),
        );
        return;
      }
      clearCheckoutContinuation();
      if (walletDeclineStaysInPlace(settlement.reason)) {
        // An issuer refusal leaves the order `pending_payment` with its stock
        // hold retained, so it is a retry, not a destination. WalletExpressRow
        // renders the reason in place and the payment tiles are right there —
        // routing away would trade a one-tap retry for a page that only offers
        // "back to the configurator". The attempt identity is still renewed so
        // the retry cannot collide with the dead attempt's prepare key.
        bumpCheckoutPaymentAttempt();
        return;
      }
      // Mirror the card path's `paymentFailedUrlFor` (order + orderId when the
      // wallet minted first), then append the mapped `reason` so the failure
      // page can distinguish issuer declines from technical wallet failures.
      const base = paymentFailedUrlFor(paths.paymentFailed, {
        orderRef: settlement.orderRef,
        orderId: settlement.orderId,
        paymentIntentId: settlement.paymentIntentId,
        clientId: settlement.clientId,
        reason: settlement.reason,
      });
      if (settlement.forceFailurePage) {
        // The provider supplied a terminal outcome. A later retry stays on the
        // same order/journey but must use a new provider-attempt identity.
        bumpCheckoutPaymentAttempt();
      }
      navigate(base);
      return;
    }
  }
}

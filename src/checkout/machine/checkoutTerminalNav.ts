/**
 * Post-confirm terminal navigation for the embedded card checkout tail.
 *
 * Extracted from the page component so the routing decision is a pure, testable
 * unit AND — critically — so navigation is NEVER performed inside a React state
 * updater. Calling `navigate()` from within a `setState(updater)` runs it during
 * the render phase, where React may drop the router update while still committing
 * the cleared panel state, dumping the customer back on the payment-method step
 * after a successful charge. Callers clear `stripePay` first, then call these.
 */
import type { NavigateFunction } from "react-router-dom";

import { bumpCheckoutPaymentAttempt, clearCheckoutAttemptKey } from "./checkoutAttemptStore";
import { clearPersistedConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import {
  clearCheckoutContinuation,
  paymentFailedUrlFor,
  paymentStatusUrlFor,
  thankYouUrlFor,
} from "./checkoutNavigation";

export interface CheckoutTerminalPaths {
  thankYou: string;
  paymentFailed: string;
  paymentPath: string;
}

/**
 * Terminal poll outcomes. Defined locally (no cross-domain import) so this
 * configurator-subtree helper keeps the UI boundary clean; structurally
 * identical to the poller's terminal-status union, so the page passes its value
 * straight through and TS flags any future divergence at the call site.
 */
export type CheckoutTerminalStatus = "paid" | "failed" | "expired" | "timeout";

/**
 * Route a payment-status poller terminal after a successful `confirmPayment`.
 *
 * - `paid` → thank-you (clears the attempt key + persisted cart).
 * - `timeout` → the persistent payment-status page. The order flips to `paid`
 *   server-side only once the provider's webhook lands (minutes later), so a poll
 *   timeout is webhook lag, NOT a failure — `/platnosc` keeps waiting, and
 *   when even it runs out it says so honestly rather than claiming a failure.
 * - `failed` / `expired` → the failure page (genuine, provider-attested).
 */
export function navigatePollerTerminal(
  status: CheckoutTerminalStatus,
  /** Just the identifiers the three terminal URLs are built from. */
  ctx: { orderRef: string; orderId?: string; paymentIntentId?: string; clientId?: string },
  navigate: NavigateFunction,
  paths: CheckoutTerminalPaths,
  draftScope?: ConfiguratorDraftScope,
): void {
  // ⛔ Not unconditional. `timeout` means the poller stopped waiting, not that the
  // payment is over, and clearing there handed the buyer a terminal page with no
  // route back to a payment that was still live. Every branch that IS an answer
  // clears for itself below.
  if (status !== "timeout") clearCheckoutContinuation();
  if (status === "paid") {
    clearCheckoutAttemptKey();
    clearPersistedConfiguratorFormData(draftScope);
    navigate(thankYouUrlFor(paths.thankYou, ctx));
    return;
  }
  if (status === "timeout") {
    navigate(paymentStatusUrlFor(paths.paymentPath, ctx));
    return;
  }
  const failureUrl = paymentFailedUrlFor(paths.paymentFailed, {
    ...ctx,
    reason: status === "expired" ? "expired" : undefined,
  });
  // Provider-attested terminal outcomes are safe to retry only with a new
  // attempt identity on the same journey/order.
  bumpCheckoutPaymentAttempt();
  navigate(failureUrl);
}

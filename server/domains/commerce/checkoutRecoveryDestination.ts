import type { CheckoutRecoveryFallback } from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import {
  resolveRecoveryDestination,
  type RecoveryDestinationIntent,
} from "../../../src/domains/commerce/ports.js";
import type { CheckoutRecoverySubscriptionContextPort } from "./checkoutRecoverySubscriptionContextPort.js";
import type { CheckoutRecoveryTokenInspection } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";

type RecoveryContext =
  | CheckoutRecoveryTokenInspection
  | CheckoutRecoveryOrderSnapshot
  | { mode: string; subscriptionId?: string | null }
  | null;

/** Keeps dead recovery links inside the account whenever subscription authority exists. */
export async function fallbackForRecoveryContext(
  subscriptionContextPort: CheckoutRecoverySubscriptionContextPort,
  context: RecoveryContext,
  fallbackClientId?: string | null,
): Promise<CheckoutRecoveryFallback> {
  const knownSubscriptionContext = context?.mode === "subscription_cycle" ||
    Boolean(context && "subscriptionId" in context && context.subscriptionId);
  const clientId = clientIdOf(context) ?? fallbackClientId ?? null;
  const clientHasLiveOrPendingSubscription = !knownSubscriptionContext && clientId
    ? await subscriptionContextPort.clientHasLiveOrPendingSubscription({ clientId })
    : false;
  return checkoutFallbackForDestination(resolveRecoveryDestination({
    state: "unrecoverable",
    source: "checkout_recovery",
    orderMode: context?.mode === "subscription_cycle" || context?.mode === "one_time_order"
      ? context.mode
      : null,
    hasOrderSubscription: Boolean(context && "subscriptionId" in context && context.subscriptionId),
    clientHasLiveOrPendingSubscription,
  }));
}

function clientIdOf(context: RecoveryContext): string | null {
  return context && "clientId" in context && typeof context.clientId === "string" && context.clientId
    ? context.clientId
    : null;
}

function checkoutFallbackForDestination(intent: RecoveryDestinationIntent): CheckoutRecoveryFallback {
  return intent === "fresh_checkout" ? "fresh_checkout" : "customer_account";
}

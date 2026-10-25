import type { RecoveryDestinationPolicyInput, RecoveryDestinationIntent } from "./contracts/index.js";

export function resolveRecoveryDestination(
  input: RecoveryDestinationPolicyInput,
): RecoveryDestinationIntent {
  if (input.source === "subscription_dunning") return "account_payment_recovery";
  if (input.state === "recoverable") return "checkout_recovery";
  if (hasSubscriptionRecoveryContext(input)) return "account_payment_recovery";
  if (input.state === "terminal_expired") return "fresh_checkout";
  return "fresh_checkout";
}

export function hasSubscriptionRecoveryContext(
  input: Pick<
    RecoveryDestinationPolicyInput,
    "orderMode" | "hasOrderSubscription" | "requestedSubscriptionContext" | "clientHasLiveOrPendingSubscription"
  >,
): boolean {
  return input.orderMode === "subscription_cycle" ||
    input.hasOrderSubscription === true ||
    input.requestedSubscriptionContext === true ||
    input.clientHasLiveOrPendingSubscription === true;
}

export type RecoveryDestinationIntent =
  | "checkout_recovery"
  | "account_payment_recovery"
  | "customer_dashboard"
  | "fresh_checkout";

export type RecoveryDestinationState =
  | "recoverable"
  | "unrecoverable"
  | "terminal_expired";

export type RecoveryDestinationSource =
  | "checkout_recovery"
  | "subscription_dunning"
  | "checkout_expired";

export interface RecoveryDestinationPolicyInput {
  state: RecoveryDestinationState;
  source: RecoveryDestinationSource;
  orderMode?: "one_time_order" | "subscription_cycle" | null;
  hasOrderSubscription?: boolean;
  requestedSubscriptionContext?: boolean;
  clientHasLiveOrPendingSubscription?: boolean;
}

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

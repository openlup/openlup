import type { PaymentFailureCustomerCause } from "@openlup/core/payment";

import type {
  CustomerAccountActionRequired,
  CustomerAccountV2Response,
} from "@/domains/customers/accountV2Contracts";
import { expiredResumeChargeable } from "./subscriptionActionAvailability";

/**
 * What the account page must say about a subscription whose recovery case is
 * still open.
 *
 * The browser cannot read `editBlockedReason` for this: the account read model
 * answers `not_active` for every non-active subscription before it looks at any
 * blocker, so a subscription paused during recovery reports "must be active"
 * and the real cause disappears. The durable rule the server actually enforces
 * is "an open case exists for this subscription", and the read model already
 * publishes exactly that as an `actionRequired` entry with the message code
 * below, for `active` and `paused` alike.
 */
export interface SubscriptionArrears {
  /** The case's linked order, when it has one. */
  orderId: string | null;
  /** True when a usable recovery link can still be minted for the case. */
  recoveryEligible: boolean;
  /** When the amount falls due, or the case's last movement. */
  dueAt: string | null;
  /** The next automatic attempt, when one is scheduled. */
  nextRetryAt: string | null;
  /**
   * The overdue amount in minor units, or null when neither the case's order
   * nor a frozen recurring price can supply it. Never fabricated: a missing
   * figure is rendered as no figure, not as zero.
   */
  amountMinor: number | null;
  /**
   * The currency `amountMinor` is denominated in, or null whenever the amount is.
   *
   * It travels with the figure instead of being resolved where the banner renders it,
   * because both of its sources are records rather than quotes: the linked order's
   * stored total, or the subscription's recurring price frozen from the quote lines the
   * customer agreed to. Whichever one supplied the number also supplies what it means,
   * so the two can never disagree.
   */
  currency: string | null;
  /**
   * Why the charge failed, in the payer-facing vocabulary the emails use.
   *
   * Carried as a CODE and rendered from the shared sentence table, so the page
   * and the mail cannot describe one problem two ways. `unknown` means nothing
   * may be claimed and the surface adds no sentence — the same silence the email
   * keeps for an unclassified case.
   */
  failureCause: PaymentFailureCustomerCause;
}

const OPEN_CASE_MESSAGE_CODE: CustomerAccountActionRequired["messageCode"] = "payment_blocked";
const EXPIRED_CASE_MESSAGE_CODE: CustomerAccountActionRequired["messageCode"] = "payment_expired";

/**
 * The open-case entry for one subscription, or null. Only the open-case code
 * counts: `payment_failed` (a cycle that failed without a case) and
 * `missing_payment_method` describe different states the server does not block
 * self-service on.
 */
export function selectOpenRecoveryCase(
  actions: readonly CustomerAccountActionRequired[] | null | undefined,
  subscriptionId: string | null | undefined,
): CustomerAccountActionRequired | null {
  if (!subscriptionId) return null;
  return (
    actions?.find(
      (action) =>
        action.subscriptionId === subscriptionId &&
        action.messageCode === OPEN_CASE_MESSAGE_CODE,
    ) ?? null
  );
}

/** True when the server will refuse the gated self-service actions. */
export function hasOpenRecoveryCase(
  actions: readonly CustomerAccountActionRequired[] | null | undefined,
  subscriptionId: string | null | undefined,
): boolean {
  return selectOpenRecoveryCase(actions, subscriptionId) !== null;
}

/**
 * The figures the customer needs in order to decide what to do: how much is
 * owed and by when.
 *
 * The amount is the total of the order the case is attached to, because that is
 * the charge that did not go through. When the case carries no order — or the
 * order is older than the account's recent-order window — the subscription's
 * frozen recurring total is the same figure by construction, so it is used as
 * the fallback. When neither exists the amount is null.
 */
export function selectSubscriptionArrears(
  account: Pick<CustomerAccountV2Response, "actionRequired" | "recentOrders">,
  subscription: Pick<CustomerAccountV2Response["subscriptions"][number], "subscriptionId" | "recurringPrice">,
): SubscriptionArrears | null {
  return arrearsOf(account, subscription, selectOpenRecoveryCase(account.actionRequired, subscription.subscriptionId));
}

/**
 * The entry for a subscription whose dunning journey has ALREADY ended: every
 * retry was spent, the case is terminal and the subscription was paused for it.
 *
 * This is a different state from an open case and the page must not conflate
 * them. Nothing is retrying, no automatic attempt is coming, and the unpaid
 * cycle will never be collected -- resuming skips it and starts a new one. The
 * server enforces exactly that through
 * `subscription_resume_after_expired_dunning`, which additionally refuses while
 * the stored method cannot be charged unattended, so the page must lead with the
 * card update rather than a Resume button that would be answered with a 4xx.
 */
export function selectExpiredRecoveryCase(
  actions: readonly CustomerAccountActionRequired[] | null | undefined,
  subscriptionId: string | null | undefined,
): CustomerAccountActionRequired | null {
  if (!subscriptionId) return null;
  return (
    actions?.find(
      (action) =>
        action.subscriptionId === subscriptionId &&
        action.messageCode === EXPIRED_CASE_MESSAGE_CODE,
    ) ?? null
  );
}

/** True when the latest dunning case for this subscription is terminal-expired. */
export function hasExpiredRecoveryCase(
  actions: readonly CustomerAccountActionRequired[] | null | undefined,
  subscriptionId: string | null | undefined,
): boolean {
  return selectExpiredRecoveryCase(actions, subscriptionId) !== null;
}

/**
 * Where a repair request on a TERMINAL-EXPIRED case has to go, or null when the
 * case is not expired and the ordinary repair flow still applies.
 *
 * There is no repair flow for an expired case: the recovery-token issuer only
 * ever selects a case whose status is still `open`, so asking it about this one
 * refuses. `resume` is the way out, and it is offered only when the renewal lane
 * could actually charge the stored method -- otherwise the customer needs to add
 * one first, which is what `add_method` says.
 */
export type ExpiredRecoveryRoute = "resume" | "add_method";

export function expiredRecoveryRoute(
  account: Pick<CustomerAccountV2Response, "actionRequired" | "subscriptions">,
  subscriptionId: string | null | undefined,
): ExpiredRecoveryRoute | null {
  if (!hasExpiredRecoveryCase(account.actionRequired, subscriptionId)) return null;
  const target = account.subscriptions.find((sub) => sub.subscriptionId === subscriptionId);
  return target && expiredResumeChargeable(target.paymentMethodStatus) ? "resume" : "add_method";
}

/** The same figures as `selectSubscriptionArrears`, for the expired case. */
export function selectExpiredArrears(
  account: Pick<CustomerAccountV2Response, "actionRequired" | "recentOrders">,
  subscription: Pick<CustomerAccountV2Response["subscriptions"][number], "subscriptionId" | "recurringPrice">,
): SubscriptionArrears | null {
  return arrearsOf(account, subscription, selectExpiredRecoveryCase(account.actionRequired, subscription.subscriptionId));
}

function arrearsOf(
  account: Pick<CustomerAccountV2Response, "recentOrders">,
  subscription: Pick<CustomerAccountV2Response["subscriptions"][number], "recurringPrice">,
  entry: CustomerAccountActionRequired | null,
): SubscriptionArrears | null {
  if (!entry) return null;
  const order = entry.orderId
    ? account.recentOrders.find((candidate) => candidate.orderId === entry.orderId) ?? null
    : null;
  // The order's total wins over the frozen recurring price, and the currency is read
  // from whichever object won - never combined across the two, which is why this is one
  // `money` selection rather than two independent `??` chains.
  const money = order?.total ?? subscription.recurringPrice?.totalGross ?? null;
  return {
    orderId: entry.orderId,
    recoveryEligible: entry.recoveryEligible,
    dueAt: entry.dueAt,
    nextRetryAt: entry.nextRetryAt,
    amountMinor: money?.amountMinor ?? null,
    currency: money?.currency ?? null,
    failureCause: entry.failureCause,
  };
}

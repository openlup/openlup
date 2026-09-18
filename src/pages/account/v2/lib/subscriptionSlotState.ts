import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { liveSubscriptionForSubject } from "@/domains/subscription/accountSubscriptionSlots";
import type { SubscriptionStatusTone } from "../ui/atoms";
import {
  expiredRecoveryRoute,
  hasExpiredRecoveryCase,
  hasOpenRecoveryCase,
  type ExpiredRecoveryRoute,
} from "./dunningFacts";

/**
 * What state a subject's subscription slot is actually in, and where the surface
 * offering that subject must send the customer.
 *
 * The subject tile used to ask one question — "is the slot occupied?" — and render
 * one answer for states whose next step is completely different: a running plan,
 * a pause the customer chose, a pause a failed charge imposed, and a first
 * payment that never completed. A paused subscription was labelled "active" and
 * the only control offered was a one-time order, so the customer was steered away
 * from the thing that would fix it.
 *
 * ⛔ This selector decides a DESTINATION, never an action. Resume after an
 * expired dunning case needs a chargeable stored method and the charge-timing
 * confirmation; `SubscriptionScreen` and `handleRepair` are where those
 * preconditions are enforced. A surface that acts on this state directly
 * reintroduces the subscription that never charges and never ships.
 *
 * It composes published facts only — `status` from the account contract, the
 * recovery-case codes from {@link ./dunningFacts}, and the slot predicate from
 * `@/domains/subscription/accountSubscriptionSlots` — so it adds no vocabulary
 * and asks the server nothing new. It is deliberately the single answer for every
 * surface that has to render this question, because `DeliveryHero` and
 * `SubscriptionScreen` already carry private copies of half of it.
 */
export type SubscriptionSlotStateKind =
  /** No subscription occupies this subject's slot. */
  | "free"
  /** Live and paid, nothing blocking it. */
  | "running"
  /** Paused with no recovery case — the customer chose this. */
  | "paused_by_customer"
  /** A recovery case is still open: retries are still coming. */
  | "payment_open_case"
  /** The dunning journey ended without collecting. Nothing will retry. */
  | "payment_expired_case"
  /** The first charge never completed, so the plan never started. */
  | "activation_unpaid";

/** Where the primary control goes. `repair` means the account's repair funnel. */
export type SubscriptionSlotDestination = "subscription" | "repair";

export interface SubscriptionSlotState {
  kind: SubscriptionSlotStateKind;
  /** The occupying subscription, or null when the slot is free. */
  subscriptionId: string | null;
  /** Null only for a free slot. */
  destination: SubscriptionSlotDestination | null;
  /** Null only for a free slot. */
  tone: SubscriptionStatusTone | null;
  /** Present for a running plan, so the badge can name the rhythm. */
  cadenceDays: number | null;
  /**
   * For `payment_expired_case` only: whether the repair funnel will offer a
   * resume or ask for a method first. The two need different words, so the
   * surface must not guess.
   */
  expiredRoute: ExpiredRecoveryRoute | null;
}

const FREE: SubscriptionSlotState = {
  kind: "free",
  subscriptionId: null,
  destination: null,
  tone: null,
  cadenceDays: null,
  expiredRoute: null,
};

/**
 * ⛔ Order matters. A recovery case, open or expired, outranks `paused` — the
 * customer must see why the subscription stopped, not a neutral pause they never
 * chose. `SubscriptionScreen` states the same precedence for the same reason.
 *
 * A subscription whose only blocker is `editBlockedReason` reads as running or
 * customer-paused, exactly as it does today: the read model answers `not_active`
 * for every non-active subscription before it looks at any blocker, so that field
 * cannot carry this question.
 */
export function subscriptionSlotState(
  account: Pick<CustomerAccountV2Response, "actionRequired" | "subscriptions">,
  subjectId: string,
): SubscriptionSlotState {
  const subscription = liveSubscriptionForSubject(account.subscriptions, subjectId);
  if (!subscription) return FREE;

  const subscriptionId = subscription.subscriptionId;
  const base = {
    subscriptionId,
    cadenceDays: subscription.cadenceDays ?? null,
    expiredRoute: null,
  } as const;

  if (subscription.status === "pending_activation") {
    return { ...base, kind: "activation_unpaid", destination: "repair", tone: "pending" };
  }
  if (hasOpenRecoveryCase(account.actionRequired, subscriptionId)) {
    return { ...base, kind: "payment_open_case", destination: "repair", tone: "blocked" };
  }
  if (hasExpiredRecoveryCase(account.actionRequired, subscriptionId)) {
    return {
      ...base,
      kind: "payment_expired_case",
      destination: "repair",
      tone: "blocked",
      expiredRoute: expiredRecoveryRoute(account, subscriptionId),
    };
  }
  if (subscription.status === "paused") {
    return { ...base, kind: "paused_by_customer", destination: "subscription", tone: "paused" };
  }
  return { ...base, kind: "running", destination: "subscription", tone: "active" };
}

import type { Subscription } from "./subscriptionEditModel";

export type SubscriptionUiAction =
  | "edit"
  | "manage_addons"
  | "reschedule"
  | "skip"
  | "order_now"
  | "pause"
  | "resume"
  | "cancel"
  | "reactivate"
  | "change_address";

export interface SubscriptionActionAvailability {
  visible: boolean;
  enabled: boolean;
  reason: Subscription["editBlockedReason"];
  reasonKey: string | null;
  recoveryCta: boolean;
}

const REASON_KEYS: Record<NonNullable<Subscription["editBlockedReason"]>, string> = {
  not_active: "account:dashboard.subscriptionV2.blocked.notActive",
  edit_window_closed: "account:dashboard.subscriptionV2.blocked.editWindowClosed",
  cycle_locked: "account:dashboard.subscriptionV2.blocked.cycleLocked",
  payment_blocked: "account:dashboard.subscriptionV2.blocked.paymentBlocked",
  missing_payment_method: "account:dashboard.subscriptionV2.blocked.missingPaymentMethod",
};

/**
 * The actions the durable RPC still accepts while a recovery case is open.
 * Mirrors `customer_self_service_apply_subscription_action`: the guard added in
 * migration 20260711131000 raises `customer_self_service_payment_blocked` for
 * every action except `change_shipping_address`, and the cancel wrapper added in
 * 20260721200002 handles `cancel` ahead of that guard because cancelling closes
 * the case. Everything else is answered with a 4xx, so offering it is a lie.
 */
const ALLOWED_WHILE_PAYMENT_BLOCKED: ReadonlySet<SubscriptionUiAction> = new Set([
  "change_address",
  "cancel",
]);

/**
 * The actions the RPC accepts once the case is TERMINAL-expired rather than
 * open. `resume` joins the set because the expired-resume wrapper added in
 * migration 20260809090001 handles it ahead of every other guard — but only with
 * a stored method the renewal lane can charge, and only with the charge-timing
 * confirmation. Offering an unconditional Resume here is the exact lie this
 * wave removes: it used to succeed and leave a subscription that never charged
 * and never shipped again.
 */
const ALLOWED_WHILE_PAYMENT_EXPIRED: ReadonlySet<SubscriptionUiAction> = new Set([
  "change_address",
  "cancel",
  "resume",
]);

const EXPIRED_BLOCKED_KEY = "account:dashboard.subscriptionV2.blocked.paymentExpired";
export const EXPIRED_RESUME_NEEDS_METHOD_KEY = "account:dashboard.subscriptionV2.blocked.expiredResumeNeedsMethod";
const EXPIRED_RESUME_READY_KEY = "account:dashboard.subscriptionV2.blocked.expiredResumeReady";

/**
 * The server's own precondition for an expired-dunning resume, asked of the fact
 * the payload already carries: can the renewal lane charge the stored method
 * unattended? `expiring` counts, because that lane still charges it.
 *
 * Exported so the red banner and the lifecycle card ask ONE question. They sit on
 * the same page describing the same subscription; a private copy of this rule in
 * either of them is a future contradiction.
 */
export function expiredResumeChargeable(
  methodStatus: Subscription["paymentMethodStatus"],
): boolean {
  return methodStatus === "usable" || methodStatus === "expiring";
}

/**
 * Actions whose availability is decided by the upcoming-cycle edit window.
 * The lifecycle actions outside this set were never gated on it and are not
 * gated on it now — only on the recovery case.
 */
const EDIT_WINDOW_ACTIONS: ReadonlySet<SubscriptionUiAction> = new Set([
  "edit",
  "manage_addons",
  "reschedule",
  "skip",
  "order_now",
]);

export function subscriptionActionAvailability(
  subscription: Subscription,
  action: SubscriptionUiAction,
  options: { paymentBlocked?: boolean; paymentExpired?: boolean } = {},
): SubscriptionActionAvailability {
  const visible = action === "order_now" ? subscription.status === "active" : true;

  if (options.paymentExpired && !options.paymentBlocked) {
    if (action === "resume") {
      const chargeable = expiredResumeChargeable(subscription.paymentMethodStatus);
      return {
        visible,
        enabled: chargeable,
        reason: chargeable ? null : "missing_payment_method",
        reasonKey: chargeable ? EXPIRED_RESUME_READY_KEY : EXPIRED_RESUME_NEEDS_METHOD_KEY,
        recoveryCta: !chargeable,
      };
    }
    if (!ALLOWED_WHILE_PAYMENT_EXPIRED.has(action)) {
      return {
        visible,
        enabled: false,
        reason: "payment_blocked",
        reasonKey: EXPIRED_BLOCKED_KEY,
        recoveryCta: true,
      };
    }
  }

  if (options.paymentBlocked && !ALLOWED_WHILE_PAYMENT_BLOCKED.has(action)) {
    return {
      visible,
      enabled: false,
      reason: "payment_blocked",
      reasonKey: REASON_KEYS.payment_blocked,
      recoveryCta: true,
    };
  }

  if (!EDIT_WINDOW_ACTIONS.has(action)) {
    return { visible, enabled: visible, reason: null, reasonKey: null, recoveryCta: false };
  }

  const reason = subscription.canEditUpcomingPackage ? null : subscription.editBlockedReason;
  const enabled = visible && subscription.canEditUpcomingPackage && !reason;
  return {
    visible,
    enabled,
    reason,
    reasonKey: reason ? REASON_KEYS[reason] : null,
    recoveryCta: reason === "payment_blocked" || reason === "missing_payment_method",
  };
}

import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { PaymentStatusContinuationRequest } from "@/domains/commerce/paymentContinuationContracts";

/**
 * A one-shot decline notice handed ACROSS a remount.
 *
 * The BLIK/redirect rails learn about a refusal while the payment step is still
 * mounted, so they simply throw a `checkout:` key and the step's own alert
 * renders it. The card rail cannot: Stripe's Payment Element replaces the whole
 * configurator, and a declined card has to unmount it — the recovery page proves
 * why (`useCheckoutRecoveryPay.markDeclined`), and Stripe forbids swapping
 * `clientSecret` on a mounted `<Elements>`, so the retry needs a fresh intent
 * and a fresh mount either way. Unmounting throws away the component state that
 * would have carried the message, which is what this module replaces.
 *
 * Session-scoped and READ-ONCE on purpose: the notice belongs to the return trip
 * it was written for. Surviving a reload would be worse than losing it — a
 * buyer who reloads and sees "your bank did not authorise this payment" above a
 * form they have not submitted has been told something untrue.
 */
export const DECLINE_NOTICE_STORAGE_KEY = "checkout:decline-notice:v1";

function getSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Private-mode / blocked storage: a missing notice is a degraded message,
    // never a broken retry, so this must not surface as an error.
    return null;
  }
}

/** Records the i18n key the payment step should show once it is mounted again. */
let recoveryRequest: PaymentStatusContinuationRequest | null = null;
export function takeCheckoutRecoveryRequest(): PaymentStatusContinuationRequest | null {
  const request = recoveryRequest;
  recoveryRequest = null;
  return request;
}

export function stashCheckoutDeclineNotice(messageKey: string, request?: PaymentStatusContinuationRequest): void {
  recoveryRequest = request ? { orderId: request.orderId, paymentIntentId: request.paymentIntentId,
    clientId: request.clientId, ...(request.journeyId ? { journeyId: request.journeyId } : {}) } : null;
  getSessionStorage()?.setItem(DECLINE_NOTICE_STORAGE_KEY, messageKey);
}

/** Returns the pending notice key and consumes it. */
export function takeCheckoutDeclineNotice(): string | null {
  const storage = getSessionStorage();
  const stored = storage?.getItem(DECLINE_NOTICE_STORAGE_KEY) ?? null;
  storage?.removeItem(DECLINE_NOTICE_STORAGE_KEY);
  // Only our own vocabulary may reach `t()`; anything else is a tampered or
  // stale value and is dropped rather than rendered.
  return stored && stored.startsWith("checkout:errors.") ? stored : null;
}

/**
 * Consumes the pending notice and renders it, so the payment step can seed its
 * own error state in one expression instead of carrying the plumbing.
 */
export function takeCheckoutDeclineMessage(translate: (key: string) => string): string | null {
  const key = takeCheckoutDeclineNotice();
  return key ? translate(key) : null;
}

export function clearCheckoutDeclineNotice(): void {
  recoveryRequest = null;
  getSessionStorage()?.removeItem(DECLINE_NOTICE_STORAGE_KEY);
}

export function declineMessageKeyFor(paymentMethod: ConfiguratorFormData["paymentMethod"]): string {
  if (isCodeEntryPaymentMethod(paymentMethod)) {
    return "checkout:errors.paymentDeclinedBlik";
  }
  if (paymentMethod === "card") return "checkout:errors.paymentDeclinedCard";
  return "checkout:errors.paymentDeclinedRecoverable";
}

/**
 * The rails confirmed entirely inside the buyer's banking application, with no
 * browser handover at any point: a typed one-time code, and the saved-alias
 * variant that skips even the code. One predicate, because they are one story to
 * the buyer and one story to the wait.
 */
export function isCodeEntryPaymentMethod(paymentMethod: ConfiguratorFormData["paymentMethod"]): boolean {
  return paymentMethod === "blik" || paymentMethod === "blik_one_click";
}

/**
 * Public cross-domain admission signal. Subscription can recognize a safe
 * no-charge result without importing a commerce runtime implementation class.
 */
export function isPaymentControlSubscriptionNotChargeable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = (error as { details?: unknown }).details;
  return Boolean(
    details && typeof details === "object" &&
    (details as Record<string, unknown>).reason === "payment_control_subscription_not_chargeable"
  );
}

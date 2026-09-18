import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { useLocalizedPath } from "@/lib/i18nRoutes";
import { startCheckoutRecovery } from "@/domains/commerce/checkoutRecoveryClient";

/**
 * Orders-list "Dokończ płatność" CTA handler (W5) for a specific unpaid order.
 * Mints a fresh checkout-recovery token for the logged-in customer's own
 * `pending_payment` order (one-time OR subscription first cycle), then deep-links
 * into the same W4 pay-page used by the recovery emails. When there is nothing to
 * recover (already paid / swept) — or recovery is unavailable — it follows the
 * mode-aware fallback. Subscription first-cycle orders stay in account context
 * so the customer does not duplicate subscription/order data.
 *
 * Subscription RENEWAL failures (dunning) are NOT recovered here — those route to
 * the subscription payment-recovery path; see the orders-list routing.
 */
export interface CompleteOrderPaymentCtaOptions {
  hasSubscriptionContext?: boolean;
}

export function useCompleteOrderPaymentCta(
  accessToken: string,
): (orderId: string, options?: CompleteOrderPaymentCtaOptions) => void {
  const navigate = useNavigate();
  const localizedPath = useLocalizedPath();

  return useCallback(
    (orderId: string, options: CompleteOrderPaymentCtaOptions = {}) => {
      if (!orderId) return;
      const freshCheckoutPath = localizedPath("configurator");
      const accountPath = localizedPath("customerDashboard");
      const defaultFallbackPath = options.hasSubscriptionContext ? accountPath : freshCheckoutPath;
      void (async () => {
        try {
          const result = await startCheckoutRecovery(accessToken, { orderId });
          if (result.recoverable === true) {
            navigate(`${localizedPath("checkoutRecovery")}?token=${encodeURIComponent(result.token)}`);
            return;
          }
          navigate(result.fallback === "customer_account" ? accountPath : defaultFallbackPath);
          return;
        } catch {
          // Recovery unavailable (flag off / network) — follow the caller-known
          // context instead of guessing from a failed network response.
        }
        navigate(defaultFallbackPath);
      })();
    },
    [accessToken, navigate, localizedPath],
  );
}

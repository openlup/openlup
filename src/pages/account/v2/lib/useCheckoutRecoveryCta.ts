import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { useLocalizedPath } from "@/lib/i18nRoutes";
import { startCheckoutRecovery } from "@/domains/commerce/checkoutRecoveryClient";

/**
 * In-account "Dokończ płatność" CTA handler (W5). Mints a fresh recovery token
 * for the logged-in customer's own unpaid subscription order, then deep-links
 * into the same W4 pay-page used by the recovery emails. When there is nothing
 * to recover (already paid / swept) — or recovery is unavailable — it keeps the
 * customer in the account. Subscription customers must never be routed to a
 * fresh configurator fallback because that can duplicate subscription context.
 */
export function useCheckoutRecoveryCta(
  accessToken: string,
  subscriptionId: string | undefined,
): () => void {
  const navigate = useNavigate();
  const localizedPath = useLocalizedPath();

  return useCallback(() => {
    if (!subscriptionId) return;
    const accountPath = localizedPath("customerDashboard");
    void (async () => {
      try {
        const result = await startCheckoutRecovery(accessToken, { subscriptionId });
        if (result.recoverable) {
          navigate(`${localizedPath("checkoutRecovery")}?token=${encodeURIComponent(result.token)}`);
          return;
        }
      } catch {
        // Recovery unavailable (flag off / network) — keep account context.
      }
      navigate(accountPath);
    })();
  }, [accessToken, subscriptionId, navigate, localizedPath]);
}

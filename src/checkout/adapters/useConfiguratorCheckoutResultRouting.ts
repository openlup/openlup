import { useCallback } from "react";
import type { NavigateFunction } from "react-router-dom";

import type { WalletCheckoutSettlement } from "@/checkout/adapters/WalletExpressRow";
import type { StripePayState } from "@/checkout/adapters/SkomponujPakietStripePayPanel";
import { routeConfiguratorWalletSettlement } from "@/checkout/adapters/configuratorWalletSettlementRouting";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { CheckoutInlineRecoveryPayResponse } from "@/domains/commerce/checkoutInlineRecoveryContracts";
import { routeConfiguratorCheckoutResult } from "../machine/checkoutSubmitResultRouting";
import type { CheckoutInlineWaitStart } from "../machine/useConfiguratorPaymentWait";

type AccountComplete = NonNullable<
  Parameters<typeof routeConfiguratorCheckoutResult>[0]["onAccountOrderComplete"]
>;

export type ConfiguratorInlineRecoveryResultHandler = (
  result: CheckoutInlineRecoveryPayResponse,
  data: ConfiguratorFormData,
  journeyId: string,
) => void;

export type ConfiguratorWalletSettlementHandler = (settlement: WalletCheckoutSettlement) => void;

export function useConfiguratorCheckoutResultRouting(input: {
  navigate: NavigateFunction;
  paths: { thankYou: string; paymentFailed: string; paymentPath: string; accountStatusPath?: string; accountDashboardPath?: string };
  accountMode: boolean;
  draftScope: ConfiguratorDraftScope;
  setEmbeddedPay: (state: StripePayState) => void;
  raisePriorAttemptFromRefusal: () => boolean;
  onAccountOrderComplete?: AccountComplete;
  onInlineWait?: (start: CheckoutInlineWaitStart) => void;
}): { handleInlineRecoveryResult: ConfiguratorInlineRecoveryResultHandler; handleWalletSettled: ConfiguratorWalletSettlementHandler } {
  const { navigate, paths, accountMode, draftScope, setEmbeddedPay, raisePriorAttemptFromRefusal,
    onAccountOrderComplete, onInlineWait } = input;
  const { thankYou, paymentFailed, paymentPath, accountStatusPath, accountDashboardPath } = paths;

  const handleWalletSettled = useCallback((settlement: WalletCheckoutSettlement) => {
    if (settlement.kind === "in_flight" && raisePriorAttemptFromRefusal()) return;
    routeConfiguratorWalletSettlement({
      settlement, navigate, paths: { thankYou, paymentFailed, paymentPath }, draftScope,
      ...(accountMode && onAccountOrderComplete ? {
        account: { statusPath: accountStatusPath, dashboardPath: accountDashboardPath, onOrderComplete: onAccountOrderComplete },
      } : {}),
    });
  }, [navigate, thankYou, paymentFailed, paymentPath, draftScope, accountMode,
    onAccountOrderComplete, accountStatusPath, accountDashboardPath, raisePriorAttemptFromRefusal]);

  const handleInlineRecoveryResult = useCallback<ConfiguratorInlineRecoveryResultHandler>((result, data, journeyId) => {
    routeConfiguratorCheckoutResult({
      result, source: "inline_recovery", journeyId, data, navigate,
      paths: { thankYou, paymentPath, ...(accountStatusPath ? { accountStatusPath } : {}) },
      accountMode, hasTpayPatch: result.provider === "tpay", useStripe: result.provider === "stripe",
      draftScope, setStripePay: setEmbeddedPay,
      ...(onAccountOrderComplete ? { onAccountOrderComplete } : {}),
      ...(onInlineWait ? { onInlineWait } : {}),
    });
  }, [accountMode, accountStatusPath, draftScope, navigate, onAccountOrderComplete,
    onInlineWait, paymentPath, setEmbeddedPay, thankYou]);

  return { handleInlineRecoveryResult, handleWalletSettled };
}

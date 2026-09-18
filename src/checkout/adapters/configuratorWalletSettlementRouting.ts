import type { NavigateFunction } from "react-router-dom";

import type { WalletCheckoutSettlement } from "./WalletExpressRow";
import { bumpCheckoutPaymentAttempt, clearCheckoutAttemptKey } from "@/checkout/machine/checkoutAttemptStore";
import {
  accountOrderRetryUrlFor,
  clearCheckoutContinuation,
  paymentStatusUrlFor,
  persistAccountOrderReturn,
} from "@/checkout/machine/checkoutNavigation";
import type { ConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import {
  clearPersistedConfiguratorFormData,
  getConfiguratorFormData,
} from "@/checkout/composer/configuratorFormStore";
import { routeWalletCheckoutSettlement } from "./walletSettlementNavigation";

interface AccountWalletRouting {
  statusPath?: string;
  dashboardPath?: string;
  onOrderComplete: (summary: {
    orderRef: string;
    petName: string;
    isSubscription: boolean;
  }) => void;
}

export function routeConfiguratorWalletSettlement(input: {
  settlement: WalletCheckoutSettlement;
  navigate: NavigateFunction;
  paths: { thankYou: string; paymentFailed: string; paymentPath: string };
  draftScope: ConfiguratorDraftScope;
  account?: AccountWalletRouting;
}): void {
  const { settlement, navigate, paths, draftScope, account } = input;

  if (account) {
    if (settlement.kind === "retryable") {
      clearCheckoutContinuation();
      return;
    }
    const current = getConfiguratorFormData(draftScope);
    if (settlement.kind === "paid") {
      clearCheckoutAttemptKey();
      clearPersistedConfiguratorFormData(draftScope);
      clearCheckoutContinuation();
      account.onOrderComplete({
        orderRef: settlement.orderRef,
        petName: current.dogName,
        isSubscription: Boolean(current.subscription),
      });
      return;
    }
    if (
      account.statusPath &&
      (settlement.kind === "processing" || settlement.kind === "status") &&
      settlement.orderId &&
      settlement.paymentIntentId &&
      settlement.clientId
    ) {
      persistAccountOrderReturn({
        orderId: settlement.orderId,
        orderRef: settlement.orderRef,
        petName: current.dogName,
        isSubscription: Boolean(current.subscription),
        petId: current.accountPetId,
      });
      navigate(paymentStatusUrlFor(account.statusPath, settlement));
      return;
    }
    if (
      account.statusPath &&
      settlement.kind === "failed" &&
      settlement.reason === "technical" &&
      !settlement.forceFailurePage &&
      settlement.orderRef &&
      settlement.orderId &&
      settlement.paymentIntentId &&
      settlement.clientId
    ) {
      persistAccountOrderReturn({
        orderId: settlement.orderId,
        orderRef: settlement.orderRef,
        petName: current.dogName,
        isSubscription: Boolean(current.subscription),
        petId: current.accountPetId,
      });
      navigate(paymentStatusUrlFor(account.statusPath, { ...settlement, reason: "technical" }));
      return;
    }
    if (settlement.kind === "failed" && account.dashboardPath) {
      clearCheckoutContinuation();
      if (
        settlement.forceFailurePage &&
        settlement.orderId &&
        settlement.paymentIntentId &&
        settlement.clientId
      ) {
        // Account deterministic wallet failures bypass the public settlement
        // router, so advance the same journey's provider-attempt identity here
        // before exposing the retry entry point.
        bumpCheckoutPaymentAttempt();
      }
      navigate(accountOrderRetryUrlFor(account.dashboardPath, current.accountPetId));
      return;
    }
  }

  routeWalletCheckoutSettlement({ settlement, navigate, paths, draftScope });
}

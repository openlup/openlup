import { useCallback, useEffect, useMemo, useState } from "react";

import type { CheckoutRecoveryOrderSummary } from "@/domains/commerce/checkoutRecoveryContracts";
import {
  applyPaymentSimulatorResult,
  getChannels,
  isPayByLinkPaymentChannel,
  paymentBankPickerEnabled,
  paymentSimulatorEnabled,
  RECOVERY_PAYMENT_PROVIDER,
  type PaymentChannel,
  type PaymentCheckoutMode,
  type PaymentSimulatorResultStatus,
} from "@/checkout/adapters/paymentMethodOptions";
import { checkoutRecoveryPaymentMethods } from "./checkoutRecoveryEntry";

export function useCheckoutRecoveryMethods(
  order: CheckoutRecoveryOrderSummary | null,
  blikUnavailable: boolean,
) {
  const checkoutMode: PaymentCheckoutMode = order?.mode === "subscription_cycle" ? "subscription" : "one_time";
  const methods = useMemo(
    () => order
      ? checkoutRecoveryPaymentMethods(order).filter((method) =>
          !blikUnavailable || (method.value !== "blik" && method.value !== "blik_one_click")
        )
      : [],
    [order, blikUnavailable],
  );
  const [channels, setChannels] = useState<PaymentChannel[]>([]);
  useEffect(() => {
    if (!methods.some((method) => method.value === "transfer") || channels.length > 0) return;
    getChannels()
      .then((response) => setChannels(response.channels.filter(isPayByLinkPaymentChannel)))
      .catch(() => setChannels([]));
  }, [methods, channels.length]);

  return { checkoutMode, methods, channels, bankPickerEnabled: paymentBankPickerEnabled() };
}

export function useCheckoutRecoverySimulator(status: string) {
  const [providerPaymentId, setProviderPaymentId] = useState("");
  const [applying, setApplying] = useState<PaymentSimulatorResultStatus | null>(null);
  const applySimulator = useCallback(async (resultStatus: PaymentSimulatorResultStatus) => {
    if (!providerPaymentId || applying) return;
    setApplying(resultStatus);
    try {
      await applyPaymentSimulatorResult({ providerPaymentId, resultStatus });
    } finally {
      setApplying(null);
    }
  }, [providerPaymentId, applying]);

  return {
    applying,
    applySimulator,
    setProviderPaymentId,
    showSimulatorControls: paymentSimulatorEnabled()
      && providerPaymentId.startsWith(`${RECOVERY_PAYMENT_PROVIDER}_sim_`)
      && (status === "paying" || status === "polling"),
  };
}

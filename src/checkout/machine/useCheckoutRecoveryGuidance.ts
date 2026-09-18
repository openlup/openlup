import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRetryableAttemptStatus } from "@openlup/core/payment";
import type { PaymentStatusContinuationRequest } from "@/domains/commerce/paymentContinuationContracts";
import type { PaymentRecoveryStatusResponse } from "@/domains/commerce/paymentRecoveryGuidanceContracts";

export interface CheckoutRecoveryGuidanceReadOptions {
  statusRequest: PaymentStatusContinuationRequest | null;
  paymentAttemptId?: string | null;
  recoveryToken?: string;
  enabled?: boolean;
  currentPaid?: boolean;
}

/** A bounded read, not a second poller or a persisted source of payment truth. */
export function useCheckoutRecoveryGuidance({
  statusRequest, paymentAttemptId = null, recoveryToken, enabled = true, currentPaid = false,
}: CheckoutRecoveryGuidanceReadOptions) {
  const orderId = statusRequest?.orderId;
  const paymentIntentId = statusRequest?.paymentIntentId;
  const clientId = statusRequest?.clientId;
  const journeyId = statusRequest?.journeyId;
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ identity: object; response: PaymentRecoveryStatusResponse | null; loading: boolean } | null>(null);
  const identity = useMemo(() => ({}), [orderId, paymentIntentId, clientId, journeyId, paymentAttemptId, enabled, currentPaid, recoveryToken]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  const refresh = useCallback(async (): Promise<PaymentRecoveryStatusResponse | null> => {
    const sequence = ++generation.current;
    pending.current?.abort();
    if (!enabled || currentPaid || !orderId || !paymentIntentId || !clientId) {
      setState(null);
      return null;
    }
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let abortModuleLoad: (() => void) | undefined;
    setState({ identity, response: null, loading: true });
    try {
      // The same deadline covers loading the reader and its authenticated GET.
      const { getPaymentRecoveryStatus } = await Promise.race([
        import("@/domains/commerce/paymentRecoveryGuidanceClient"),
        new Promise<never>((_, reject) => {
          abortModuleLoad = () => reject(new Error("Recovery read aborted before dispatch"));
          if (controller.signal.aborted) abortModuleLoad();
          else controller.signal.addEventListener("abort", abortModuleLoad, { once: true });
        }),
      ]);
      if (controller.signal.aborted) throw new Error("Recovery read aborted before dispatch");
      if (sequence !== generation.current || currentIdentity.current !== identity) return null;
      const response = await getPaymentRecoveryStatus({ orderId, paymentIntentId, clientId, ...(journeyId ? { journeyId } : {}) },
        { signal: controller.signal, ...(recoveryToken ? { recoveryToken } : {}) });
      if (controller.signal.aborted || sequence !== generation.current || currentIdentity.current !== identity) return null;
      if (response.orderId !== orderId || response.paymentIntentId !== paymentIntentId
        || (paymentAttemptId && response.payment.paymentAttemptId !== paymentAttemptId)) {
        setState({ identity, response: null, loading: false });
        return null;
      }
      const guidance = response.status === "failed" && response.orderStatus !== "paid"
        && response.payment.intentStatus === "failed" && isRetryableAttemptStatus(response.payment.attemptStatus ?? "")
        && response.recoveryGuidance?.paymentAttemptId === response.payment.paymentAttemptId
        ? response.recoveryGuidance : null;
      const safeResponse = { ...response, recoveryGuidance: guidance };
      setState({ identity, response: safeResponse, loading: false });
      return safeResponse;
    } catch {
      if (sequence === generation.current && currentIdentity.current === identity) setState({ identity, response: null, loading: false });
      return null;
    } finally {
      if (abortModuleLoad) controller.signal.removeEventListener("abort", abortModuleLoad);
      clearTimeout(timeout);
    }
  }, [identity, orderId, paymentIntentId, clientId, journeyId, paymentAttemptId, enabled, currentPaid, recoveryToken]);

  useEffect(() => {
    void refresh();
    return () => { ++generation.current; pending.current?.abort(); };
  }, [refresh]);
  const visible = state?.identity === identity && enabled && !currentPaid ? state : null;
  return { response: visible?.response ?? null, guidance: visible?.response?.recoveryGuidance ?? null,
    loading: visible?.loading ?? false, refresh };
}

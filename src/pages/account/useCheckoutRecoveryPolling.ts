import { useCallback, useEffect, useRef } from "react";

import { BffClientError } from "@/lib/bff/client";
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";

const CHECKOUT_RECOVERY_POLL_INTERVAL_MS = 2_500;
const CHECKOUT_RECOVERY_POLL_ERROR_INTERVAL_MS = 5_000;
const CHECKOUT_RECOVERY_POLL_MAX_DURATION_MS = 120_000;

interface CheckoutRecoveryPollTarget {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
}

interface CheckoutRecoveryPollSnapshot {
  orderId?: string;
  paymentIntentId?: string;
  status: string;
  orderStatus: string;
  failureReason?: string | null;
  payment?: {
    provider?: string | null;
    paymentAttemptId?: string | null;
    providerPaymentId?: string | null;
  } | null;
}

interface CheckoutRecoveryPollingCallbacks {
  readStatus: (target: CheckoutRecoveryPollTarget) => Promise<CheckoutRecoveryPollSnapshot>;
  onPaid: () => void;
  onProviderPaymentId: (providerPaymentId: string) => void;
  onRecoverableDecline: (snapshot: CheckoutRecoveryPollSnapshot) => void;
  onTerminalFailure: () => void;
  onVerificationDelayed: () => void;
  onRestorableAttempt: (snapshot: CheckoutRecoveryPollSnapshot) => boolean;
}

export function useCheckoutRecoveryPolling({
  readStatus,
  onPaid,
  onProviderPaymentId,
  onRecoverableDecline,
  onTerminalFailure,
  onVerificationDelayed,
  onRestorableAttempt,
}: CheckoutRecoveryPollingCallbacks) {
  const stopRef = useRef<(() => void) | null>(null);

  const start = useCallback((summary: CheckoutRecoveryPollTarget) => {
    stopRef.current?.();
    const diagnostic = startRecoveryReadbackDiagnostic();
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    async function tick() {
      if (Date.now() - startedAt >= CHECKOUT_RECOVERY_POLL_MAX_DURATION_MS) {
        diagnostic?.settle("timeout");
        onVerificationDelayed();
        return;
      }
      try {
        const response = await readStatus({
          orderId: summary.orderId,
          paymentIntentId: summary.paymentIntentId,
          clientId: summary.clientId,
        });
        if (cancelled) return;
        if (response.payment?.providerPaymentId) {
          onProviderPaymentId(response.payment.providerPaymentId);
        }
        if (onRestorableAttempt(response)) {
          diagnostic?.settle("unknown");
          return;
        }
        if (response.status === "paid") {
          diagnostic?.settle("succeeded");
          return onPaid();
        }
        if (response.status === "failed" && response.orderStatus === "pending_payment") {
          diagnostic?.settle("rejected");
          onRecoverableDecline(response);
          return;
        }
        if (response.status === "failed" || response.status === "expired") {
          diagnostic?.settle("failed");
          onTerminalFailure();
          return;
        }
        timer = window.setTimeout(tick, CHECKOUT_RECOVERY_POLL_INTERVAL_MS);
      } catch {
        // A poll transport error is nonterminal while the poll is still scheduled.
        if (!cancelled) timer = window.setTimeout(tick, CHECKOUT_RECOVERY_POLL_ERROR_INTERVAL_MS);
      }
    }

    void tick();
    stopRef.current = () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [onPaid, onProviderPaymentId, onRecoverableDecline, onRestorableAttempt, onTerminalFailure, onVerificationDelayed, readStatus]);

  useEffect(() => () => stopRef.current?.(), []);
  return start;
}

type RecoveryReadbackDiagnosticCode = "succeeded" | "rejected" | "failed" | "unknown" | "timeout" | "transport_uncertain";

function startRecoveryReadbackDiagnostic(): { settle: (code: RecoveryReadbackDiagnosticCode, error?: unknown) => void } | null {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return null;
    const report = (phase: "attempted" | "settled", code: "observed" | RecoveryReadbackDiagnosticCode, error?: unknown): void => {
      const relatedRequestId = error instanceof BffClientError ? error.requestId : undefined;
      void reporter.then((loadedReporter) => {
        try {
          loadedReporter?.reportCustomerJourneyDiagnostic({
            action: "checkout_recovery_readback", phase, code, clientActionKey,
            ...(relatedRequestId ? { relatedRequestId } : {}),
          });
        } catch {
          // Diagnostics never change recovery polling.
        }
      }).catch(() => {});
    };
    report("attempted", "observed");
    return { settle: (code, error) => report("settled", code, error) };
  } catch {
    return null;
  }
}

import { useCallback, useState } from "react";
import { PaymentStatusPoller, type PaymentStatusPollerProps, type PollerStatusSnapshot, type PollerTerminalStatus } from "@/domains/payment/components/PaymentStatusPoller";

/** Stored server status is the only terminal authority; browser returns prove nothing. */
export function PaymentRepairStatus(props: Pick<PaymentStatusPollerProps,
  "orderId" | "paymentIntentId" | "clientId" | "fetchStatus" | "onSnapshot">) {
  const [terminal, setTerminal] = useState<PollerTerminalStatus | null>(null);
  const onTerminal = useCallback((status: PollerTerminalStatus, _snapshot: PollerStatusSnapshot | null) => setTerminal(status), []);
  return <section aria-label="Payment status">
    <PaymentStatusPoller {...props} onTerminal={onTerminal} />
    <p aria-live="polite">{terminal === "paid" ? "Payment confirmed."
      : terminal === "failed" ? "Payment failed. Repair the existing payment."
      : terminal === "expired" ? "Payment expired."
      : terminal === "timeout" ? "Confirmation is still unknown. Check again."
      : "Waiting for stored payment confirmation."}</p>
  </section>;
}

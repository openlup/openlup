import { useCallback, useState } from "react";
import type { PaymentRecoveryAction, PaymentRepairMethodPort } from "@openlup/platform/payments/contracts";
import { PaymentRepairStatus } from "@/components/PaymentRepairStatus";
import { getCommercePaymentStatus } from "@/domains/commerce/paymentStatusClient";
import { verifyCommercePaymentNow, type PaymentVerifyRequest } from "@/domains/commerce/paymentVerifyClient";
import type { PollerStatusSnapshot } from "@/domains/payment/components/PaymentStatusPoller";

type MethodResult = Awaited<ReturnType<PaymentRepairMethodPort["setupMethod"]>>;

/** Opt-in reference composition. Setup/confirmation implementations are host-owned. */
export default function ReferencePaymentRepairPage({ identity, journeyId, setupMethod, confirmAction }: {
  identity: PaymentVerifyRequest;
  journeyId?: string;
  setupMethod?: () => Promise<MethodResult>;
  confirmAction?: (action: PaymentRecoveryAction) => Promise<void>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<PaymentRecoveryAction | null>(null);
  const fetchStatus = useCallback(async (input: PaymentVerifyRequest): Promise<PollerStatusSnapshot> => {
    const stored = await getCommercePaymentStatus({ ...input, ...(journeyId ? { journeyId } : {}) });
    const next = stored.nextAction;
    setAction(next?.kind === "redirect" ? { ...next, provider: stored.payment.provider ?? "" } : null);
    return { status: stored.status, intentStatus: stored.payment.intentStatus };
  }, [journeyId]);
  async function verify() {
    setBusy(true);
    try {
      await verifyCommercePaymentNow(identity);
      // A verify response is not stored terminal truth. The poller reads it independently.
      setMessage("Verification requested. Waiting for stored confirmation.");
    } catch { setMessage("Verification unavailable. Confirmation remains unknown."); }
    finally { setBusy(false); }
  }
  async function collect() {
    setBusy(true);
    try {
      const result = setupMethod ? await setupMethod() : { kind: "unsupported" as const };
      if (result.kind === "unsupported") setMessage("Method setup is unsupported by this installation.");
      else {
        const handoff: PaymentRecoveryAction = { ...result.handoff, provider: "" };
        if (handoff.kind === "redirect") setAction(handoff);
        else if (confirmAction) { await confirmAction(handoff); setMessage("Method submitted. Waiting for server confirmation."); }
        else setMessage("Method confirmation is unsupported by this installation.");
      }
    } catch { setMessage("Method setup unavailable. The existing obligation is unchanged."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Payment repair" className="mt-8 rounded-control border border-ink/10 p-5">
    <h2 className="font-display text-2xl">Payment repair</h2>
    <PaymentRepairStatus key={`${identity.orderId}:${identity.paymentIntentId}:${identity.clientId}`} {...identity} fetchStatus={fetchStatus} />
    <button type="button" disabled={busy} onClick={() => { void verify(); }}>Verify payment now</button>
    <button type="button" disabled={busy} onClick={() => { void collect(); }}>Set up payment method</button>
    {!setupMethod && <p>Method setup is unsupported by this installation.</p>}
    {action?.kind === "redirect" && URL.canParse(action.url) && new URL(action.url).protocol === "https:" && <a href={action.url}>Continue existing payment</a>}
    {message && <p role="status">{message}</p>}
  </section>;
}

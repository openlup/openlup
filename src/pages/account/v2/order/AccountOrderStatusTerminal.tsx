import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, LoaderCircle, TimerOff, X } from "lucide-react";

import {
  PaymentStatusPoller,
  type PollerStatusSnapshot,
  type PollerTerminalStatus,
} from "@/domains/payment/components/PaymentStatusPoller";
import {
  applyTpaySimulatorPaymentResult,
  getCommercePaymentStatus,
  type TpaySimulatorResultStatus,
} from "@/domains/commerce/commerceClient";
import type { OrderRecapResponse } from "@/domains/commerce/orderRecapContracts";
import { formatCustomerOrderReference } from "@/lib/orderRef";
import { PaymentWaitDelayed } from "@/checkout/adapters/PaymentWaitDelayed";
import { tpaySimulatorUiEnabled } from "@/checkout/adapters/tpayCheckoutFlags";

import { AccountCard, CoralButton, Eyebrow, GhostButton, SectionTitle } from "../ui/atoms";
import { AccountSubscriptionActivationRepair } from "./AccountSubscriptionActivationRepair";
import { OrderSuccessShell } from "./OrderSuccessShell";

export interface AccountOrderStatusParams {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  providerPaymentId: string;
  orderRef: string;
  petId?: string | null;
  /** Original browser draft subject; null means account-new-pet. */
  draftPetId?: string | null;
}

export interface AccountOrderStatusTerminalProps {
  params: AccountOrderStatusParams;
  orderRecap: Pick<OrderRecapResponse, "mode" | "orderRef" | "petId" | "petName"> | null;
  recapSettled: boolean;
  /** Success CTA → order history. */
  onViewOrders: () => void;
  /** Subscription success CTA → subscription management. */
  onManageSubscription?: () => void;
  /** Failure CTA → back to the account dashboard. */
  onBackToAccount: () => void;
  /** Provider-attested failure/expiry → resume the account order flow. */
  onRetryOrder: () => void;
  /** Paid subscription without an active recurring mandate → account payment repair. */
  onRepairSubscription: (subscriptionId: string | null) => void;
  /** Authoritative local payment terminal, before activation/UI gating. */
  onPaymentTerminal?: (status: Exclude<PollerTerminalStatus, "timeout">) => void;
  /** Authoritative paid terminal: clear only this account/pet draft. */
  onPaid?: (petId: string | null) => void;
}

type AccountTerminalStatus = PollerTerminalStatus | "waiting_for_mandate" | "action_required";

/**
 * In-shell Tpay status/terminal body (makieta 09-terminal-sukces-konto). Reuses
 * the shared {@link PaymentStatusPoller} and {@link OrderSuccessShell}: it polls
 * the payment status to a terminal value and, on `paid`, renders the cream success
 * shell — the buyer never leaves /konto. On a staging simulator attempt it also
 * surfaces the inline Zatwierdź/Odrzuć/Wygaś controls (same logic as the public
 * PlatnoscPage) so a BLIK flow can be settled in place.
 */
export function AccountOrderStatusTerminal({
  params,
  orderRecap,
  recapSettled,
  onViewOrders,
  onManageSubscription,
  onBackToAccount,
  onRetryOrder,
  onRepairSubscription,
  onPaymentTerminal,
  onPaid,
}: AccountOrderStatusTerminalProps) {
  const { t } = useTranslation(["checkout", "account"]);
  const [terminal, setTerminal] = useState<AccountTerminalStatus | null>(null);
  const [activationSubscriptionId, setActivationSubscriptionId] = useState<string | null>(null);
  const [applying, setApplying] = useState<TpaySimulatorResultStatus | null>(null);
  // Bumped to remount the poller on a manual retry after a timeout.
  const [pollEpoch, setPollEpoch] = useState(0);
  const paidNotified = useRef(false);
  const paymentTerminalNotifiedFor = useRef<string | null>(null);

  const handleStatusSnapshot = useCallback((snapshot: PollerStatusSnapshot) => {
    if (snapshot.hostState === "waiting_for_mandate") {
      setTerminal("waiting_for_mandate");
    } else if (snapshot.hostState === "action_required") {
      setTerminal("action_required");
    }
    if (snapshot.hostReference !== undefined) setActivationSubscriptionId(snapshot.hostReference);
    if (!snapshot.paymentTerminal) return;
    const terminalIdentity = `${snapshot.paymentTerminal}:${params.orderId}:${params.paymentIntentId}`;
    if (paymentTerminalNotifiedFor.current === terminalIdentity) return;
    paymentTerminalNotifiedFor.current = terminalIdentity;
    onPaymentTerminal?.(snapshot.paymentTerminal);
  }, [onPaymentTerminal, params.orderId, params.paymentIntentId]);

  const fetchStatus = useCallback(
    async (input: { orderId: string; paymentIntentId: string; clientId: string }): Promise<PollerStatusSnapshot> => {
      const response = await getCommercePaymentStatus(input);
      const paymentTerminal = response.status === "paid" || response.status === "failed" || response.status === "expired"
        ? response.status
        : undefined;
      const activation = response.subscriptionActivation ?? {
        status: "not_applicable" as const,
        subscriptionId: null,
      };
      // A paid first subscription order may still be awaiting the distinct
      // recurring-mandate truth. Keep the shared poller active until activation
      // is actually active, or stop it for the explicit repair state.
      if (response.status === "paid" && activation.status === "waiting_for_mandate") {
        return {
          status: "processing" as const,
          intentStatus: response.payment.intentStatus,
          continuePastTimeout: true,
          paymentTerminal,
          hostState: "waiting_for_mandate",
          hostReference: activation.subscriptionId,
        };
      }
      if (response.status === "paid" && activation.status === "action_required") {
        return {
          status: "processing" as const,
          intentStatus: response.payment.intentStatus,
          continuePastTimeout: true,
          paymentTerminal,
          hostState: "action_required",
          hostReference: activation.subscriptionId,
        };
      }
      return {
        status: response.status,
        intentStatus: response.payment.intentStatus,
        ...(paymentTerminal ? { paymentTerminal } : {}),
        ...(activation.subscriptionId ? { hostReference: activation.subscriptionId } : {}),
      };
    },
    [],
  );

  const onTerminal = useCallback((status: PollerTerminalStatus) => setTerminal(status), []);

  useEffect(() => {
    if (terminal !== "paid" || paidNotified.current) return;
    paidNotified.current = true;
    onPaid?.(orderRecap?.petId ?? params.petId ?? null);
  }, [terminal, orderRecap?.petId, params.petId, onPaid]);

  if (terminal === "paid" && orderRecap?.petName) {
    const isSubscription = orderRecap.mode === "subscription";
    return (
      <OrderSuccessShell
        result={{ orderRef: orderRecap.orderRef, petName: orderRecap.petName, isSubscription }}
        onViewOrders={onViewOrders}
        onManageSubscription={isSubscription ? onManageSubscription : undefined}
      />
    );
  }

  if (terminal === "paid") {
    return (
      <div className="mx-auto max-w-[560px]" role="status" aria-live="polite">
        <AccountCard className="p-6 text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-soft-sage">
            <Check size={26} className="text-teal-dark" strokeWidth={2.5} aria-hidden />
          </span>
          <Eyebrow className="text-teal">{t("checkout:thankYou.badge")}</Eyebrow>
          <SectionTitle as="h1" className="mt-2 text-2xl">
            {t("checkout:thankYou.titleFallback")}
          </SectionTitle>
          <p className="mt-2 text-foreground/60">
            {recapSettled ? t("checkout:thankYou.body") : t("checkout:paymentStatus.body")}
          </p>
          <p className="mt-4 label-text text-foreground/45">
            {t("checkout:thankYou.orderRefLabel")}: {" "}
            <span className="font-mono normal-case text-foreground/70">
              {formatCustomerOrderReference(orderRecap?.orderRef ?? params.orderRef)}
            </span>
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <CoralButton onClick={onViewOrders}>{t("checkout:thankYou.ctaAccountOrders")}</CoralButton>
            {orderRecap?.mode === "subscription" && onManageSubscription ? (
              <GhostButton onClick={onManageSubscription}>{t("checkout:thankYou.ctaManageSubscription")}</GhostButton>
            ) : null}
          </div>
        </AccountCard>
      </div>
    );
  }

  if (terminal === "action_required") {
    return <AccountSubscriptionActivationRepair subscriptionId={activationSubscriptionId} onRepair={onRepairSubscription} />;
  }

  if (terminal === "timeout") {
    // A wait that ran out is NOT a failure, and this surface used to say it was:
    // an assertive alert, a coral X and "Płatność nieudana", over a CTA labelled
    // "Dokończ płatność" that only re-polled. We do not know this payment
    // failed — only that no answer reached us, and one that WAS taken looks
    // identical from here. Same statement as the public rail, cream shell.
    return (
      <div className="mx-auto max-w-[560px]" role="status">
        <AccountCard className="p-6 text-center">
          <PaymentWaitDelayed cream onCheckAgain={() => { setTerminal(null); setPollEpoch((epoch) => epoch + 1); }} />
          <GhostButton onClick={onBackToAccount}>{t("account:order.exit")}</GhostButton>
        </AccountCard>
      </div>
    );
  }

  if (terminal === "failed" || terminal === "expired") {
    return (
      <div className="mx-auto max-w-[560px]" role="alert" aria-live="assertive">
        <AccountCard className="p-6 text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-warm-coral/12">
            <X size={26} className="text-warm-coral" strokeWidth={2.5} aria-hidden />
          </span>
          <Eyebrow className="text-warm-coral">{t(`checkout:paymentStatus.badges.${terminal}`, {
            defaultValue: t("checkout:paymentStatus.badges.failed"),
          })}</Eyebrow>
          <SectionTitle as="h1" className="mt-2 text-2xl">{t("checkout:paymentFailed.title")}</SectionTitle>
          <p className="mt-2 text-foreground/60">{t("checkout:paymentFailed.reassure")}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <CoralButton onClick={onRetryOrder}>{t("checkout:paymentFailed.ctaRetry")}</CoralButton>
            <GhostButton onClick={onBackToAccount}>{t("account:order.exit")}</GhostButton>
          </div>
        </AccountCard>
      </div>
    );
  }

  const waitingForMandate = terminal === "waiting_for_mandate";
  const showSimulator =
    tpaySimulatorUiEnabled() && params.providerPaymentId.startsWith("tpay_sim_") && !terminal;

  async function applySimulatorResult(resultStatus: TpaySimulatorResultStatus) {
    if (applying) return;
    setApplying(resultStatus);
    try {
      await applyTpaySimulatorPaymentResult({ providerPaymentId: params.providerPaymentId, resultStatus });
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="mx-auto max-w-[560px]" role="status" aria-live="polite" data-testid="account-payment-status">
      <AccountCard className="p-6 text-center">
        <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-teal/12">
          <LoaderCircle className="h-7 w-7 animate-spin text-teal" aria-hidden />
        </span>
        <Eyebrow className="text-teal">{t("checkout:paymentStatus.badges.processing")}</Eyebrow>
        <SectionTitle as="h1" className="mt-2 text-2xl">
          {waitingForMandate
            ? t("checkout:paymentStatus.subscriptionActivation.waiting_for_mandate.title")
            : t("checkout:paymentStatus.title")}
        </SectionTitle>
        <p className="mt-2 text-foreground/60">
          {waitingForMandate
            ? t("checkout:paymentStatus.subscriptionActivation.waiting_for_mandate.body")
            : t("checkout:paymentStatus.body")}
        </p>
        {params.orderRef && (
          <p className="mt-4 label-text text-foreground/45">
            {t("checkout:paymentStatus.orderRefLabel")}:{" "}
            <span className="font-mono normal-case text-foreground/70">{formatCustomerOrderReference(params.orderRef)}</span>
          </p>
        )}
        <div className="mt-5">
          <PaymentStatusPoller
            key={pollEpoch}
            orderId={params.orderId}
            paymentIntentId={params.paymentIntentId}
            clientId={params.clientId}
            fetchStatus={fetchStatus}
            onSnapshot={handleStatusSnapshot}
            onTerminal={onTerminal}
            timeoutMs={waitingForMandate ? null : undefined}
          />
        </div>
        {showSimulator && (
          <div className="mt-6 flex flex-wrap justify-center gap-3" data-testid="account-simulator-controls">
            <CoralButton onClick={() => void applySimulatorResult("succeeded")} disabled={Boolean(applying)}>
              <Check className="h-4 w-4" aria-hidden /> {t("checkout:paymentStatus.simulatorApprove")}
            </CoralButton>
            <GhostButton onClick={() => void applySimulatorResult("failed")} disabled={Boolean(applying)}>
              <X className="h-4 w-4" aria-hidden /> {t("checkout:paymentStatus.simulatorReject")}
            </GhostButton>
            <GhostButton onClick={() => void applySimulatorResult("expired")} disabled={Boolean(applying)}>
              <TimerOff className="h-4 w-4" aria-hidden /> {t("checkout:paymentStatus.simulatorExpire")}
            </GhostButton>
          </div>
        )}
      </AccountCard>
    </div>
  );
}

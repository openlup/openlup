import { useTranslation } from "react-i18next";
import { Check, Mail, Package, Truck } from "lucide-react";

import { formatCustomerOrderReference } from "@/lib/orderRef";

import { AccountCard, CoralButton, Eyebrow, GhostButton, SectionTitle } from "../ui/atoms";

export interface OrderSuccessResult {
  orderRef: string;
  petName: string;
  isSubscription: boolean;
  /**
   * The customer already had a subscription or order before this one. Drives the
   * success copy away from the first-order "Witaj w stadzie! / Pierwszy pakiet"
   * framing for returning customers. Defaults to false (treated as first order).
   */
  returning?: boolean;
}

export interface OrderSuccessShellProps {
  result: OrderSuccessResult;
  /** Go to the customer's order history (Orders tab). */
  onViewOrders: () => void;
  /** Subscription orders only: go to subscription management. */
  onManageSubscription?: () => void;
}

/**
 * In-account success terminal (makieta 09-terminal-sukces-konto): the order is
 * confirmed inside the account shell — the customer never leaves /konto. Account-
 * only, so it renders in the cream `.account-light` scope and uses the shared
 * account atoms directly. Reuses the existing `checkout:thankYou.*` copy.
 */
export function OrderSuccessShell({ result, onViewOrders, onManageSubscription }: OrderSuccessShellProps) {
  const { t } = useTranslation(["checkout", "account"]);
  const title = result.isSubscription
    ? t(
        result.returning
          ? "checkout:thankYou.titleSubscriptionReturning"
          : "checkout:thankYou.titleSubscription",
        { name: result.petName },
      )
    : t("checkout:thankYou.titleNamed", { name: result.petName });

  const steps = [
    { icon: <Mail size={18} className="text-teal" aria-hidden />, text: t("account:order.success.step1") },
    { icon: <Package size={18} className="text-teal" aria-hidden />, text: t("account:order.success.step2") },
    { icon: <Truck size={18} className="text-teal" aria-hidden />, text: t("account:order.success.step3") },
  ];

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-soft-sage">
          <Check size={30} className="text-teal-dark" strokeWidth={2.5} aria-hidden />
        </span>
        <Eyebrow className="text-teal">{t("checkout:thankYou.badge")}</Eyebrow>
        <SectionTitle as="h1" className="mt-2 text-3xl">{title}</SectionTitle>
        <p className="mt-2 text-foreground/60">{t("account:order.success.subtitle", { pet: result.petName })}</p>
      </div>

      <AccountCard className="p-5">
        <div className="flex items-baseline justify-between gap-3 border-b border-teal-dark/8 pb-4">
          <span className="label-text text-foreground/45">{t("checkout:thankYou.orderRefLabel")}</span>
          <span className="font-mono text-sm-plus font-semibold text-foreground">
            {formatCustomerOrderReference(result.orderRef)}
          </span>
        </div>
        <p className="mt-4 mb-3 label-text text-foreground/45">{t("account:order.success.nextHeader")}</p>
        <ul className="flex flex-col gap-3">
          {steps.map((step, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal/10">{step.icon}</span>
              <span className="font-body text-sm text-foreground/75">{step.text}</span>
            </li>
          ))}
        </ul>
      </AccountCard>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <CoralButton onClick={onViewOrders}>{t("checkout:thankYou.ctaAccountOrders")}</CoralButton>
        {result.isSubscription && onManageSubscription ? (
          <GhostButton onClick={onManageSubscription}>{t("checkout:thankYou.ctaManageSubscription")}</GhostButton>
        ) : null}
      </div>
    </div>
  );
}

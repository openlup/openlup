import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";

import { AccountCard, CoralButton, Eyebrow, SectionTitle } from "../ui/atoms";

interface AccountSubscriptionActivationRepairProps {
  subscriptionId: string | null;
  onRepair: (subscriptionId: string | null) => void;
}

/** Paid initial order whose separate recurring-mandate activation needs repair. */
export function AccountSubscriptionActivationRepair({
  subscriptionId,
  onRepair,
}: AccountSubscriptionActivationRepairProps) {
  const { t } = useTranslation("checkout");

  return (
    <div className="mx-auto max-w-[560px]" role="alert" aria-live="assertive">
      <AccountCard className="p-6 text-center">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-warm-coral/12">
          <CircleAlert size={26} className="text-warm-coral" strokeWidth={2.5} aria-hidden />
        </span>
        <Eyebrow className="text-warm-coral">{t("paymentStatus.badges.paid")}</Eyebrow>
        <SectionTitle as="h1" className="mt-2 text-2xl">
          {t("paymentStatus.subscriptionActivation.action_required.title")}
        </SectionTitle>
        <p className="mt-2 text-foreground/60">
          {t("paymentStatus.subscriptionActivation.action_required.body")}
        </p>
        <CoralButton className="mt-6" onClick={() => onRepair(subscriptionId)}>
          {t("paymentStatus.subscriptionActivation.action_required.cta")}
        </CoralButton>
      </AccountCard>
    </div>
  );
}

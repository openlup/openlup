import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Subscription } from "../lib/subscriptionEditModel";
import type { AccountLang } from "../lib/format";

// `resume_after_expired` is a plain `resume` on the wire; it needs this dialog
// because the RPC demands the same charge-timing confirmation `reactivate` does
// once the subscription's dunning case has expired -- billing that had stopped
// starts again, on the same two-day interval.
export type ChargeTimingAction = "order_now" | "reactivate" | "resume_after_expired";

export function ChargeTimingDialog({
  open,
  action,
  subscription,
  lang,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  action: ChargeTimingAction | null;
  subscription: Subscription | null;
  lang: AccountLang;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("account");
  // Both non-immediate actions re-arm the next cycle two days out, which is the
  // interval the RPC writes for each of them.
  const effectiveAt = action && subscription
    ? action === "order_now"
      ? t("account:dashboard.subscriptionV2.chargeConfirm.orderNowTiming")
      : formatDate(addDays(new Date(), 2), lang)
    : "–";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="account-light border-teal-dark/10 bg-card text-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold">
            {t(`account:dashboard.subscriptionV2.chargeConfirm.${action ?? "order_now"}.title`)}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-foreground/65">
            {t(`account:dashboard.subscriptionV2.chargeConfirm.${action ?? "order_now"}.description`, {
              effectiveAt,
              paymentMethod: subscription?.paymentMethodKind ?? t("account:dashboard.subscriptionV2.paymentMethod.fallback"),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-control bg-warm-amber/10 p-4 text-sm text-foreground/70">
          {t("account:dashboard.subscriptionV2.chargeConfirm.notice")}
        </div>
        <DialogFooter className="gap-2 sm:space-x-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="focus-ring rounded-control border border-teal-dark/15 px-4 py-2 text-sm font-semibold text-foreground/70 hover:border-teal hover:text-foreground"
          >
            {t("account:dashboard.subscriptionV2.chargeConfirm.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="focus-ring rounded-control bg-warm-coral px-4 py-2 text-sm font-bold text-white shadow-warm hover:bg-warm-coral/90"
          >
            {t("account:dashboard.subscriptionV2.chargeConfirm.confirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(date: Date, lang: AccountLang): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "pl-PL", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

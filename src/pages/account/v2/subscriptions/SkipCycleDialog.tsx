import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AccountLang } from "../lib/format";
import { formatDayMonthShort, formatDeliveryWindowShort } from "../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";

export function SkipCycleDialog({
  open,
  onOpenChange,
  nextCycleAt,
  cadenceDays,
  lang,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nextCycleAt: string | null;
  cadenceDays: number;
  lang: AccountLang;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("account");
  // `nextCycleAt` is the charge instant. The customer is skipping a DELIVERY, so
  // the copy names the estimated window and states the charge separately.
  const followingCycleAt = nextCycleAt ? addDays(nextCycleAt, cadenceDays) : null;
  const skippedRange = formatDeliveryWindowShort(
    nextCycleAt ? estimateDeliveryWindow(nextCycleAt, DELIVERY_DISPATCH_POLICY) : null,
    lang,
  );
  const followingRange = formatDeliveryWindowShort(
    followingCycleAt ? estimateDeliveryWindow(followingCycleAt, DELIVERY_DISPATCH_POLICY) : null,
    lang,
  );
  const chargeDate = formatDayMonthShort(nextCycleAt, lang);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="account-light border-teal-dark/10 bg-card text-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold">
            {t("account:dashboard.subscriptionV2.skipConfirm.title")}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-foreground/65">
            {t("account:dashboard.subscriptionV2.skipConfirm.description", {
              skippedRange,
              chargeDate,
              followingRange,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-control bg-warm-amber/10 p-4 text-sm text-foreground/70">
          {t("account:dashboard.subscriptionV2.skipConfirm.noUndo")}
        </div>
        <DialogFooter className="gap-2 sm:space-x-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="focus-ring rounded-control border border-teal-dark/15 px-4 py-2 text-sm font-semibold text-foreground/70 hover:border-teal hover:text-foreground"
          >
            {t("account:dashboard.subscriptionV2.skipConfirm.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="focus-ring rounded-control bg-warm-coral px-4 py-2 text-sm font-bold text-white shadow-warm hover:bg-warm-coral/90"
          >
            {t("account:dashboard.subscriptionV2.skipConfirm.confirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

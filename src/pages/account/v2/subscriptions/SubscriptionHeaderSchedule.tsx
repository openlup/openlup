import { useTranslation } from "react-i18next";

import { stepLabelKey } from "@/domains/fulfillment/statusMap";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import type { Subscription } from "../lib/subscriptionEditModel";
import type { InFlightDelivery } from "../lib/orderFulfillment";
import type { AccountLang } from "../lib/format";
import {
  daysUntil,
  deliveryWindowNote,
  formatDayMonth,
  formatDayMonthShort,
  formatDeliveryWindowShort,
} from "../lib/format";
import { Eyebrow } from "../ui/atoms";

/**
 * The right-hand block of the subscription header.
 *
 * `subscriptions.next_cycle_at` is the CHARGE instant, never a delivery date, so
 * this block renders an estimated delivery *window* plus a secondary line that
 * states the charge date and the composition edit deadline separately. When a
 * paid box is still being fulfilled (`inFlight`), the headline is that box's real
 * fulfilment stage and the secondary line is the next renewal — a charge, which
 * is why that branch keeps `nextCycleAt` and its own countdown.
 */
export function SubscriptionHeaderSchedule({
  subscription,
  lang,
  inFlight,
}: {
  subscription: Subscription;
  lang: AccountLang;
  inFlight: InFlightDelivery | null;
}) {
  const { t } = useTranslation("account");
  const delivery = subscription.nextCycleAt
    ? estimateDeliveryWindow(subscription.nextCycleAt, DELIVERY_DISPATCH_POLICY)
    : null;
  const holidayNote = deliveryWindowNote(delivery, t);

  if (inFlight) {
    return (
      <div className="text-left sm:text-right">
        <Eyebrow>{t("account:dashboard.subscriptionV2.estimatedDeliveryEyebrow")}</Eyebrow>
        <p className="mt-1 font-display text-xl font-semibold text-foreground">
          {t(stepLabelKey(inFlight.step))}
        </p>
        {subscription.nextCycleAt ? (
          <p className="mt-0.5 text-sm text-foreground/60">
            {t("account:dashboard.subscriptionV2.nextRenewalValue", {
              date: formatDayMonth(subscription.nextCycleAt, lang),
              days: daysUntil(subscription.nextCycleAt) ?? 0,
            })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="text-left sm:text-right">
      <Eyebrow>{t("account:dashboard.subscriptionV2.estimatedDeliveryEyebrow")}</Eyebrow>
      <p className="mt-1 font-display text-xl font-semibold text-foreground">
        {subscription.nextCycleAt
          ? t("account:dashboard.subscriptionV2.estimatedDeliveryValue", {
              range: formatDeliveryWindowShort(delivery, lang),
              // Counts down to the START of the window, not to the charge.
              days: daysUntil(delivery?.fromIso ?? null) ?? 0,
            })
          : "–"}
      </p>
      {subscription.nextCycleAt ? (
        <p className="mt-0.5 text-sm text-foreground/60">
          {t("account:dashboard.subscriptionV2.chargeAndEditLine", {
            charge: formatDayMonthShort(subscription.nextCycleAt, lang),
            cutoff: formatDayMonthShort(subscription.editCutoffAt, lang),
          })}
          {/* Only rendered when a holiday actually moved the window above. */}
          {holidayNote ? ` · ${holidayNote}` : null}
        </p>
      ) : null}
    </div>
  );
}

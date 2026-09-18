import { useTranslation } from "react-i18next";
import { Package, SkipForward, Truck } from "lucide-react";
import { cn } from "@/lib/utils";

import type { AccountLang } from "../lib/format";
import { daysUntil, formatDayMonthShort } from "../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import type { InFlightDelivery } from "../lib/orderFulfillment";
import { stepLabelKey, stepUsesTruckIcon } from "@/domains/fulfillment/statusMap";

/**
 * Horizontal delivery schedule.
 *
 * When an `inFlight` first delivery is present (a paid, still-being-fulfilled
 * order — see selectInFlightDelivery), it renders as node 0 (coral, the real
 * nearest delivery, NOT editable). Every later node is a delivery estimate
 * projected from `nextCycleAt + n·cadenceDays`; raw renewal/charge dates belong
 * in the subscription facts, never inside a delivery timeline.
 */
export function DeliveryTimeline({
  nextCycleAt,
  cadenceDays,
  lang,
  count = 5,
  inFlight = null,
  onSkip,
}: {
  nextCycleAt: string | null;
  cadenceDays: number;
  lang: AccountLang;
  count?: number;
  inFlight?: InFlightDelivery | null;
  onSkip?: () => void;
}) {
  const { t } = useTranslation("account");
  if (!nextCycleAt) return null;

  const hasInFlight = Boolean(inFlight);
  const projectedCount = hasInFlight ? Math.max(1, count - 1) : count;
  const base = new Date(nextCycleAt);
  const nodes = Array.from({ length: projectedCount }).flatMap((_, index) => {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + index * cadenceDays);
    const chargeIso = date.toISOString();
    // The projected head is coral only when there is no real in-flight parcel
    // ahead of it. Its date is still an estimated delivery in both branches.
    // Node labels stay SINGLE dates in the SHORT numeric format — a measured
    // container constraint. The node box is 54.8-58px at 375px, where the long
    // form wraps to two lines for most months ("30 czerwca" = 58px), and 88.9px
    // at 1280px (narrower than tablet, because the account nav appears at lg:).
    // The short form is ~37-46px and fits at every breakpoint; a range would be
    // ~87px and break node alignment outright. So a delivery node shows the START
    // of its estimated window and the shared note under the timeline states that
    // the plan is derived from renewal/charge dates.
    const window = estimateDeliveryWindow(chargeIso, DELIVERY_DISPATCH_POLICY);
    // A host-supplied OSS policy can fail validation. Omitting a projection is
    // safer than crashing the account or falling back to the charge date and
    // presenting a renewal as if it were a delivery.
    if (!window) return [];
    const shownIso = window.fromIso;
    return [{
      iso: chargeIso,
      label: formatDayMonthShort(shownIso, lang),
      days: daysUntil(shownIso),
      nearest: index === 0 && !hasInFlight,
    }];
  });

  return (
    <div>
      <div className="relative">
        <div className="absolute left-4 right-4 top-[18px] h-px bg-teal-dark/12" aria-hidden />
        <ol className="relative flex justify-between gap-1">
          {inFlight ? (
            <li className="flex flex-1 flex-col items-center gap-2 text-center">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-warm-coral text-white shadow-warm">
                {stepUsesTruckIcon(inFlight.step) ? <Truck size={16} /> : <Package size={16} />}
              </span>
              <span className="text-xs-plus font-bold text-foreground">
                {t("account:dashboard.subscriptionV2.inFlightLabel")}
              </span>
              <span className="text-xxs text-foreground/55">
                {t(stepLabelKey(inFlight.step))}
              </span>
            </li>
          ) : null}
          {nodes.map((node) => (
            <li key={node.iso} className="flex flex-1 flex-col items-center gap-2 text-center">
              <span
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-full",
                  node.nearest
                    ? "bg-warm-coral text-white shadow-warm"
                    : "border-2 border-teal bg-card text-teal",
                )}
              >
                {node.nearest ? (
                  <Truck size={16} />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-teal" />
                )}
              </span>
              <span className="text-xs-plus font-bold text-foreground">{node.label}</span>
              <span className="text-xxs text-foreground/55">
                {node.nearest
                  ? t("account:dashboard.subscriptionV2.schedule.nearest")
                  : node.days != null
                    ? t("account:dashboard.subscriptionV2.schedule.inDays", { days: node.days })
                    : t("account:dashboard.subscriptionV2.schedule.planned")}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-4 text-xxs text-foreground/55">
        {t("account:dashboard.subscriptionV2.schedule.estimateNote")}
      </p>

      {onSkip ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-control border border-teal-dark/10 bg-card px-3 text-sm font-semibold text-foreground/70 transition-colors hover:border-teal hover:text-foreground"
          >
            <SkipForward size={16} />
            {t("account:dashboard.subscriptionV2.quickActions.skip")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

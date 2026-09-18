import { useTranslation } from "react-i18next";
import { CreditCard, MapPin, Pencil, SkipForward, Pause, Play, CalendarClock, ArrowRight } from "lucide-react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import {
  addonLines,
  recipeLines,
  type Pet,
  type Subscription,
} from "../lib/subscriptionEditModel";
import { flavourView } from "../lib/flavour";
import type { InFlightDelivery } from "../lib/orderFulfillment";
import { stepLabelKey } from "@/domains/fulfillment/statusMap";
import type { AccountLang } from "../lib/format";
import {
  daysUntil,
  deliveryWindowNote,
  formatDeliveryWindowLong,
  formatShortWeekdayDayMonth,
  formatWeekdayDayMonth,
} from "../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import {
  AccountCard,
  CoralButton,
  Eyebrow,
  GhostButton,
  SectionTitle,
  StatusBadge,
  type SubscriptionStatusTone,
} from "../ui/atoms";
import { CanChip } from "../subscriptions/CanChip";
import { FlavourMixBar, type MixSegment } from "../subscriptions/FlavourMixBar";
import type { SubscriptionActions } from "../subscriptions/SubscriptionScreen";

type Address = CustomerAccountV2Response["addresses"][number];
const PAYMENT_BLOCKERS = new Set(["payment_blocked", "missing_payment_method"]);

function tone(subscription: Subscription): SubscriptionStatusTone {
  if (subscription.editBlockedReason && PAYMENT_BLOCKERS.has(subscription.editBlockedReason)) return "blocked";
  if (subscription.status === "paused") return "paused";
  return "active";
}

function paymentLabel(kind: string | null, t: (k: string) => string): string {
  const key = kind?.toLowerCase();
  if (key === "blik" || key === "card" || key === "transfer") {
    return t(`account:dashboard.subscriptionV2.paymentMethod.${key}`);
  }
  return kind ?? t("account:dashboard.subscriptionV2.paymentMethod.fallback");
}

export function DeliveryHero({
  subscription,
  pet,
  address,
  lang,
  actions,
  inFlight = null,
  onManage,
}: {
  subscription: Subscription;
  pet: Pet | null;
  address: Address | null;
  lang: AccountLang;
  actions: SubscriptionActions;
  inFlight?: InFlightDelivery | null;
  onManage: () => void;
}) {
  const { t } = useTranslation("account");
  const breed = pet?.breed ?? null;
  const statusTone = tone(subscription);
  const canEdit = subscription.canEditUpcomingPackage && statusTone !== "blocked";
  const recipes = recipeLines(subscription);
  const addons = addonLines(subscription);
  const cans = recipes.reduce((sum, line) => sum + line.qty, 0);
  // `nextCycleAt` is the CHARGE instant. The panel promises a DELIVERY, so both
  // the countdown and the date line come from the estimated delivery window.
  const delivery = subscription.nextCycleAt
    ? estimateDeliveryWindow(subscription.nextCycleAt, DELIVERY_DISPATCH_POLICY)
    : null;
  const deliveryDays = daysUntil(delivery?.fromIso ?? null);
  // Absent unless a public holiday actually stretched the window.
  const holidayNote = deliveryWindowNote(delivery, t);
  const petName = pet?.name ?? "";
  const paused = subscription.status === "paused";

  const segments: MixSegment[] = recipes.map((line) => {
    const view = flavourView(line.flavourSlug ?? line.productSlug ?? line.recipeName ?? line.title, breed, lang);
    return {
      label: line.displayLabel ?? view.label ?? line.title ?? "",
      qty: line.qty,
      color: line.accentColor ?? view.color,
    };
  });

  return (
    <AccountCard className="grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* Left: package preview */}
      <div className="p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <Eyebrow>{t("account:dashboard.start.hero.eyebrow", { pet: petName })}</Eyebrow>
          <StatusBadge tone={statusTone}>
            {t(`account:dashboard.subscriptionV2.status.${statusTone}`)}
          </StatusBadge>
        </div>
        <div className="mt-2 flex items-center gap-3">
          {pet?.photoUrl ? (
            <img src={pet.photoUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
          ) : null}
          <SectionTitle className="text-xl">
            {[breed, pet?.weightKg ? `${pet.weightKg} kg` : null].filter(Boolean).join(" · ")}
          </SectionTitle>
        </div>

        <div className="mt-5 flex flex-wrap gap-4">
          {recipes.map((line) => {
            const view = flavourView(line.flavourSlug ?? line.productSlug ?? line.recipeName ?? line.title, breed, lang);
            return (
              <CanChip
                key={line.lineId}
                image={view.image}
                label={line.displayLabel ?? view.label ?? line.title ?? ""}
                qty={line.qty}
                color={line.accentColor ?? view.color}
              />
            );
          })}
          {addons.map((line) => (
            <CanChip key={line.lineId} image={null} label={line.title ?? ""} qty={line.qty} addon />
          ))}
        </div>

        {segments.length > 0 ? (
          <div className="mt-5">
            <FlavourMixBar segments={segments} />
          </div>
        ) : null}

        <p className="mt-4 text-sm font-semibold text-foreground">
          {t("account:dashboard.subscriptionV2.package.summary", { cans, days: subscription.cadenceDays })}
        </p>

        <div className="mt-5 flex flex-wrap gap-2.5">
          <CoralButton icon={<Pencil size={16} />} onClick={actions.onEdit} disabled={!canEdit}>
            {t("account:dashboard.subscriptionV2.quickActions.edit")}
          </CoralButton>
          <GhostButton icon={<CalendarClock size={16} />} onClick={actions.onReschedule} disabled={!canEdit}>
            {t("account:dashboard.subscriptionV2.quickActions.reschedule")}
          </GhostButton>
          <GhostButton icon={<SkipForward size={16} />} onClick={actions.onSkip} disabled={!canEdit}>
            {t("account:dashboard.subscriptionV2.quickActions.skip")}
          </GhostButton>
          <GhostButton
            icon={paused ? <Play size={16} /> : <Pause size={16} />}
            onClick={paused ? actions.onResume : actions.onPause}
          >
            {t(`account:dashboard.subscriptionV2.quickActions.${paused ? "resume" : "pause"}`)}
          </GhostButton>
        </div>
      </div>

      {/* Right: dark next-delivery panel (only intentional dark surface) */}
      <div className="flex flex-col bg-void p-6 text-offwhite sm:p-7">
        <Eyebrow className="text-teal-mint">{t("account:dashboard.start.hero.estimatedDelivery")}</Eyebrow>
        {inFlight ? (
          <>
            <p className="mt-3 font-display text-2xl font-bold leading-tight">
              {t("account:dashboard.subscriptionV2.inFlightLabel")}
            </p>
            <p className="mt-1 text-sm text-offwhite/70">
              {t(stepLabelKey(inFlight.step))}
            </p>
            <p className="mt-3 text-sm font-semibold">
              <span className="font-normal text-offwhite/60">
                {t("account:dashboard.subscriptionV2.schedule.nextRenewal")}:{" "}
              </span>
              {formatWeekdayDayMonth(subscription.nextCycleAt, lang)}
            </p>
          </>
        ) : (
          <>
            <div className="mt-3 flex items-end gap-2">
              <span className="font-display text-5xl font-bold leading-none">{deliveryDays ?? 0}</span>
              <span className="pb-1 text-sm text-offwhite/70">
                {t("account:dashboard.start.hero.unit")}
                <br />
                {t("account:dashboard.start.hero.toDelivery")}
              </span>
            </div>
            <p className="mt-3 text-sm font-semibold">{formatDeliveryWindowLong(delivery, lang)}</p>
            {holidayNote ? <p className="mt-1 text-sm text-offwhite/70">{holidayNote}</p> : null}
            {subscription.editCutoffAt ? (
              <p className="mt-1 text-sm text-offwhite/70">
                {t("account:dashboard.start.hero.editCutoff", {
                  date: formatShortWeekdayDayMonth(subscription.editCutoffAt, lang),
                })}
              </p>
            ) : null}
          </>
        )}

        <div className="mt-4 space-y-2 text-sm text-offwhite/75">
          {address ? (
            <p className="flex items-center gap-2">
              <MapPin size={15} className="shrink-0 text-teal-mint" />
              {[address.line1, address.city].filter(Boolean).join(", ")}
            </p>
          ) : null}
          <p className="flex items-center gap-2">
            <CreditCard size={15} className="shrink-0 text-teal-mint" />
            {paymentLabel(subscription.paymentMethodKind, t)}
          </p>
        </div>

        <button
          type="button"
          onClick={onManage}
          className="focus-ring mt-auto inline-flex items-center justify-center gap-2 rounded-control bg-offwhite px-4 py-3 text-sm font-semibold text-void transition-transform hover:scale-[1.02] motion-reduce:hover:scale-100"
        >
          {t("account:dashboard.start.hero.manage")}
          <ArrowRight size={16} />
        </button>
      </div>
    </AccountCard>
  );
}

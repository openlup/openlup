import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";

import type { CustomerSubscriptionActionRequest } from "@/domains/customers/selfServiceContracts";
import { cn } from "@/lib/utils";
import { idempotencyKey } from "../../../DashboardPanelUtils";
import {
  RESCHEDULE_MAX_DAYS,
  RESCHEDULE_MIN_DAYS,
  rescheduleLowerBound,
  rescheduleUpperBound,
  type Subscription,
} from "../../lib/subscriptionEditModel";
import type { AccountLang } from "../../lib/format";
import {
  daysUntil,
  deliveryWindowNote,
  formatDayMonth,
  formatDayMonthShort,
  formatDeliveryWindowShort,
} from "../../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { CoralButton } from "../../ui/atoms";
import { ManageDialog } from "./ManageDialog";

/** Columns in the date grid — kept in sync with `grid-cols-3` for arrow nav. */
const GRID_COLUMNS = 3;

/** Calendar-day key (YYYY-MM-DD) for matching the current cycle date. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function RescheduleModal({
  subscription,
  lang,
  open,
  onOpenChange,
  onAction,
}: {
  subscription: Subscription;
  lang: AccountLang;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (body: CustomerSubscriptionActionRequest) => Promise<unknown> | void;
}) {
  const { t } = useTranslation("account");
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const gridLabelId = useId();
  const currentRef = useRef<HTMLButtonElement>(null);
  // Synchronous re-entrancy guard: two rapid clicks fire as separate events, so
  // the second lands before the `submitting` state (and the parent's close) have
  // flushed. A ref flips before the first `onAction` is dispatched, so the
  // double-click can't fire a second modification request (→ a second
  // "delivery rescheduled" email) for one intent.
  const submittingRef = useRef(false);

  // Every selectable day across the whole edit window — from the earliest
  // operationally allowed day (now+3d) up to the +60d horizon. Walking the
  // full window (not a fixed 21-day grid) is what lets the owner postpone past
  // the current renewal as well as pull it earlier.
  const options = useMemo(() => {
    const now = new Date();
    const lower = rescheduleLowerBound(now, subscription.editCutoffAt);
    const upper = rescheduleUpperBound(now);
    const days: string[] = [];
    for (let offset = RESCHEDULE_MIN_DAYS; offset <= RESCHEDULE_MAX_DAYS; offset += 1) {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      date.setHours(12, 0, 0, 0);
      if (date < lower) continue;
      if (date > upper) break;
      days.push(date.toISOString());
    }
    return days;
  }, [subscription.editCutoffAt]);

  const currentKey = subscription.nextCycleAt ? dayKey(subscription.nextCycleAt) : null;
  const currentOption = options.find((iso) => currentKey != null && dayKey(iso) === currentKey) ?? null;
  const rangeFrom = options.length ? formatDayMonth(options[0], lang) : "";
  const rangeTo = options.length ? formatDayMonth(options[options.length - 1], lang) : "";

  // Choosing the current renewal day is a no-op reschedule: it would still bump
  // `updated_at` and fire a reschedule email server-side. Keep the
  // confirm button disabled for it, mirroring the modal-open (nothing selected)
  // state so an active click on "obecne odnowienie" can't enable submit.
  const selectedIsCurrent =
    selected != null && currentKey != null && dayKey(selected) === currentKey;

  // Reset the choice on each open, then focus the current renewal date and
  // scroll it into the middle of the (vertically scrolling) grid — so earlier
  // dates sit above, later ones below, and the arrow keys work immediately.
  useEffect(() => {
    if (!open) return;
    setSelected(currentOption);
    setSubmitting(false);
    submittingRef.current = false;
    const raf = requestAnimationFrame(() => {
      currentRef.current?.focus({ preventScroll: true });
      currentRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentOption, open]);

  // Arrow-key roving across the 3-column grid (Left/Right within a row,
  // Up/Down between rows, Home/End to the ends). focus() scrolls the target
  // chip into view, so the keyboard both moves and scrolls the picker.
  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const chips = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    if (chips.length === 0) return;
    const from = chips.indexOf(document.activeElement as HTMLButtonElement);
    const base = from < 0 ? 0 : from;
    let to: number;
    switch (event.key) {
      case "ArrowRight": to = base + 1; break;
      case "ArrowLeft": to = base - 1; break;
      case "ArrowDown": to = base + GRID_COLUMNS; break;
      case "ArrowUp": to = base - GRID_COLUMNS; break;
      case "Home": to = 0; break;
      case "End": to = chips.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const target = chips[Math.min(Math.max(to, 0), chips.length - 1)];
    target?.focus();
    target?.click();
  }

  function confirm() {
    if (!selected || selectedIsCurrent) return;
    // Debounce: ignore rapid re-clicks until this submission resolves and the
    // modal closes (CJ64-1 — a double-click otherwise sent two modification
    // requests and two confirmation emails for one reschedule).
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    onOpenChange(false);
    void Promise.resolve(
      onAction({
        action: "slide_next_cycle",
        idempotencyKey: idempotencyKey("slide"),
        subscriptionId: subscription.subscriptionId,
        newNextCycleAt: selected,
      }),
    ).finally(() => {
      submittingRef.current = false;
      setSubmitting(false);
    });
  }

  // The PICKED day's own estimate: the preview both formats it and reads the
  // holiday flag off it, so the caveat can never describe a different day.
  const pickedEstimate = selected ? estimateDeliveryWindow(selected, DELIVERY_DISPATCH_POLICY) : null;
  const pickedNote = deliveryWindowNote(pickedEstimate, t);

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("account:dashboard.subscriptionV2.modals.reschedule.title")}
      description={t("account:dashboard.subscriptionV2.modals.reschedule.description", {
        from: rangeFrom,
        to: rangeTo,
      })}
      footer={
        // The preview lives in the footer, not beside the grid: the date list is
        // ~60 chips inside a scroll container, so anything rendered next to it is
        // off-screen at the moment of picking. The footer is outside that
        // container and always visible, and this is the action it describes.
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {selected && !selectedIsCurrent ? (
            <div role="status" aria-live="polite" className="min-w-0 text-left text-sm text-foreground/70">
              <p className="font-semibold text-foreground">
                {t("account:dashboard.subscriptionV2.modals.reschedule.summaryTitle")}
              </p>
              <p>
                {t("account:dashboard.subscriptionV2.modals.reschedule.renewalAndCharge", {
                  date: formatDayMonthShort(selected, lang),
                })}
              </p>
              <p>
                {t("account:dashboard.subscriptionV2.modals.reschedule.estimatedDelivery", {
                  window: formatDeliveryWindowShort(pickedEstimate, lang),
                })}
                {pickedNote ? ` · ${pickedNote}` : null}
              </p>
              <p>
                {t("account:dashboard.subscriptionV2.modals.reschedule.futureCadence", {
                  days: subscription.cadenceDays,
                  date: formatDayMonthShort(selected, lang),
                })}
              </p>
              {subscription.deliveryAlignment?.state === "protected" ? (
                <p>
                  {t("account:dashboard.subscriptionV2.modals.reschedule.protectedAlignment")}
                </p>
              ) : null}
            </div>
          ) : null}
          <CoralButton
            className="shrink-0 self-end whitespace-nowrap"
            icon={<ArrowRight size={16} />}
            onClick={confirm}
            disabled={!selected || selectedIsCurrent || submitting}
          >
            {t("account:dashboard.subscriptionV2.modals.reschedule.confirm")}
          </CoralButton>
        </div>
      }
    >
      {options.length === 0 ? (
        <p role="status" className="rounded-control bg-teal/10 px-3 py-2 text-sm text-foreground/70">
          {t("account:dashboard.subscriptionV2.modals.reschedule.noDates")}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-foreground/60">
            {t("account:dashboard.subscriptionV2.modals.reschedule.impact")}
          </p>
          <p id={gridLabelId} className="text-sm font-semibold text-foreground">
            {t("account:dashboard.subscriptionV2.modals.reschedule.gridLabel")}
          </p>
          <div
            role="radiogroup"
            aria-labelledby={gridLabelId}
            className="grid grid-cols-3 gap-2.5"
            onKeyDown={onGridKeyDown}
          >
            {options.map((iso, index) => {
              const active = iso === selected;
              const isCurrent = currentKey != null && dayKey(iso) === currentKey;
              const tabbable = active || (selected == null && index === 0);
              return (
                <button
                  key={iso}
                  ref={isCurrent ? currentRef : undefined}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={tabbable ? 0 : -1}
                  onClick={() => setSelected(iso)}
                  className={cn(
                    "focus-ring flex flex-col items-center gap-0.5 rounded-control border px-2 py-3 text-center transition-colors",
                    active
                      ? "border-teal bg-teal/10"
                      : isCurrent
                        ? "border-teal/40 bg-teal/5"
                        : "border-teal-dark/10 hover:border-teal",
                  )}
                >
                  <span className="text-sm font-bold text-foreground">
                    {formatDayMonth(iso, lang)}
                  </span>
                  <span className="text-xxs text-foreground/55">
                    {isCurrent
                      ? t("account:dashboard.subscriptionV2.modals.reschedule.current")
                      : t("account:dashboard.subscriptionV2.modals.reschedule.inDays", {
                          days: daysUntil(iso) ?? 0,
                        })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ManageDialog>
  );
}

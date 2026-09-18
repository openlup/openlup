import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatMoney, moneyLang } from "./configuratorPricing";
import type { StarterPlanView } from "@/checkout/machine/quoteBandPricing";

/**
 * The head of the „Twój pakiet" card: who it is for, how big it is, and — on the
 * starter offer — what a day of it costs.
 *
 * Hierarchy instead of instruction: the module used to explain itself in three
 * sentences (energy line, feeding window, cadence notice). It now states the
 * numbers and hides the arithmetic behind one desktop disclosure. What survived
 * of the explaining — „Porcję dopasowaliśmy…" — hangs off the days figure as
 * a tip rather than opening the card, because that sentence is about that one
 * number and nothing else.
 *
 * EVERY number here comes from {@link StarterPlanView}, never from a second
 * derivation. In particular the feeding figure is the plan's `intervalDays`, not
 * the package's coverage days: `starterTermsFromCoverage` clamps the interval to
 * 7/28, so dividing the payable amount by coverage would print a per-day price
 * that disagrees with the one the offer step already showed. Outside starter
 * mode there is no per-day price at all, so the cell is dropped rather than
 * invented.
 */
export function PackageCardHeader({
  petName,
  totalCans,
  feedingDays,
  starterPlan,
  dailyKcal,
  dailyGrams,
  isMobile,
}: {
  petName?: string | null;
  totalCans: number;
  /** Coverage of the configured cans; the standard-mode feeding figure. */
  feedingDays: number;
  /** Resolved starter plan, or `null` outside the starter offer. */
  starterPlan?: StarterPlanView | null;
  dailyKcal: number | null;
  dailyGrams: number | null;
  isMobile: boolean;
}) {
  const { t, i18n } = useTranslation("checkout");
  const lang = moneyLang(i18n?.language);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const name = petName?.trim();
  const days = starterPlan ? starterPlan.intervalDays : Math.round(feedingDays);
  const perDayMinor = starterPlan?.firstPerDayMinor ?? null;
  const discountPercent = starterPlan?.firstDiscountPercent ?? null;
  const daysText = t("checkout:step5.statDaysValue", { days });

  return (
    <div>
      <div className="flex items-start justify-between gap-3 md:gap-6">
        <div className="min-w-0">
          <h3 className="font-display font-semibold text-xl leading-tight text-cfg-ink md:text-2xl">
            {name
              ? t("checkout:step5.summaryHeaderNamed", { name })
              : t("checkout:step5.summaryHeader")}
          </h3>
        </div>
        {discountPercent != null && discountPercent > 0 && (
          <span
            data-testid="package-starter-pill"
            className="flex flex-none items-center whitespace-nowrap rounded-full bg-warm-coral px-3.5 py-1 font-body text-xs-plus font-bold text-void"
          >
            {t("checkout:step5.starterPill", { percent: discountPercent })}
          </span>
        )}
      </div>

      {isMobile ? (
        <>
          {/* The two amounts own the top row. The portion label and its touch-sized tip
              share the full width below, even on the narrowest phones. */}
          <div
            data-testid="package-stat-bar"
            className="mt-4 grid grid-cols-2 items-start gap-x-2 gap-y-0.5 rounded-2xl bg-cfg-ink/[0.05] px-4 py-3"
          >
            <span className="min-w-0 leading-tight">
              {/* „14 puszek", composed from the desktop cells' own value+label
                  pair. `summaryCans` reads „14 puszek ŁĄCZNIE" and wrapped this
                  column onto three lines at 390 px. */}
              <span className="block font-display font-semibold text-lg text-cfg-ink">
                {totalCans} {t("checkout:step5.statCansLabel")}
              </span>
            </span>
            {perDayMinor != null && (
              <span className="min-w-0 text-right leading-tight">
                <span className="block font-display font-semibold text-lg text-accent-teal">
                  {formatMoney(perDayMinor, lang)}
                </span>
                <span className="micro-text mt-0.5 block uppercase tracking-[0.1em] text-cfg-ink/55">
                  {t("checkout:step5.statPerDayLabel")}
                </span>
              </span>
            )}
            <span className="col-span-2 flex items-center gap-1.5 font-body text-xs-plus text-cfg-ink/70">
              <span>{daysText} {t("checkout:step5.statFeedingLabel")}</span>
              <PortionTip />
            </span>
          </div>
        </>
      ) : (
        <>
          <div
            data-testid="package-stat-bar"
            // gap-px over a CARD-coloured grid paints the separators white, the
            // way the makieta draws them; the cells carry the tint.
            className={`mt-6 grid gap-px overflow-hidden rounded-2xl border border-cfg-ink/10 bg-cfg-card ${
              perDayMinor != null ? "grid-cols-3" : "grid-cols-2"
            }`}
          >
            <Stat value={String(totalCans)} label={t("checkout:step5.statCansLabel")} />
            <Stat value={daysText} label={t("checkout:step5.statFeedingLabel")} hint={<PortionTip />} />
            {perDayMinor != null && (
              <Stat
                value={formatMoney(perDayMinor, lang)}
                label={t("checkout:step5.statPerDayLabel")}
                accent
              />
            )}
          </div>
          {dailyKcal != null && (
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-3">
              <CollapsibleTrigger
                data-testid="package-portion-disclosure-toggle"
                className="rounded-sm py-1 font-body text-xs-plus font-semibold text-accent-teal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-cfg-card"
              >
                {t(
                  detailsOpen
                    ? "checkout:step5.portionDisclosureHide"
                    : "checkout:step5.portionDisclosureShow",
                )}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="mt-1.5 max-w-[56ch] font-body text-xs-plus leading-relaxed text-cfg-ink/55">
                  {t("checkout:step5.portionDisclosureBody", {
                    kcal: dailyKcal,
                    grams: dailyGrams ?? 0,
                  })}
                </p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  accent,
  hint,
}: {
  value: string;
  label: string;
  accent?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="bg-cfg-ink/[0.05] px-5 py-4">
      <div
        className={`font-display font-semibold text-2xl-plus leading-none ${
          accent ? "text-accent-teal" : "text-cfg-ink"
        }`}
      >
        {value}
      </div>
      <div className="micro-text mt-1 flex flex-wrap items-center gap-1.5 uppercase tracking-[0.1em] text-cfg-ink/55">
        {label}
        {hint}
      </div>
    </div>
  );
}

// Fetch positioning and focus-management code only when this optional tip opens.
const PortionPopover = lazy(() => import("@/components/ui/popover").then(({ Popover, PopoverContent, PopoverTrigger }) => {
  return {
    default: function LoadedPortionPopover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <Popover defaultOpen>
          <PopoverTrigger ref={triggerRef} asChild>{trigger}</PopoverTrigger>
          <PopoverContent align="start" onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
            className="account-light configurator-light w-64 border-cfg-ink/14 bg-cfg-card p-3 font-body text-xs-plus normal-case leading-relaxed tracking-normal text-cfg-ink/80">
            {children}
          </PopoverContent>
        </Popover>
      );
    },
  };
}).catch(() => ({ default: PortionTipFallback })));

function PortionTipFallback({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => { root.current?.querySelector("button")?.focus(); }, []);
  return (
    <span ref={root} className="contents">
      {trigger}
      <span role="status" className="basis-full font-body text-xs-plus normal-case leading-relaxed tracking-normal text-cfg-ink/80">
        {children}
      </span>
    </span>
  );
}

function PortionTip() {
  const { t } = useTranslation("checkout");
  const [activated, setActivated] = useState(false);
  const trigger = (
    <button type="button" data-testid="package-portion-tip"
      aria-label={t("checkout:step5.summarySubtitle")}
      onClick={() => setActivated(true)}
      className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-full text-cfg-ink/70 transition-colors md:h-6 md:w-6 hover:text-cfg-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-cfg-card">
      <Info aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  );
  return activated ? (
    <Suspense fallback={trigger}>
      <PortionPopover trigger={trigger}>{t("checkout:step5.summarySubtitle")}</PortionPopover>
    </Suspense>
  ) : trigger;
}

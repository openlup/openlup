import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock, Pause, SkipForward } from "lucide-react";

import type { CustomerSubscriptionActionRequest } from "@/domains/customers/selfServiceContracts";
import { CANCEL_SURVEY_REASON_CODES, type CancelSurveyReasonCode } from "#cancel-survey-reasons";
import { cn } from "@/lib/utils";
import { idempotencyKey } from "../../../DashboardPanelUtils";
import {
  rescheduleLowerBound,
  rescheduleUpperBound,
  type Subscription,
} from "../../lib/subscriptionEditModel";
import type { AccountLang } from "../../lib/format";
import { deliveryWindowNote, formatDayMonthShort, formatDeliveryWindowShort } from "../../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { CoralButton } from "../../ui/atoms";
import { ManageDialog } from "./ManageDialog";

// Ported 1:1 from the legacy CancelSubscriptionModal so retention behaviour and
// the structured survey/saveOffer payloads stay identical (cream restyle only).
type PauseOfferDuration = "2_weeks" | "1_month" | "indefinite";
type OfferKind = "skip" | "reschedule" | "pause";

/**
 * The picker renders the deployment's OWN taxonomy. There is no second,
 * hand-written vocabulary and no mapper between them: the value a customer picks
 * is the value written to `subscription_retention_outcomes.cancel_reason_code`,
 * so the modal cannot drift out of the persisted set the way it had (a hand-rolled
 * union produced two live TS2322s against the seam it already typed against).
 *
 * The two lookups below are keyed by the codes this platform ships owners for —
 * this deployment's set and the Example Store's — and both fall back for a code a
 * deployment added, because the taxonomy is append-only and open by design.
 */
const OFFER_KIND_BY_REASON: Record<string, OfferKind> = {
  // "we still have plenty" — skipping one delivery is the answer, not a pause.
  too_much_food: "skip",
  too_much_product: "skip",
  // "it arrives at the wrong time" — move the renewal instead of ending it.
  delivery_issue: "reschedule",
};
const DEFAULT_OFFER_KIND: OfferKind = "pause";
const GUIDANCE_REASONS = new Set(["dog_disliked_food", "not_a_good_fit", "too_expensive"]);
const PAUSE_OFFERS: PauseOfferDuration[] = ["2_weeks", "1_month", "indefinite"];
const DEFAULT_CANCEL_REASON: CancelSurveyReasonCode = CANCEL_SURVEY_REASON_CODES[0];
const DEFAULT_PAUSE_OFFER: PauseOfferDuration = "1_month";
const RESCHEDULE_OFFER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function offerKindForReason(reason: CancelSurveyReasonCode): OfferKind {
  return OFFER_KIND_BY_REASON[reason] ?? DEFAULT_OFFER_KIND;
}
function guidanceKeyForReason(reason: CancelSurveyReasonCode): string | null {
  return GUIDANCE_REASONS.has(reason) ? reason : null;
}
// A deployment that appends a code without shipping a label still renders a
// readable option instead of a raw translation key.
function reasonLabelFallback(reason: string): string {
  return reason.replace(/_/gu, " ");
}
/**
 * The offer promises a two-week postponement, so it is measured from the CURRENT
 * renewal. Measuring from `now` — the previous behaviour — silently pulled the
 * delivery EARLIER whenever the current cycle sat further out than the offset: a
 * customer cancelling because "deliveries arrive at the wrong time" two days
 * after a box (cadence 28, renewal ~26 days out) was moved to now+17d, i.e. nine
 * days sooner, while being told we would postpone by two weeks.
 *
 * Still clamped to the window `slide_next_cycle` accepts (now+3d … now+60d), so
 * the shift can fall short at the far end — which is why the copy states the
 * resulting date rather than repeating "two weeks".
 */
function rescheduleTargetIso(nextCycleAt: string | null, editCutoffAt: string | null): string {
  const now = new Date();
  const lower = rescheduleLowerBound(now, editCutoffAt);
  const upper = rescheduleUpperBound(now);
  const current = nextCycleAt ? new Date(nextCycleAt) : null;
  const base = current && !Number.isNaN(current.getTime()) ? current : lower;
  const target = base.getTime() + RESCHEDULE_OFFER_DAYS * DAY_MS;
  const clamped = new Date(Math.min(Math.max(target, lower.getTime()), upper.getTime()));
  clamped.setHours(12, 0, 0, 0);
  return clamped.toISOString();
}

export function CancelModal({
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
  const tr = (key: string, vars?: Record<string, string>) =>
    t(`account:dashboard.panels.subscriptions.cancel.${key}`, vars);
  // One target for both the copy and the dispatched payload, so the date the
  // customer is shown is provably the date submitted.
  const rescheduleTarget = rescheduleTargetIso(subscription.nextCycleAt, subscription.editCutoffAt);
  const offerEstimate = estimateDeliveryWindow(rescheduleTarget, DELIVERY_DISPATCH_POLICY);
  const offerVars = {
    renewal: formatDayMonthShort(rescheduleTarget, lang),
    window: formatDeliveryWindowShort(offerEstimate, lang),
  };
  // Reads the OFFERED target's estimate, so the caveat describes the date the
  // body states and the button submits — never today's window.
  const offerHolidayNote = deliveryWindowNote(offerEstimate, t);
  const [reason, setReason] = useState<CancelSurveyReasonCode>(DEFAULT_CANCEL_REASON);
  const [note, setNote] = useState("");
  const [pauseDuration, setPauseDuration] = useState<PauseOfferDuration>(DEFAULT_PAUSE_OFFER);

  // Reset the survey on each open: the modal stays mounted across opens, so a
  // previous session's reason/note would otherwise be prefilled.
  useEffect(() => {
    if (!open) return;
    setReason(DEFAULT_CANCEL_REASON);
    setNote("");
    setPauseDuration(DEFAULT_PAUSE_OFFER);
  }, [open]);

  const offerKind = offerKindForReason(reason);
  const guidanceKey = guidanceKeyForReason(reason);

  function dispatch(body: CustomerSubscriptionActionRequest) {
    onOpenChange(false);
    void onAction(body);
  }

  function acceptOffer() {
    const reasonCode: CancelSurveyReasonCode = reason;
    if (offerKind === "skip") {
      dispatch({
        action: "skip_next_cycle",
        idempotencyKey: idempotencyKey("skip"),
        subscriptionId: subscription.subscriptionId,
        reason: `save_offer=skip;cancel_reason=${reasonCode}`,
      });
      return;
    }
    if (offerKind === "reschedule") {
      dispatch({
        action: "slide_next_cycle",
        idempotencyKey: idempotencyKey("slide"),
        subscriptionId: subscription.subscriptionId,
        newNextCycleAt: rescheduleTarget,
        reason: `save_offer=reschedule;cancel_reason=${reasonCode}`,
      });
      return;
    }
    const saveOfferId = `pause-${pauseDuration}`;
    dispatch({
      action: "pause",
      idempotencyKey: idempotencyKey("pause"),
      subscriptionId: subscription.subscriptionId,
      pausePreset: pauseDuration,
      survey: { reasonCode, comment: note.trim() || null, acceptedSaveOfferId: saveOfferId },
      saveOffer: { offerId: saveOfferId, kind: "pause", accepted: true },
      reason: `save_offer=pause;pause_duration=${pauseDuration};cancel_reason=${reasonCode}`,
    });
  }

  function cancelAnyway() {
    const trimmed = note.trim();
    const reasonCode: CancelSurveyReasonCode = reason;
    const offerId = offerKind === "pause" ? `pause-${pauseDuration}` : offerKind;
    const declinedLabel = offerKind === "pause" ? `pause:${pauseDuration}` : offerKind;
    dispatch({
      action: "cancel",
      idempotencyKey: idempotencyKey("cancel"),
      subscriptionId: subscription.subscriptionId,
      survey: { reasonCode, comment: trimmed || null, acceptedSaveOfferId: null },
      saveOffer: { offerId, kind: offerKind, accepted: false },
      reason: [
        `cancel_reason=${reasonCode}`,
        `save_offer_declined=${declinedLabel}`,
        ...(trimmed ? [`note=${trimmed}`] : []),
      ].join(";"),
    });
  }

  const offerIcon =
    offerKind === "skip" ? <SkipForward size={16} /> : offerKind === "reschedule" ? <CalendarClock size={16} /> : <Pause size={16} />;

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr("title")}
      description={tr("description")}
      footer={
        <>
          <button
            type="button"
            onClick={cancelAnyway}
            className="focus-ring text-sm font-semibold text-warm-coral underline-offset-2 hover:underline"
          >
            {tr("confirmCancel")}
          </button>
          <CoralButton icon={offerIcon} onClick={acceptOffer}>
            {tr(`offers.${offerKind}.cta`, offerVars)}
          </CoralButton>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold text-teal">{tr("surveyLegend")}</legend>
        {CANCEL_SURVEY_REASON_CODES.map((value) => (
          <label
            key={value}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-control border px-4 py-2.5 text-sm transition-colors",
              reason === value ? "border-teal bg-teal/10" : "border-teal-dark/10 hover:border-teal",
            )}
          >
            <input
              type="radio"
              name={`v2-cancel-${subscription.subscriptionId}`}
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
              className="size-4 accent-teal"
            />
            <span className="text-foreground">
              {t(`account:dashboard.panels.subscriptions.cancel.reasons.${value}`, {
                defaultValue: reasonLabelFallback(value),
              })}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mt-4 rounded-control border border-teal/25 bg-teal/[0.07] p-4">
        <p className="text-sm font-semibold text-teal-dark">{tr(`offers.${offerKind}.legend`)}</p>
        <p className="mt-1 text-xs-plus text-foreground/65">
          {tr(`offers.${offerKind}.body`, offerVars)}
          {/* Only the reschedule offer states a date, so only it can be deferred. */}
          {offerKind === "reschedule" && offerHolidayNote ? ` · ${offerHolidayNote}` : null}
        </p>
        {guidanceKey ? (
          <p className="mt-1 text-xs text-foreground/55">{tr(`guidance.${guidanceKey}`)}</p>
        ) : null}
        {offerKind === "pause" ? (
          <div className="mt-2 space-y-1.5">
            {PAUSE_OFFERS.map((value) => (
              <label key={value} className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground/80">
                <input
                  type="radio"
                  name={`v2-pause-offer-${subscription.subscriptionId}`}
                  value={value}
                  checked={pauseDuration === value}
                  onChange={() => setPauseDuration(value)}
                  className="size-4 accent-teal"
                />
                <span>{tr(`pauseOffers.${value}`)}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <label className="mt-4 block text-sm text-foreground/70">
        <span className="mb-1 block">{tr("noteLabel")}</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={240}
          placeholder={tr("reasonPlaceholder")}
          className="focus-ring w-full rounded-control border border-teal-dark/15 bg-card px-3 py-2 text-foreground outline-none"
        />
      </label>
    </ManageDialog>
  );
}

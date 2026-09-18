import type { Dispatch, SetStateAction } from "react";
import { CheckCircle2, Hand, MessageSquarePlus, PackageCheck, PauseCircle, RotateCcw, Truck, XCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { ActionButton, DetailSection } from "./OrderDetailBlocks";
import { buildAdminFulfillmentActionPresentation } from "./fulfillmentActionPresentation";
import { confirmation, eligibilityReason, markRefundedConfirmation } from "./ordersPageUtils";
import { type OrderActionKind, type TrackingStatus, TRACKING_STATUSES } from "./OrderDetailSections";

type MutableText = Dispatch<SetStateAction<string>>;

export function ActionsSection({
  detail,
  note,
  setNote,
  labelTrackingId,
  setLabelTrackingId,
  trackingStatus,
  setTrackingStatus,
  cancelReason,
  setCancelReason,
  markRefundedReason,
  setMarkRefundedReason,
  fulfillmentProviderKind,
  orderProviderKind,
  isPending,
  onAction,
  t,
}: {
  detail: OmsOrderDetail;
  note: string;
  setNote: MutableText;
  labelTrackingId: string;
  setLabelTrackingId: MutableText;
  trackingStatus: TrackingStatus;
  setTrackingStatus: Dispatch<SetStateAction<TrackingStatus>>;
  cancelReason: string;
  setCancelReason: MutableText;
  markRefundedReason: string;
  setMarkRefundedReason: MutableText;
  // The admin surface provider (a presence gate for the record-label mutation).
  fulfillmentProviderKind: string | null;
  // The ORDER's real fulfillment provider — drives which actions render (see below).
  orderProviderKind: string | null;
  isPending: boolean;
  onAction: (kind: OrderActionKind) => void;
  t: TFunction;
}) {
  const pendingReason = isPending ? t("admin:adminOms.eligibility.action_pending") : null;
  // Render the fulfillment actions the ORDER's provider actually supports, in a shape
  // that provider understands. For a 3PL that auto-generates the label and hands the
  // parcel over (OmniPack), the manual recordLabel/handOff buttons are meaningless, so
  // we show a read-only status chip instead. Derived purely from the capability map, so
  // this is provider-neutral (no OmniPack special-case) and leaves simulator/manual/DHL
  // — including the hidden-preview simulator used by the preview E2E — on the manual
  // chain. Null provider (no fulfillment order yet) falls back to the manual chain.
  const presentation = buildAdminFulfillmentActionPresentation(orderProviderKind, t);
  return (
    <DetailSection testId="admin-oms-actions-section" title={t("admin:adminOms.detail.actions")}>
      <Textarea
        data-testid="admin-oms-note-input"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t("admin:adminOms.actions.notePlaceholder")}
        aria-label={t("admin:adminOms.actions.notePlaceholder")}
        disabled={isPending}
        className="mb-3 min-h-24 border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted"
      />
      <div className="flex flex-wrap gap-2">
        <ActionButton icon={MessageSquarePlus} label={t("admin:adminOms.actions.addNote")} hint={presentation.hint("addNote")} testId="admin-oms-action-add-note" disabled={isPending || !detail.actionEligibility.addNote.allowed || !note.trim()} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.addNote.reason, t)} onClick={() => onAction("note")} />
        <ActionButton icon={PauseCircle} label={t("admin:adminOms.actions.hold")} hint={presentation.hint("hold")} testId="admin-oms-action-hold" disabled={isPending || !detail.actionEligibility.createHold.allowed} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.createHold.reason, t)} confirm={confirmation(t)} onClick={() => onAction("hold")} />
        <ActionButton icon={Hand} label={t("admin:adminOms.actions.release")} hint={presentation.hint("release")} testId="admin-oms-action-release" disabled={isPending || !detail.actionEligibility.releaseHold.allowed} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.releaseHold.reason, t)} confirm={confirmation(t)} onClick={() => onAction("release")} />
        <ActionButton icon={PackageCheck} label={presentation.createFulfillmentLabel} hint={presentation.hint("createFulfillment")} testId="admin-oms-action-create-fulfillment" disabled={isPending || !detail.actionEligibility.createFulfillment.allowed} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.createFulfillment.reason, t)} confirm={confirmation(t)} onClick={() => onAction("createFulfillment")} />
      </div>
      {presentation.autoDispatchNotice && (
        <p
          data-testid="admin-oms-auto-dispatch-notice"
          className="mt-4 flex items-start gap-2 rounded-md border border-teal/20 bg-teal/5 p-2 text-xs text-teal-dark"
        >
          <Truck size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          {presentation.autoDispatchNotice}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!presentation.autoLabelAndHandoff && (
          <Input data-testid="admin-oms-tracking-input" value={labelTrackingId} onChange={(event) => setLabelTrackingId(event.target.value)} placeholder={t("admin:adminOms.actions.trackingPlaceholder")} aria-label={t("admin:adminOms.actions.trackingPlaceholder")} disabled={isPending} className="w-48 border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted" />
        )}
        <Select value={trackingStatus} onValueChange={(value) => setTrackingStatus(value as TrackingStatus)} disabled={isPending}>
          <SelectTrigger
            data-testid="admin-oms-tracking-status"
            aria-label={t("admin:adminOms.actions.trackingStatusLabel")}
            className="w-44 border-warm-sand bg-offwhite text-teal-dark"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-warm-sand bg-white text-teal-dark">
            {TRACKING_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`admin:adminOms.fulfillmentStatus.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {presentation.autoLabelAndHandoff ? (
          <span
            data-testid="admin-oms-auto-label-chip"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/5 px-3 py-1 text-xs text-teal-dark"
          >
            <Truck size={13} aria-hidden="true" />
            {presentation.autoMonitorChip}
          </span>
        ) : (
          <>
            <ActionButton icon={Truck} label={t("admin:adminOms.actions.recordLabel")} hint={presentation.hint("recordLabel")} testId="admin-oms-action-record-label" disabled={isPending || !detail.actionEligibility.recordLabel.allowed || !labelTrackingId.trim() || !fulfillmentProviderKind} disabledReason={pendingReason ?? (!fulfillmentProviderKind ? t("admin:adminOms.eligibility.fulfillment_provider_not_configured") : null) ?? eligibilityReason(detail.actionEligibility.recordLabel.reason, t)} confirm={confirmation(t)} onClick={() => onAction("label")} />
            <ActionButton icon={Truck} label={t("admin:adminOms.actions.handOff")} hint={presentation.hint("handOff")} testId="admin-oms-action-handoff" disabled={isPending || !detail.actionEligibility.handOff.allowed} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.handOff.reason, t)} confirm={confirmation(t)} onClick={() => onAction("handoff")} />
          </>
        )}
        <ActionButton icon={CheckCircle2} label={t("admin:adminOms.actions.recordTracking")} hint={presentation.hint("recordTracking")} testId="admin-oms-action-record-tracking" disabled={isPending || !detail.actionEligibility.recordTrackingEvent.allowed} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.recordTrackingEvent.reason, t)} confirm={confirmation(t)} onClick={() => onAction("tracking")} />
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
        <Input data-testid="admin-oms-cancel-reason-input" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder={t("admin:adminOms.actions.cancelPlaceholder")} aria-label={t("admin:adminOms.actions.cancelPlaceholder")} disabled={isPending} className="border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted" />
        <ActionButton icon={XCircle} label={t("admin:adminOms.actions.cancel")} hint={presentation.hint("cancel")} testId="admin-oms-action-cancel" disabled={isPending || !detail.actionEligibility.cancelFulfillment.allowed || !cancelReason.trim()} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.cancelFulfillment.reason, t)} confirm={confirmation(t)} onClick={() => onAction("cancel")} />
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
        <Input data-testid="admin-oms-mark-refunded-reason-input" value={markRefundedReason} onChange={(event) => setMarkRefundedReason(event.target.value)} placeholder={t("admin:adminOms.actions.markRefundedReasonPlaceholder")} aria-label={t("admin:adminOms.actions.markRefundedReasonPlaceholder")} disabled={isPending} className="border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted" />
        <ActionButton icon={RotateCcw} label={t("admin:adminOms.actions.markRefunded")} hint={presentation.hint("markRefunded")} testId="admin-oms-action-mark-refunded" disabled={isPending || !detail.actionEligibility.markRefunded.allowed || !markRefundedReason.trim()} disabledReason={pendingReason ?? eligibilityReason(detail.actionEligibility.markRefunded.reason, t)} confirm={markRefundedConfirmation(t)} onClick={() => onAction("markRefunded")} />
      </div>
      {isPending && <p className="mt-3 text-xs text-text-muted" aria-live="polite">{t("admin:adminOms.actions.running")}</p>}
    </DetailSection>
  );
}

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, PackagePlus, ShieldAlert } from "lucide-react";
import type { TFunction } from "i18next";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { bffErrorMessage } from "@/lib/bff/errorMessage";
import type {
  AdminCommerceOrderRequestReplacementShipmentRequest,
  AdminCommerceOrderRequestReplacementShipmentResponse,
  OmsOrderDetail,
} from "@/domains/commerce/omsContracts";
import {
  OMS_REPLACEMENT_REFUSALS,
  readOmsReplacementRefusal,
  type OmsReplacementRefusal,
} from "@/domains/commerce/omsPorts";
import { ActionButton, DetailSection } from "./OrderDetailBlocks";
import { formatOperatorOrderRef } from "./ordersPageUtils";
import { compactParts } from "@/lib/utils";

export type RequestReplacementShipment = (
  accessToken: string,
  request: AdminCommerceOrderRequestReplacementShipmentRequest,
) => Promise<AdminCommerceOrderRequestReplacementShipmentResponse>;

// The four reasons the database CHECK admits, and the same four the request contract
// admits. A fifth would be refused by the constraint, so the operator is never offered one.
export const REPLACEMENT_REASONS = ["damaged", "lost", "returned_undelivered", "other"] as const;
type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

/**
 * The five holds the command refuses by name (D-R6). It releases `fulfillment_exception`
 * — and only that one — because that release is the operator's decision; every other hold
 * means something the replacement decision has not addressed, so the command stops.
 */
export const REPLACEMENT_BLOCKING_HOLDS = [
  "payment_not_succeeded", "risk_review", "address_review", "inventory_review", "manual_support",
] as const;
type BlockingHold = (typeof REPLACEMENT_BLOCKING_HOLDS)[number];

type SubmitState =
  | { status: "idle" } | { status: "submitting" }
  | { status: "done"; result: AdminCommerceOrderRequestReplacementShipmentResponse }
  | { status: "refused"; reason: OmsReplacementRefusal | null; detail: string };

/**
 * Reads the refusal out of an error, in whichever shape the BFF hands it over.
 *
 * The route settles on `details.reason` from the adapter's closed vocabulary, but the raw
 * server code is also a legitimate shape in this repository, so both are accepted and the UI
 * does not care which arrives. Anything it cannot name returns null and the operator gets the
 * honest generic sentence plus the support code, never a raw Postgres string on its own.
 *
 * ⛔ It is deliberately not limited to the five hold reasons any more. The command refuses
 * nineteen ways of its own and can propagate nine reservation refusals through the stock
 * authority, and a stockout - the likeliest refusal in production - is none of the five. When
 * only holds were named, every other refusal collapsed into "check the active holds", which is
 * advice about a condition that is not there.
 */
export function replacementRefusalReason(error: unknown): OmsReplacementRefusal | null {
  const candidates: string[] = error instanceof Error ? [error.message] : [];
  const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : null;
  if (details && typeof details === "object") {
    for (const field of ["reason", "code", "supportCode"]) {
      const value = (details as Record<string, unknown>)[field];
      if (typeof value === "string") candidates.push(value);
    }
  }
  const named = candidates.find((value): value is OmsReplacementRefusal =>
    (OMS_REPLACEMENT_REFUSALS as readonly string[]).includes(value));
  return named ?? readOmsReplacementRefusal(candidates.join(" "));
}

export function OrderDetailReplacementSection({
  accessToken,
  detail,
  isPending,
  onRequested,
  requestReplacement,
  t,
}: {
  accessToken: string | undefined;
  detail: OmsOrderDetail;
  isPending: boolean;
  onRequested: () => Promise<void>;
  requestReplacement: RequestReplacementShipment;
  t: TFunction;
}) {
  const [reason, setReason] = useState<ReplacementReason>("damaged");
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const keysRef = useRef(new Map<string, string>());
  const counterRef = useRef(0);
  useEffect(() => {
    setState({ status: "idle" });
    keysRef.current.clear();
  }, [detail.orderId]);

  // Nothing to replace before a first parcel exists: the command replaces a fulfilment row,
  // so offering the button on an order that has none would only buy a refusal.
  if (!detail.fulfillment.fulfillmentOrderId) return null;

  const activeHolds = detail.holds.filter((hold) => hold.status === "active");
  const blockingHold = activeHolds
    .map((hold) => hold.reason)
    .find((held): held is BlockingHold => REPLACEMENT_BLOCKING_HOLDS.includes(held as BlockingHold)) ?? null;
  const hasException = activeHolds.some((hold) => hold.reason === "fulfillment_exception");
  const busy = isPending || state.status === "submitting";
  const orderRef = formatOperatorOrderRef(detail.orderNumber, detail.orderId);

  const submit = async () => {
    if (!accessToken) return;
    // ⛔ Keyed on the ORDER, never on the order and the reason. Keying on the reason gave an
    // operator who picked `damaged`, reconsidered and picked `lost` a brand-new key - and a
    // second real parcel. This is the ergonomic half of that fix only: the invariant itself
    // lives in the command, which refuses while an undispatched replacement exists, because a
    // second browser tab mints a key this ref has never seen.
    const slot = detail.orderId;
    let idempotencyKey = keysRef.current.get(slot);
    if (!idempotencyKey) {
      counterRef.current += 1;
      idempotencyKey = ["admin-oms-replacement", detail.orderId.slice(0, 8), Date.now().toString(36), counterRef.current.toString(36)].join(":");
      keysRef.current.set(slot, idempotencyKey);
    }
    setState({ status: "submitting" });
    try {
      const result = await requestReplacement(accessToken, { idempotencyKey, orderId: detail.orderId, reason, metadata: { source: "admin_oms_ui" } });
      setState({ status: "done", result });
      await onRequested();
    } catch (error) {
      setState({ status: "refused", reason: replacementRefusalReason(error), detail: bffErrorMessage(error) });
    }
  };

  return (
    <DetailSection
      testId="admin-oms-replacement-section"
      title={t("admin:adminOms.replacement.title")}
      subtitle={t("admin:adminOms.replacement.subtitle")}
      icon={PackagePlus}
    >
      {/* The disclosure the whole control rests on: the operator is told, BEFORE confirming,
          that this both sends a parcel and clears the delivery exception. A button that
          silently released the exception would hide the very decision it audits. */}
      <div className="rounded-md border border-teal/20 bg-teal/5 p-3 text-sm text-text-muted">
        <p className="flex items-center gap-2 font-medium text-teal-dark">
          <ShieldAlert className="size-4" aria-hidden="true" />
          {t("admin:adminOms.replacement.whatItDoes")}
        </p>
        <p className="mt-1">{t("admin:adminOms.replacement.effectParcel")}</p>
        <p className="mt-1" data-testid="admin-oms-replacement-hold-effect">
          {hasException
            ? t("admin:adminOms.replacement.effectHold")
            : t("admin:adminOms.replacement.effectHoldAbsent")}
        </p>
        {/* The gap the operator would otherwise discover only after clicking: there is no
            surface anywhere in this admin that cancels a fulfilment order, so a parcel that
            has already gone to the warehouse cannot be recalled from here. Naming it is the
            whole difference between a known limit and a nasty surprise. */}
        <p className="mt-1" data-testid="admin-oms-replacement-no-recall">
          {t("admin:adminOms.replacement.effectNoRecall")}
        </p>
      </div>

      <ReplacementChain chain={detail.replacementChain} t={t} />

      {blockingHold ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-warm-coral" data-testid="admin-oms-replacement-blocked" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t(`admin:adminOms.replacement.blocked.blocked_by_${blockingHold}_hold`)}
        </p>
      ) : null}

      <fieldset className="mt-3" disabled={busy}>
        <legend className="label-text mb-2 text-text-muted">{t("admin:adminOms.replacement.reasonLabel")}</legend>
        <RadioGroup
          value={reason}
          onValueChange={(value) => setReason(value as ReplacementReason)}
          aria-label={t("admin:adminOms.replacement.reasonLabel")}
          className="gap-2 sm:grid-cols-2"
        >
          {REPLACEMENT_REASONS.map((option) => (
            <label key={option} htmlFor={`admin-oms-replacement-reason-${option}`} className="flex items-center gap-2 text-sm text-teal-dark">
              <RadioGroupItem
                id={`admin-oms-replacement-reason-${option}`}
                value={option}
                data-testid={`admin-oms-replacement-reason-${option}`}
                className="border-warm-sand text-teal"
              />
              {t(`admin:adminOms.replacement.reason.${option}`)}
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton
          icon={PackagePlus}
          label={t("admin:adminOms.replacement.submit")}
          hint={t("admin:adminOms.replacement.hint")}
          testId="admin-oms-action-request-replacement"
          disabled={!accessToken || busy || Boolean(blockingHold)}
          disabledReason={blockingHold
            ? t(`admin:adminOms.replacement.blocked.blocked_by_${blockingHold}_hold`)
            : busy
              ? t("admin:adminOms.eligibility.action_pending")
              : null}
          confirm={{
            title: t("admin:adminOms.replacement.confirm.title"),
            description: hasException
              ? t("admin:adminOms.replacement.confirm.descriptionWithHold", { order: orderRef })
              : t("admin:adminOms.replacement.confirm.descriptionNoHold", { order: orderRef }),
            actionLabel: t("admin:adminOms.replacement.confirm.action"),
            cancelLabel: t("admin:adminOms.confirm.cancel"),
          }}
          onClick={() => void submit()}
        />
      </div>

      {state.status === "refused" ? (
        <div className="mt-3 text-sm text-warm-coral" data-testid="admin-oms-replacement-refusal" role="status">
          <p className="font-medium">{t("admin:adminOms.replacement.blocked.title")}</p>
          <p className="mt-1">
            {state.reason && state.reason !== "unspecified_refusal"
              ? t(`admin:adminOms.replacement.blocked.${state.reason}`)
              : t("admin:adminOms.replacement.blocked.unknown", { detail: state.detail })}
          </p>
        </div>
      ) : null}

      {state.status === "done" ? (
        <div className="mt-3 text-sm text-teal-dark" data-testid="admin-oms-replacement-result" role="status">
          <p className="font-medium">{t("admin:adminOms.replacement.done")}</p>
          {/* `releasedHoldIds` is the audit trail of the decision, so it is shown as the
              exception holds that actually went — not as a vague "done". */}
          <p className="mt-1 text-text-muted">
            {state.result.releasedHoldIds.length
              ? t("admin:adminOms.replacement.releasedHolds", { count: state.result.releasedHoldIds.length })
              : t("admin:adminOms.replacement.releasedNone")}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
            {state.result.releasedHoldIds.map((holdId) => (
              <span key={holdId} className="rounded-full border border-warm-sand px-2 py-0.5 text-text-muted">
                {holdId.slice(0, 8)}
              </span>
            ))}
          </div>
          {state.result.replayed ? <p className="mt-1 text-text-muted">{t("admin:adminOms.replacement.replayed")}</p> : null}
        </div>
      ) : null}
    </DetailSection>
  );
}

/**
 * The order's other parcels, and whether the one on screen is itself a replacement.
 *
 * This exists because a replacement made the ORIGINAL parcel's tracking disappear from the
 * operator's screen at exactly the moment support needs it: R2b bound tracking references to a
 * parcel, and the detail read then narrowed everything to the parcel currently representing
 * the order. "Where did the first one go?" and "file the carrier claim" both need the number
 * that vanished. It is deliberately a short list of facts rather than a second fulfilment
 * panel - see `omsReplacementChainSchema` for why the evidence reads were not widened.
 */
function ReplacementChain({ chain, t }: { chain: OmsOrderDetail["replacementChain"]; t: TFunction }) {
  if (chain.sequenceNo === 0 && chain.supersededParcels.length === 0) return null;
  const reason = REPLACEMENT_REASONS.includes(chain.replacementReason as ReplacementReason)
    ? t(`admin:adminOms.replacement.reason.${chain.replacementReason}`)
    : t("admin:adminOms.replacement.chain.reasonUnknown");
  return (
    <div className="mt-3 rounded-md border border-warm-sand bg-offwhite p-3 text-sm" data-testid="admin-oms-replacement-chain">
      {chain.sequenceNo > 0 ? (
        <p className="font-medium text-teal-dark" data-testid="admin-oms-replacement-current-is-replacement">
          {t("admin:adminOms.replacement.chain.currentIsReplacement", { ordinal: chain.sequenceNo, reason })}
        </p>
      ) : null}
      {chain.supersededParcels.length ? (
        <p className="mt-2 text-xs font-semibold uppercase text-text-muted">
          {t("admin:adminOms.replacement.chain.previousParcels")}
        </p>
      ) : null}
      {chain.supersededParcels.map((parcel) => (
        <div key={parcel.fulfillmentOrderId} className="mt-1" data-testid={`admin-oms-replacement-superseded-${parcel.sequenceNo}`}>
          <p className="text-teal-dark">
            {t("admin:adminOms.replacement.chain.parcelLine", {
              ordinal: parcel.sequenceNo + 1,
              status: t(`admin:adminOms.fulfillmentStatus.${parcel.status ?? "none"}`),
            })}
          </p>
          {parcel.trackingReferences.length === 0 ? (
            <p className="text-xs text-text-muted">{t("admin:adminOms.replacement.chain.noTracking")}</p>
          ) : parcel.trackingReferences.map((ref) => (
            <p key={ref.trackingNumber} className="break-all text-xs text-text-muted">
              {compactParts([ref.trackingNumber, ref.carrierKind, ref.service]).join(" \u00b7 ")}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

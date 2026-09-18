import type { TFunction } from "i18next";
import { CheckCircle2, CreditCard, ListTodo, Mail, MapPin, PackageCheck, PauseCircle, Truck, type LucideIcon } from "lucide-react";
import { AdminStatusPill } from "@/components/admin/AdminSurface";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { eligibilityReason, operatorPipelineStages, type OperatorPipelineStage } from "./ordersPageUtils";
import type { OrderActionKind } from "./OrderDetailSections";

const PIPELINE_ICONS: Record<OperatorPipelineStage["key"], LucideIcon> = {
  payment: CreditCard,
  inventory: PackageCheck,
  fulfillment: Truck,
  transit: Truck,
  delivered: CheckCircle2,
};

export function DetailPipeline({ detail, t }: { detail: OmsOrderDetail; t: TFunction }) {
  return (
    <section className="rounded-card border border-warm-sand bg-offwhite p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="label-text text-teal">{t("admin:adminOms.detail.pipeline")}</p>
          <p className="mt-1 text-sm text-text-muted">{t(`admin:adminOms.orderStatus.${detail.status}`)}</p>
        </div>
        <AdminStatusPill tone={detail.paymentStatus === "succeeded" ? "good" : "bad"}>
          {t(`admin:adminOms.paymentStatus.${detail.paymentStatus}`)}
        </AdminStatusPill>
      </div>
      <div className="mt-5 grid grid-cols-5 gap-2">
        {getPipelineDetail(detail).map(({ key, icon: Icon, complete, active, blocked }) => (
          <div key={key} className="grid justify-items-center gap-2 text-center">
            <span className={pipelineIconClass({ complete, active, blocked })}>
              <Icon size={17} aria-hidden="true" />
            </span>
            <span className={blocked ? "text-xs font-bold text-warm-coral" : active ? "text-xs font-bold text-warm-amber" : "text-xs font-semibold text-text-muted"}>
              {t(`admin:adminOms.pipeline.${key}`)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TopActionBar({
  detail,
  isPending,
  onAction,
  t,
}: {
  detail: OmsOrderDetail;
  isPending: boolean;
  onAction: (kind: OrderActionKind) => void;
  t: TFunction;
}) {
  const pendingReason = isPending ? t("admin:adminOms.eligibility.action_pending") : null;
  const actions: Array<{
    kind: OrderActionKind | "email";
    label: string;
    icon: LucideIcon;
    disabled: boolean;
    reason?: string | null;
    primary?: boolean;
  }> = [
    // This only scrolls to local action controls; it neither reads a provider
    // nor changes payment state, so it cannot be presented as a payment check
    // or as the primary operational action.
    { kind: "note", label: t("admin:adminOms.actions.goToActions"), icon: ListTodo, disabled: false },
    {
      kind: detail.actionEligibility.releaseHold.allowed ? "release" : "hold",
      label: detail.actionEligibility.releaseHold.allowed ? t("admin:adminOms.actions.release") : t("admin:adminOms.actions.hold"),
      icon: PauseCircle,
      disabled: isPending || (!detail.actionEligibility.releaseHold.allowed && !detail.actionEligibility.createHold.allowed),
      reason: pendingReason ?? eligibilityReason(detail.actionEligibility.releaseHold.reason ?? detail.actionEligibility.createHold.reason, t),
    },
    {
      kind: "updateAddress",
      label: t("admin:adminOms.actions.changeAddress"),
      icon: MapPin,
      disabled: isPending || !detail.actionEligibility.updateShippingAddress.allowed,
      reason: pendingReason ?? eligibilityReason(detail.actionEligibility.updateShippingAddress.reason, t),
    },
    { kind: "email", label: t("admin:adminOms.actions.sendEmail"), icon: Mail, disabled: true, reason: "TODO(backend)" },
  ];

  return (
    <section className="flex flex-wrap gap-2 rounded-card border border-warm-sand bg-white p-3">
      {actions.map(({ kind, label, icon: Icon, disabled, reason, primary }) => (
        <button
          key={`${kind}:${label}`}
          type="button"
          disabled={disabled}
          title={disabled && reason ? `${label}: ${reason}` : label}
          onClick={() => handleTopAction(kind, onAction)}
          className={[
            "focus-ring inline-flex min-h-10 items-center gap-2 rounded-control border px-3 text-xs-plus font-bold transition",
            primary ? "border-warm-coral bg-warm-coral text-teal-dark shadow-sm" : "border-warm-sand bg-white text-teal-dark hover:bg-offwhite",
            disabled ? "cursor-not-allowed opacity-50" : "",
          ].join(" ")}
        >
          <Icon size={15} aria-hidden="true" />
          {label}
        </button>
      ))}
    </section>
  );
}

export function ActiveHoldsSection({
  detail,
  isPending,
  onAction,
  t,
}: {
  detail: OmsOrderDetail;
  isPending: boolean;
  onAction: (kind: OrderActionKind) => void;
  t: TFunction;
}) {
  const activeHolds = detail.holds.filter((hold) => hold.status === "active");
  if (activeHolds.length === 0) return null;
  return (
    <section className="rounded-card border border-warm-coral/30 bg-coral-tint p-4">
      <p className="label-text text-warm-coral">{t("admin:adminOms.detail.activeHolds", { count: activeHolds.length })}</p>
      <div className="mt-3 space-y-3">
        {activeHolds.map((hold) => (
          <div key={hold.id} className="rounded-xl border border-warm-coral/25 bg-white p-3">
            <p className="font-semibold text-warm-coral">{t(`admin:adminOms.holdReason.${hold.reason}`)}</p>
            {hold.note ? <p className="mt-1 text-sm text-text-muted">{hold.note}</p> : null}
            <button
              type="button"
              disabled={isPending || !detail.actionEligibility.releaseHold.allowed}
              onClick={() => onAction("release")}
              className="focus-ring mt-3 inline-flex min-h-9 items-center gap-2 rounded-control border border-warm-coral/40 bg-white px-3 text-xs-plus font-bold text-warm-coral disabled:opacity-50"
            >
              <PauseCircle size={14} aria-hidden="true" />
              {t("admin:adminOms.actions.release")}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function handleTopAction(kind: OrderActionKind | "email", onAction: (kind: OrderActionKind) => void) {
  if (kind === "email") return;
  if (kind === "note" || kind === "hold" || kind === "release") {
    document.querySelector('[data-testid="admin-oms-actions-section"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (kind === "updateAddress") {
    document.querySelector('[data-testid="admin-oms-address-section"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  onAction(kind);
}

function pipelineIconClass({ complete, active, blocked }: { complete: boolean; active: boolean; blocked: boolean }) {
  return [
    "flex h-10 w-10 items-center justify-center rounded-full border",
    blocked
      ? "border-warm-coral bg-coral-tint text-warm-coral"
      : complete
        ? "border-teal bg-light-teal text-teal"
        : active
          ? "border-warm-amber bg-warm-sand text-warm-amber"
          : "border-warm-sand bg-white text-text-muted",
  ].join(" ");
}

function getPipelineDetail(detail: OmsOrderDetail) {
  return operatorPipelineStages(detail).map((stage) => ({ ...stage, icon: PIPELINE_ICONS[stage.key] }));
}

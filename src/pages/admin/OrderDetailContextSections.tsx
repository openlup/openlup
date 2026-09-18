import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { DetailSection, InfoBlock } from "./OrderDetailBlocks";
import { formatDate, formatDayShort, formatMoney } from "./ordersPageUtils";
import { compactParts, valueOrDash } from "@/lib/utils";

export function SubscriptionSection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  if (!detail.subscription.subscriptionId && !detail.subscription.subscriptionCycleId) return null;
  // The delivery estimate is anchored on the cycle's CHARGE instant (paid_at).
  // `commerce_orders` has no paid_at, so one-time orders fall through to a dash.
  const estimate = detail.subscription.cyclePaidAt ? estimateDeliveryWindow(detail.subscription.cyclePaidAt, DELIVERY_DISPATCH_POLICY) : null;
  return (
    <section data-testid="admin-oms-subscription-section" className="grid gap-3 md:grid-cols-3">
      <InfoBlock label={t("admin:adminOms.detail.subscription")} value={valueOrDash(detail.subscription.subscriptionId)} meta={t(`admin:adminOms.mode.${detail.mode}`)} />
      <InfoBlock label={t("admin:adminOms.detail.subscriptionCycle")} value={valueOrDash(detail.subscription.subscriptionCycleId)} meta={detail.subscription.subscriptionCycleStatus ?? t("admin:adminOms.detail.notAvailable")} />
      <InfoBlock label={t("admin:adminOms.detail.orderMode")} value={t(`admin:adminOms.mode.${detail.mode}`)} meta={detail.status} />
      <InfoBlock
        label={t("admin:adminOms.detail.chargeTaken")}
        value={valueOrDash(formatNullableDate(detail.subscription.cyclePaidAt, locale))}
        meta=""
      />
      <InfoBlock
        label={t("admin:adminOms.detail.nextRenewalCharge")}
        value={valueOrDash(formatNullableDate(detail.subscription.nextCycleAt, locale))}
        meta=""
      />
      <InfoBlock
        label={t("admin:adminOms.detail.estimatedDelivery")}
        value={estimate ? `${formatDayShort(estimate.fromIso, locale)} – ${formatDayShort(estimate.toIso, locale)}` : "-"}
        // Operator-facing only: support must see WHY the window is what it is.
        // ⛔ Never surface cut-off mechanics to customers.
        meta={estimate ? t(`admin:adminOms.detail.dispatchReason.${estimate.reason}`, { date: formatDayShort(estimate.dispatchAtIso, locale) }) : ""}
      />
    </section>
  );
}

export function PaymentHistorySection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  return (
    <DetailSection testId="admin-oms-payment-history-section" title={t("admin:adminOms.detail.paymentHistory")}>
      <div className="grid gap-3 md:grid-cols-3">
        <InfoBlock label={t("admin:adminOms.detail.paymentIntent")} value={valueOrDash(detail.payment.intentId)} meta={t(`admin:adminOms.paymentStatus.${detail.payment.status}`)} />
        <InfoBlock label={t("admin:adminOms.detail.activeAttempt")} value={valueOrDash(detail.payment.activeAttemptId)} meta={detail.payment.updatedAt ? formatDate(detail.payment.updatedAt, locale) : ""} />
        <InfoBlock label={t("admin:adminOms.detail.providerPayment")} value={valueOrDash(detail.payment.providerPaymentId)} meta={valueOrDash(detail.payment.paymentId)} />
      </div>
      <DetailList
        title={t("admin:adminOms.detail.paymentAttempts")}
        empty={t("admin:adminOms.detail.noPaymentAttempts")}
        rows={detail.paymentAttempts.map((attempt) => ({
          key: attempt.id,
          title: `${attempt.provider} · ${t(`admin:adminOms.paymentAttemptStatus.${attempt.status}`)}`,
          meta: compactParts([attempt.providerAttemptId, attempt.nextActionKind, formatDate(attempt.updatedAt, locale)]).join(" · "),
        }))}
      />
      <DetailList
        title={t("admin:adminOms.detail.paymentTransitions")}
        empty={t("admin:adminOms.detail.noPaymentTransitions")}
        rows={detail.paymentTransitions.map((transition) => ({
          key: transition.id,
          title: `${transition.fromStatus ?? "none"} -> ${transition.toStatus}`,
          meta: compactParts([transition.transitionKind, transition.reason, formatDate(transition.occurredAt, locale)]).join(" · "),
        }))}
      />
    </DetailSection>
  );
}

export function InventoryFulfillmentSection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  return (
    <section data-testid="admin-oms-inventory-fulfillment-section" className="grid gap-3 md:grid-cols-2">
      <DetailSection title={t("admin:adminOms.detail.inventory")}>
        <div className="grid gap-3">
          <InfoBlock label={t("admin:adminOms.detail.inventoryStatus")} value={t(`admin:adminOms.inventoryStatus.${detail.inventory.status}`)} meta={detail.inventory.locationCode ?? ""} />
          <InfoBlock label={t("admin:adminOms.detail.reservation")} value={valueOrDash(detail.inventory.reservationId)} meta={compactParts([detail.inventory.reservationStatus, formatNullableDate(detail.inventory.expiresAt, locale)]).join(" · ")} />
        </div>
      </DetailSection>
      <DetailSection title={t("admin:adminOms.detail.fulfillment")}>
        <div className="grid gap-3">
          <InfoBlock label={t("admin:adminOms.detail.fulfillmentOrder")} value={valueOrDash(detail.fulfillment.fulfillmentOrderId)} meta={detail.fulfillment.status ? t(`admin:adminOms.fulfillmentStatus.${detail.fulfillment.status}`) : t("admin:adminOms.fulfillmentStatus.none")} />
          <InfoBlock label={t("admin:adminOms.detail.fulfillmentEvidence")} value={detail.fulfillment.latestOperationType ?? t("admin:adminOms.detail.notAvailable")} meta={compactParts([detail.fulfillment.providerTrackingId, formatNullableDate(detail.fulfillment.latestOperationAt, locale)]).join(" · ")} />
        </div>
      </DetailSection>
    </section>
  );
}

export function BillingSection({ detail, t }: { detail: OmsOrderDetail; t: TFunction }) {
  const address = detail.billingAddress;
  return (
    <DetailSection testId="admin-oms-billing-section" title={t("admin:adminOms.detail.billing")}>
      {address ? (
        <div className="grid gap-3 md:grid-cols-2">
          <InfoBlock label={t("admin:adminOms.address.recipientName")} value={valueOrDash(address.companyName ?? address.recipientName)} meta={address.taxId ?? ""} />
          <InfoBlock label={t("admin:adminOms.detail.billingAddress")} value={compactParts([address.line1, address.line2]).join(", ") || "-"} meta={compactParts([address.postalCode, address.city, address.country]).join(" ")} />
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t("admin:adminOms.detail.noBillingAddress")}</p>
      )}
    </DetailSection>
  );
}

function DetailList({ title, empty, rows }: { title: string; empty: string; rows: Array<{ key: string; title: string; meta: string }> }) {
  return (
    <div className="mt-4">
      <p className="label-text mb-2 text-text-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} className="rounded-md border border-warm-sand bg-offwhite px-3 py-2">
              <p className="text-sm font-medium text-teal-dark">{row.title}</p>
              {row.meta && <p className="mt-1 text-xs text-text-muted">{row.meta}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatNullableDate(value: string | null, locale: string): string | null {
  return value ? formatDate(value, locale) : null;
}

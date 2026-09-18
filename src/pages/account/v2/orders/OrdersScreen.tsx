import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CreditCard, FileText, MapPin, Package, Truck } from "lucide-react";

import type { CustomerAccountV2Response, CustomerInvoiceDownloadArtifact } from "@/domains/customers/accountV2Contracts";
import { cn, compactParts } from "@/lib/utils";
import {
  dateLabel,
  money,
  orderDisplayRef,
  triggerBlobDownload,
} from "../../DashboardPanelUtils";
import type { AccountLang } from "../lib/format";
import { customerFulfillmentStep, orderPhaseIndex } from "../lib/orderFulfillment";
import { stepLabelKey, stepUsesTruckIcon } from "@/domains/fulfillment/statusMap";
import { AccountCard, CoralButton, SectionTitle } from "../ui/atoms";
import { OrderTrackingStepper } from "./OrderTrackingStepper";
import { serviceTierLabel } from "./deliveryMethodLabel";

type Order = CustomerAccountV2Response["recentOrders"][number];
type Subscription = CustomerAccountV2Response["subscriptions"][number];

// A subscription in one of these block states has an open dunning case — its
// unpaid order is a RENEWAL failure, recovered via subscription payment recovery,
// not via checkout completion.
const PAYMENT_BLOCK_REASONS = new Set(["payment_blocked", "missing_payment_method"]);
// Payment states that read as a hard decline vs a still-awaited payment.
const FAILED_PAYMENT_STATUSES = new Set([
  "failed",
  "payment_failed",
  "requires_payment_method",
  "requires_action",
  "requires_confirmation",
]);

type OrderRecovery =
  | { kind: "checkout" }
  | { kind: "subscription_dunning"; subscriptionId: string };

/**
 * Decide how an unpaid order is recovered (see the orders-list routing matrix):
 * - not `pending_payment` → no recovery affordance (terminal/paid).
 * - subscription order whose subscription is in payment-block (open dunning) →
 *   subscription payment recovery (`/konto/platnosc/napraw`).
 * - otherwise (one-time, or subscription first cycle) → checkout-recovery
 *   (`/konto/dokoncz-platnosc`).
 */
function orderRecovery(order: Order, subscriptions: Subscription[]): OrderRecovery | null {
  if (order.status !== "pending_payment") return null;
  if (order.subscriptionId) {
    const sub = subscriptions.find((s) => s.subscriptionId === order.subscriptionId);
    if (sub?.editBlockedReason && PAYMENT_BLOCK_REASONS.has(sub.editBlockedReason)) {
      return { kind: "subscription_dunning", subscriptionId: order.subscriptionId };
    }
  }
  return { kind: "checkout" };
}

export function OrdersScreen({
  account,
  lang,
  onDownloadInvoice,
  onCompletePayment,
  onRepairSubscriptionPayment,
}: {
  account: CustomerAccountV2Response;
  lang: AccountLang;
  onDownloadInvoice: (invoiceId: string, artifact?: CustomerInvoiceDownloadArtifact) => Promise<Blob>;
  /** Orders-list recovery for one-time / subscription-first-cycle orders (W5). */
  onCompletePayment: (orderId: string, options?: { hasSubscriptionContext?: boolean }) => void;
  /** Subscription payment recovery for renewal/dunning orders. */
  onRepairSubscriptionPayment: (subscriptionId: string) => void;
}) {
  const { t } = useTranslation("account");
  const [expanded, setExpanded] = useState<string | null>(account.recentOrders[0]?.orderId ?? null);

  async function downloadInvoice(order: Order) {
    if (!order.invoice) return;
    const blob = await onDownloadInvoice(order.invoice.invoiceId);
    triggerBlobDownload(blob, `${order.invoice.invoiceRef}.pdf`);
  }

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle as="h1" className="text-3xl">
          {t("account:dashboard.ordersV2.title")}
        </SectionTitle>
        <p className="mt-1 text-foreground/60">{t("account:dashboard.ordersV2.subtitle")}</p>
      </div>

      {account.recentOrders.length === 0 ? (
        <AccountCard className="p-7">
          <p className="text-sm text-foreground/55">{t("account:dashboard.panels.orders.empty")}</p>
        </AccountCard>
      ) : (
        <ul className="space-y-3">
          {account.recentOrders.map((order) => {
            const phase = orderPhaseIndex(order);
            const step = customerFulfillmentStep(order);
            const open = expanded === order.orderId;
            const Icon = stepUsesTruckIcon(step) ? Truck : Package;
            const trackingReferences = order.trackingReferences.length > 0
              ? order.trackingReferences
              : (order.trackingNumber ?? order.trackingNumbers[0])
                ? [{
                    trackingNumber: order.trackingNumber ?? order.trackingNumbers[0],
                    trackingUrl: order.trackingUrl,
                    providerKind: "unknown",
                    carrierKind: order.carrierKind,
                    service: order.service,
                    updatedAt: order.updatedAt,
                  }]
                : [];
            const recovery = orderRecovery(order, account.subscriptions);
            const paymentLabel = recovery
              ? FAILED_PAYMENT_STATUSES.has((order.paymentStatus ?? "").toLowerCase())
                ? t("account:dashboard.ordersV2.paymentFailed")
                : t("account:dashboard.ordersV2.paymentPending")
              : null;
            return (
              <li key={order.orderId}>
                <AccountCard>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : order.orderId)}
                    aria-expanded={open}
                    className="focus-ring flex w-full items-center gap-4 rounded-card px-5 py-4 text-left"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-control bg-teal/10 text-teal">
                      <Icon size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-base font-semibold text-foreground">
                        {orderDisplayRef(order, t)}
                      </span>
                      <span className="text-xs-plus text-foreground/55">
                        {dateLabel(order.createdAt, lang, "–")}
                      </span>
                    </span>
                    <span className={cn("text-sm font-semibold", recovery ? "text-warm-coral" : "text-teal")}>
                      {recovery ? paymentLabel : t(stepLabelKey(step))}
                    </span>
                    <span className="w-24 text-right text-base font-bold text-foreground">
                      {money(order.total, lang)}
                    </span>
                    <ChevronDown
                      size={18}
                      className={cn("shrink-0 text-foreground/40 transition-transform", open && "rotate-180")}
                    />
                  </button>

                  {recovery ? (
                    <div className="flex flex-col gap-3 border-t border-warm-coral/15 bg-warm-coral/[0.05] px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-medium text-warm-coral">
                        {t("account:dashboard.ordersV2.paymentNeededHint")}
                      </span>
                      <CoralButton
                        className="shrink-0"
                        icon={<CreditCard size={16} aria-hidden />}
                        onClick={() =>
                          recovery.kind === "subscription_dunning"
                            ? onRepairSubscriptionPayment(recovery.subscriptionId)
                            : onCompletePayment(order.orderId, {
                                hasSubscriptionContext: Boolean(order.subscriptionId),
                              })
                        }
                      >
                        {t("account:dashboard.ordersV2.completePayment")}
                      </CoralButton>
                    </div>
                  ) : null}

                  {open ? (
                    <div className="border-t border-teal-dark/8 px-5 py-5">
                      <DeliverySelectionCard deliverySelection={order.deliverySelection} />
                      <TrackingReferenceList references={trackingReferences} lang={lang} />
                      <OrderTrackingStepper phaseIndex={phase} />
                      <div className="mt-5 flex flex-wrap gap-3">
                        {order.invoice?.downloadAvailable ? (
                          <button
                            type="button"
                            onClick={() => void downloadInvoice(order)}
                            className="focus-ring inline-flex items-center gap-2 rounded-control border border-teal-dark/10 bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:border-teal"
                          >
                            <FileText size={16} />
                            {t("account:dashboard.panels.orders.invoice")}
                          </button>
                        ) : null}
                        {order.invoiceRequestStatus === "preparing" ? (
                          <span className="inline-flex items-center gap-2 rounded-control border border-teal-dark/10 bg-card px-4 py-2.5 text-sm font-medium text-foreground/65">
                            <FileText size={16} />
                            {t("account:dashboard.panels.orders.invoicePreparing")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </AccountCard>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DeliverySelectionCard({
  deliverySelection,
}: {
  deliverySelection: Order["deliverySelection"];
}) {
  const { t } = useTranslation("account");
  if (!deliverySelection) return null;
  const methodLabel = compactParts([
    deliverySelection.carrierKind?.toUpperCase() ?? null,
    t(`account:dashboard.sectionsV2.delivery.kind.${deliverySelection.deliveryKind}`),
    serviceTierLabel(deliverySelection.serviceCode, t),
  ]).join(" · ");
  const pickupLabel = deliverySelection.pickupPoint
    ? compactParts([
        deliverySelection.pickupPoint.name,
        deliverySelection.pickupPoint.address
          ? compactParts([
              deliverySelection.pickupPoint.address.line1,
              deliverySelection.pickupPoint.address.postalCode,
              deliverySelection.pickupPoint.address.city,
            ]).join(", ")
          : null,
      ]).join(" · ")
    : null;
  return (
    <div className="mb-4 rounded-control border border-teal-dark/10 bg-card px-3 py-2 text-sm">
      <p className="label-text text-foreground/45">{t("account:dashboard.ordersV2.deliveryMethod")}</p>
      <p className="mt-1 font-medium text-foreground">{methodLabel}</p>
      {pickupLabel ? <p className="mt-1 text-xs text-foreground/55">{pickupLabel}</p> : null}
    </div>
  );
}

function TrackingReferenceList({
  references,
  lang,
}: {
  references: Array<{
    trackingNumber: string;
    trackingUrl?: string | null;
    providerKind?: string | null;
    carrierKind?: string | null;
    service?: string | null;
    updatedAt?: string | null;
  }>;
  lang: AccountLang;
}) {
  const { t } = useTranslation("account");
  if (references.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {references.map((reference) => (
        <div key={`${reference.providerKind ?? "provider"}:${reference.trackingNumber}`} className="rounded-control border border-teal-dark/10 bg-card px-3 py-2">
          <p className="label-text text-foreground/45">
            {t("account:dashboard.ordersV2.tracking", { number: reference.trackingNumber })}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
            {compactParts([reference.carrierKind?.toUpperCase() ?? null, serviceTierLabel(reference.service, t), reference.updatedAt ? dateLabel(reference.updatedAt, lang, "–") : null]).join(" · ")}
          </div>
          {reference.trackingUrl ? (
            <a
              href={reference.trackingUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="focus-ring mt-2 inline-flex items-center gap-2 rounded-control border border-teal-dark/10 bg-white px-3 py-2 text-sm font-medium text-foreground hover:border-teal"
            >
              <MapPin size={16} />
              {t("account:dashboard.panels.orders.trackShipment")}
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

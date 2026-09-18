import { useTranslation } from "react-i18next";
import { Package, Truck, WalletCards, type LucideIcon } from "lucide-react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { cn } from "@/lib/utils";
import { orderDisplayRef } from "../../DashboardPanelUtils";
import type { Subscription } from "../lib/subscriptionEditModel";
import type { InFlightDelivery } from "../lib/orderFulfillment";
import { stepLabelKey, trackingPhaseKeyForStep } from "@/domains/fulfillment/statusMap";
import { customerStepForTerminalOrder } from "@/domains/fulfillment/types";
import { customerFulfillmentStep } from "../lib/orderFulfillment";
import type { AccountLang } from "../lib/format";
import { formatDayMonth, formatDayMonthShort, formatDeliveryWindowShort } from "../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { Eyebrow } from "../ui/atoms";
import type { AccountV2TabId } from "../AccountShell";

type Order = CustomerAccountV2Response["recentOrders"][number];

function paymentMethodLabel(kind: string | null, t: (k: string) => string): string {
  const key = kind?.toLowerCase();
  if (key === "blik" || key === "card" || key === "transfer") {
    return t(`account:dashboard.subscriptionV2.paymentMethod.${key}`);
  }
  return kind ?? t("account:dashboard.subscriptionV2.paymentMethod.fallback");
}

const FAILED_PAYMENT_STATUSES = new Set([
  "failed",
  "payment_failed",
  "requires_payment_method",
]);
const PENDING_ORDER_STATUSES = new Set(["pending_payment", "payment_pending"]);

function lastOrderPhase(order: Order, t: (key: string) => string): string {
  const orderStatus = order.status.toLowerCase();
  const paymentStatus = order.paymentStatus?.toLowerCase() ?? "";

  // Cancellation/refund is an order decision, and the fulfillment canon owns its
  // customer-safe precedence over every payment, cached projection or carrier signal.
  const terminalStep = customerStepForTerminalOrder(orderStatus);
  if (terminalStep) {
    return t(`account:dashboard.panels.orders.trackingPhase.${trackingPhaseKeyForStep(terminalStep)}`);
  }
  if (orderStatus === "expired") {
    return t("account:dashboard.panels.orders.orderStatus.expired");
  }
  if (orderStatus === "failed") {
    return t("account:dashboard.ordersV2.paymentFailed");
  }
  if (PENDING_ORDER_STATUSES.has(orderStatus)) {
    if (paymentStatus === "expired") {
      return t("account:dashboard.panels.orders.orderStatus.expired");
    }
    if (FAILED_PAYMENT_STATUSES.has(paymentStatus)) {
      return t("account:dashboard.ordersV2.paymentFailed");
    }
    // A fulfillment timeline is meaningful only after the order itself settles.
    // Unknown or in-flight legacy payment rows stay honest rather than falling
    // into the fulfillment canon's intentionally shared `paid` floor.
    return t("account:dashboard.ordersV2.paymentPending");
  }
  return t(`account:dashboard.panels.orders.trackingPhase.${trackingPhaseKeyForStep(customerFulfillmentStep(order))}`);
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  tone = "default",
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "alert";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring group flex flex-col items-start rounded-card border border-teal-dark/8 bg-card p-5 text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-card-hover)]"
    >
      <div className="flex w-full items-start justify-between">
        <Eyebrow className={cn(tone === "alert" && "text-warm-coral")}>{label}</Eyebrow>
        <Icon size={18} className={cn("text-teal", tone === "alert" && "text-warm-coral")} />
      </div>
      <span
        className={cn(
          "mt-2 font-display text-2xl font-bold",
          tone === "alert" ? "text-warm-coral" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="mt-1 text-sm text-foreground/55">{sub}</span>
    </button>
  );
}

export function StatusTiles({
  subscription,
  recentOrder,
  lang,
  blocked,
  inFlight = null,
  onSelectTab,
  onRepair,
}: {
  subscription: Subscription;
  recentOrder: Order | null;
  lang: AccountLang;
  blocked: boolean;
  inFlight?: InFlightDelivery | null;
  onSelectTab: (tab: AccountV2TabId) => void;
  onRepair: () => void;
}) {
  const { t } = useTranslation("account");
  // `nextCycleAt` is the charge instant; the tile promises a delivery.
  const delivery = subscription.nextCycleAt
    ? estimateDeliveryWindow(subscription.nextCycleAt, DELIVERY_DISPATCH_POLICY)
    : null;

  const orderPhase = recentOrder
    ? lastOrderPhase(recentOrder, t)
    : t("account:dashboard.start.tiles.lastOrderEmpty");

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Tile
        icon={Truck}
        label={t("account:dashboard.start.tiles.estimatedDeliveryLabel")}
        value={
          inFlight
            ? t(stepLabelKey(inFlight.step))
            : formatDeliveryWindowShort(delivery, lang)
        }
        sub={
          inFlight
            ? t("account:dashboard.start.tiles.renewalSub", {
                date: formatDayMonth(subscription.nextCycleAt, lang),
              })
            : t("account:dashboard.start.tiles.editCutoffSub", {
                date: formatDayMonthShort(subscription.editCutoffAt, lang),
              })
        }
        onClick={() => onSelectTab("subscriptions")}
      />
      <Tile
        icon={WalletCards}
        tone={blocked ? "alert" : "default"}
        label={t("account:dashboard.start.tiles.paymentLabel")}
        value={
          blocked
            ? t("account:dashboard.start.tiles.paymentAction")
            : t("account:dashboard.start.tiles.paymentOk", {
                method: paymentMethodLabel(subscription.paymentMethodKind, t),
              })
        }
        sub={t(
          blocked
            ? "account:dashboard.start.tiles.paymentActionHint"
            : "account:dashboard.start.tiles.paymentOkHint",
        )}
        onClick={() => (blocked ? onRepair() : onSelectTab("payments"))}
      />
      <Tile
        icon={Package}
        label={t("account:dashboard.start.tiles.lastOrderLabel")}
        value={recentOrder ? orderDisplayRef(recentOrder, t) : "–"}
        sub={orderPhase}
        onClick={() => onSelectTab("orders")}
      />
    </div>
  );
}

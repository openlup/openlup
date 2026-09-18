import { AlertTriangle, ClockAlert, CreditCard, FileText, PackageCheck, PauseCircle, ShieldAlert, Truck, XCircle, type LucideIcon } from "lucide-react";
import type { TFunction } from "i18next";
import { AdminMetricCard } from "@/components/admin/AdminSurface";
import type { AdminCommerceOrdersListResponse } from "@/domains/commerce/omsContracts";
import { DEFAULT_ORDERS_FILTERS, type OrdersPageFiltersState } from "./ordersPageFilterOptions";

type SummaryCounts = AdminCommerceOrdersListResponse["summaryCounts"];

// The three dimensions a metric card selects WITHIN. Picking any card clears all three,
// then re-applies its own - which is how "selecting one metric clears the other two"
// falls out of one rule instead of being restated per card.
//
// `providerOpsStatus` is deliberately NOT one of them, and that asymmetry is the
// behaviour on main, not an oversight introduced here: the omnipack card clears these
// three, but the other eight leave an active provider-ops filter standing. Adding it to
// this tuple is the one-line change if that is ever decided to be wrong - it is a
// behaviour change, so this wave does not make it.
const EXCLUSIVE_DIMENSIONS = ["attentionOnly", "preset", "nextAction"] as const;

type MetricDimension = "attentionOnly" | "preset" | "nextAction" | "providerOpsStatus";

type MetricCard<D extends MetricDimension = MetricDimension> = {
  labelKey: string;
  icon: LucideIcon;
  tone: "bad" | "warn" | "teal";
  count: (stats: SummaryCounts) => number;
  dimension: D;
  // The value this card selects. Selecting it again returns the dimension to its default.
  value: Exclude<OrdersPageFiltersState[D], undefined>;
};

function card<D extends MetricDimension>(definition: MetricCard<D>): MetricCard {
  return definition as MetricCard;
}

const METRIC_CARDS: MetricCard[] = [
  card({ labelKey: "needsAttention", icon: AlertTriangle, tone: "bad", count: (s) => s.needsAttention, dimension: "attentionOnly", value: true }),
  card({ labelKey: "onHold", icon: PauseCircle, tone: "bad", count: (s) => s.activeHold, dimension: "preset", value: "active_hold" }),
  card({ labelKey: "fulfillment", icon: PackageCheck, tone: "teal", count: (s) => s.readyForFulfillment, dimension: "nextAction", value: "create_fulfillment" }),
  card({ labelKey: "paymentIssues", icon: CreditCard, tone: "bad", count: (s) => s.paymentIssues, dimension: "preset", value: "payment_required" }),
  card({ labelKey: "inventoryRisk", icon: Truck, tone: "warn", count: (s) => s.inventoryRisk, dimension: "preset", value: "inventory_missing" }),
  card({ labelKey: "fulfillmentBlocked", icon: ShieldAlert, tone: "warn", count: (s) => s.fulfillmentBlocked, dimension: "preset", value: "fulfillment_blocked" }),
  card({ labelKey: "fulfillmentExceptions", icon: XCircle, tone: "bad", count: (s) => s.fulfillmentExceptions, dimension: "preset", value: "fulfillment_exception" }),
  card({ labelKey: "invoice", icon: FileText, tone: "warn", count: (s) => s.invoiceIssues, dimension: "nextAction", value: "review_invoice" }),
  card({ labelKey: "omnipackPendingPick", icon: ClockAlert, tone: "warn", count: (s) => s.omnipackDispatchedNotPicked, dimension: "providerOpsStatus", value: "omnipack_dispatched_not_picked" }),
];

// Selecting a metric clears the exclusive dimensions and applies this card's own;
// selecting the active one clears it too, leaving the unfiltered list.
function exclusiveToggle(
  dimension: MetricDimension,
  value: OrdersPageFiltersState[MetricDimension],
  active: boolean,
): Partial<OrdersPageFiltersState> {
  const cleared = Object.fromEntries(
    EXCLUSIVE_DIMENSIONS.map((key) => [key, DEFAULT_ORDERS_FILTERS[key]]),
  ) as Partial<OrdersPageFiltersState>;
  return { ...cleared, [dimension]: active ? DEFAULT_ORDERS_FILTERS[dimension] : value };
}

export function OrdersPageMetrics({
  stats,
  filters,
  t,
  onChange,
}: {
  stats: SummaryCounts;
  filters: OrdersPageFiltersState;
  t: TFunction;
  onChange: (patch: Partial<OrdersPageFiltersState>) => void;
}) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-9">
      {METRIC_CARDS.map(({ labelKey, icon, tone, count, dimension, value }) => {
        const active = filters[dimension] === value;
        return (
          <AdminMetricCard
            key={labelKey}
            icon={icon}
            tone={tone}
            label={t(`admin:adminOms.metrics.${labelKey}`)}
            value={count(stats)}
            active={active}
            onClick={() => onChange(exclusiveToggle(dimension, value, active))}
          />
        );
      })}
    </div>
  );
}

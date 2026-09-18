import {
  AlertTriangle,
  ClipboardList,
  PackageCheck,
  PauseCircle,
  Truck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { TFunction } from "i18next";
import type {
  AdminCommerceOrdersListRequest,
  AdminOmsAttentionReason,
  AdminOmsNextAction,
  AdminOmsProviderOpsStatus,
} from "@/domains/commerce/omsContracts";

export type OrdersPageFiltersState = {
  search: string;
  status: "all" | NonNullable<AdminCommerceOrdersListRequest["status"]>;
  preset: "all" | AdminOmsAttentionReason;
  mode: "all" | NonNullable<AdminCommerceOrdersListRequest["mode"]>;
  paymentStatus: "all" | NonNullable<AdminCommerceOrdersListRequest["paymentStatus"]>;
  fulfillmentStatus: "all" | NonNullable<AdminCommerceOrdersListRequest["fulfillmentStatus"]>;
  inventoryStatus: "all" | NonNullable<AdminCommerceOrdersListRequest["inventoryStatus"]>;
  accountingStatus: "all" | NonNullable<AdminCommerceOrdersListRequest["accountingStatus"]>;
  providerOpsStatus: "all" | AdminOmsProviderOpsStatus;
  attentionOnly: boolean;
  includeWithdrawn: boolean;
  nextAction: "all" | AdminOmsNextAction;
  from: string;
  to: string;
  sort: NonNullable<AdminCommerceOrdersListRequest["sort"]>;
};

export const DEFAULT_ORDERS_FILTERS: OrdersPageFiltersState = {
  search: "",
  status: "all",
  preset: "all",
  mode: "all",
  paymentStatus: "all",
  fulfillmentStatus: "all",
  inventoryStatus: "all",
  accountingStatus: "all",
  providerOpsStatus: "all",
  attentionOnly: false,
  includeWithdrawn: false,
  nextAction: "all",
  from: "",
  to: "",
  sort: "created_desc",
};

export type ActiveFilterChip = {
  key: keyof OrdersPageFiltersState;
  label: string;
  testId: string;
};

// Diffs the current filters against DEFAULT_ORDERS_FILTERS and returns one chip per
// active filter that REDUCES the visible set. `sort` is intentionally excluded — it
// reorders rather than hides, so it never makes the list a filtered subset.
export function activeFilterChips(filters: OrdersPageFiltersState, t: TFunction): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const push = (key: keyof OrdersPageFiltersState, label: string) =>
    chips.push({ key, label, testId: `admin-oms-active-filter-${key}` });

  const search = filters.search.trim();
  if (search) push("search", `${t("admin:adminOms.filters.chip.search")}: "${search}"`);
  if (filters.status !== "all") push("status", `${t("admin:adminOms.filters.statusLabel")}: ${t(`admin:adminOms.orderStatus.${filters.status}`)}`);
  if (filters.preset !== "all") push("preset", `${t("admin:adminOms.filters.chip.preset")}: ${t(`admin:adminOms.presets.${filters.preset}`)}`);
  if (filters.mode !== "all") push("mode", `${t("admin:adminOms.filters.modeLabel")}: ${t(`admin:adminOms.mode.${filters.mode}`)}`);
  if (filters.paymentStatus !== "all") push("paymentStatus", `${t("admin:adminOms.filters.paymentStatusLabel")}: ${t(`admin:adminOms.paymentStatus.${filters.paymentStatus}`)}`);
  if (filters.fulfillmentStatus !== "all") push("fulfillmentStatus", `${t("admin:adminOms.filters.fulfillmentStatusLabel")}: ${t(`admin:adminOms.fulfillmentStatus.${filters.fulfillmentStatus}`)}`);
  if (filters.inventoryStatus !== "all") push("inventoryStatus", `${t("admin:adminOms.filters.inventoryStatusLabel")}: ${t(`admin:adminOms.inventoryStatus.${filters.inventoryStatus}`)}`);
  if (filters.accountingStatus !== "all") push("accountingStatus", `${t("admin:adminOms.filters.accountingStatusLabel")}: ${t(`admin:adminOms.accountingStatus.${filters.accountingStatus}`)}`);
  if (filters.providerOpsStatus !== "all") push("providerOpsStatus", `${t("admin:adminOms.filters.providerOpsStatusLabel")}: ${t(`admin:adminOms.providerOpsStatus.${filters.providerOpsStatus}`)}`);
  if (filters.attentionOnly) push("attentionOnly", t("admin:adminOms.filters.chip.attentionOnly"));
  if (filters.includeWithdrawn) push("includeWithdrawn", t("admin:adminOms.filters.chip.includeWithdrawn"));
  if (filters.nextAction !== "all") push("nextAction", `${t("admin:adminOms.filters.chip.nextAction")}: ${t(`admin:adminOms.nextAction.${filters.nextAction}`)}`);
  if (filters.from) push("from", `${t("admin:adminOms.filters.fromLabel")}: ${filters.from}`);
  if (filters.to) push("to", `${t("admin:adminOms.filters.toLabel")}: ${filters.to}`);

  return chips;
}

// Patch that resets a single filter dimension back to its default (removing a chip).
export function chipResetPatch(key: keyof OrdersPageFiltersState): Partial<OrdersPageFiltersState> {
  return { [key]: DEFAULT_ORDERS_FILTERS[key] } as Partial<OrdersPageFiltersState>;
}

export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "paid",
  "failed",
  "expired",
  "fulfillment_pending",
  "fulfilled",
  "cancelled",
  "refunded",
] as const;

export const ORDER_MODES = ["one_time", "subscription_cycle"] as const;

export const PAYMENT_STATUSES = [
  "not_started",
  "created",
  "requires_action",
  "processing",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
  "disputed",
] as const;

export const FULFILLMENT_STATUSES = [
  "created",
  "packed",
  "label_pending",
  "label_created",
  "handed_over",
  "in_transit",
  "delivered",
  "exception",
  "cancelled",
] as const;

export const INVENTORY_STATUSES = [
  "not_checked",
  "reserved",
  "missing",
  "released",
  "expired",
  "consumed",
  "review_required",
] as const;

export const ACCOUNTING_STATUSES = [
  "missing",
  "draft",
  "issue_requested",
  "blocked",
  "issued",
  "ksef_pending",
  "accepted",
  "rejected",
  "correction_requested",
  "corrected",
  "voided",
  "outbox_failed",
] as const;

export const PROVIDER_OPS_STATUSES = [
  "none",
  "omnipack_dispatched_not_picked",
  "omnipack_picked_not_shipped",
  "omnipack_dispatch_failed",
] as const;

export const SORT_OPTIONS = ["created_desc", "created_asc", "updated_desc", "updated_asc", "attention_priority_desc"] as const;

export const NEXT_ACTIONS = [
  "none",
  "review_payment",
  "release_hold",
  "review_address",
  "review_inventory",
  "review_fulfillment",
  "create_fulfillment",
  "record_label",
  "hand_off",
  "review_tracking",
  "review_invoice",
] as const;

export const PRESETS: Array<{ key: "all" | AdminOmsAttentionReason; icon: LucideIcon }> = [
  { key: "all", icon: ClipboardList },
  { key: "none", icon: ClipboardList },
  { key: "payment_required", icon: AlertTriangle },
  { key: "active_hold", icon: PauseCircle },
  { key: "missing_shipping_address", icon: AlertTriangle },
  { key: "inventory_missing", icon: PackageCheck },
  { key: "fulfillment_blocked", icon: AlertTriangle },
  { key: "fulfillment_pending", icon: Truck },
  { key: "fulfillment_exception", icon: XCircle },
  { key: "invoice_missing", icon: ClipboardList },
  { key: "invoice_buyer_data_invalid", icon: AlertTriangle },
  { key: "invoice_issue_failed", icon: XCircle },
];

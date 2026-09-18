import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BarChart3, Boxes, CreditCard, FileWarning, ListChecks, PackageCheck, ShoppingCart, Truck } from "lucide-react";
import { AdminMetricCard, AdminPanel, AdminSectionHeader, AdminSegmented, AdminStatusPill } from "@/components/admin/AdminSurface";
import { ADMIN_OMS_ATTENTION_QUERY_KEY, ADMIN_OMS_ATTENTION_REQUEST } from "@/components/admin/useAdminShellData";
import { useAuth } from "@/lib/authContext";
import { getAdminCommerceOrders } from "@/domains/commerce/omsClient";
import type { AdminCommerceOrdersListRequest, AdminCommerceOrdersListResponse } from "@/domains/commerce/omsContracts";
import { customerName, formatMoney, formatOperatorOrderRef } from "./ordersPageUtils";
import { RecentOrdersPanel } from "./RecentOrdersPanel";

type DashboardMode = "kpi" | "queue";
type DashboardRange = "24h" | "7d" | "30d" | "all";

export default function DashboardPage() {
  const { t, i18n } = useTranslation("admin");
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [mode, setMode] = useState<DashboardMode>("kpi");
  const [range, setRange] = useState<DashboardRange>("30d");
  const kpiRequest = useMemo<AdminCommerceOrdersListRequest>(() => {
    const { from, to } = rangeToIso(range);
    return { page: 1, pageSize: 1, sort: "updated_desc", from, to };
  }, [range]);
  const queueRequest = ADMIN_OMS_ATTENTION_REQUEST;
  const recentRequest = useMemo<AdminCommerceOrdersListRequest>(() => ({
    page: 1,
    pageSize: 6,
    sort: "created_desc",
    attentionOnly: false,
  }), []);

  const kpiQuery = useQuery({
    queryKey: ["admin-dashboard-oms-kpi", kpiRequest, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommerceOrders(accessToken, kpiRequest);
    },
    staleTime: 30_000,
    retry: false,
  });

  const queueQuery = useQuery({
    queryKey: [ADMIN_OMS_ATTENTION_QUERY_KEY, queueRequest, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommerceOrders(accessToken, queueRequest);
    },
    staleTime: 30_000,
    retry: false,
  });

  const recentQuery = useQuery({
    queryKey: ["admin-dashboard-oms-recent", recentRequest, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommerceOrders(accessToken, recentRequest);
    },
    staleTime: 30_000,
    retry: false,
  });

  const totals = kpiQuery.data?.summaryTotals;
  const counts = queueQuery.data?.summaryCounts;
  const orders = queueQuery.data?.orders ?? [];
  const recentOrders = recentQuery.data?.orders ?? [];
  const updatedAt = Math.max(kpiQuery.dataUpdatedAt || 0, queueQuery.dataUpdatedAt || 0, recentQuery.dataUpdatedAt || 0);

  return (
    <div className="p-4 text-teal-dark md:p-6 xl:p-8">
      <AdminSectionHeader
        eyebrow={t("admin:adminDashboard.eyebrow")}
        title={t("admin:adminDashboard.title")}
        description={updatedAt ? t("admin:adminDashboard.subtitle", { time: formatTime(updatedAt, i18n.language) }) : t("admin:adminDashboard.subtitlePending")}
        actions={
          <>
            <AdminSegmented<DashboardMode>
              value={mode}
              onChange={(value) => setMode(value)}
              options={[
                { value: "kpi", label: t("admin:adminDashboard.mode.kpi"), icon: BarChart3 },
                { value: "queue", label: t("admin:adminDashboard.mode.queue"), icon: ListChecks },
              ]}
            />
            <AdminSegmented<DashboardRange>
              value={range}
              onChange={(value) => setRange(value)}
              options={[
                { value: "24h", label: t("admin:adminDashboard.range.24h") },
                { value: "7d", label: t("admin:adminDashboard.range.7d") },
                { value: "30d", label: t("admin:adminDashboard.range.30d") },
                { value: "all", label: t("admin:adminDashboard.range.all") },
              ]}
            />
          </>
        }
      />

      <div className={mode === "kpi" ? "grid gap-4 xl:grid-cols-[1.2fr_0.8fr]" : "grid gap-4 xl:grid-cols-[1fr_0.78fr]"}>
        <div className="space-y-4">
          {mode === "kpi" ? (
            <>
              <KpiGrid totals={totals} loading={kpiQuery.isLoading} error={kpiQuery.isError} locale={i18n.language} t={t} />
              <AttentionQueue orders={orders} data={queueQuery.data} loading={queueQuery.isLoading} error={queueQuery.isError} t={t} locale={i18n.language} large={false} />
            </>
          ) : (
            <>
              <AttentionQueue orders={orders} data={queueQuery.data} loading={queueQuery.isLoading} error={queueQuery.isError} t={t} locale={i18n.language} large />
              <OperationalTiles counts={counts} loading={queueQuery.isLoading} error={queueQuery.isError} t={t} />
            </>
          )}
        </div>

        <div className="space-y-4">
          {mode === "queue" ? <KpiGrid totals={totals} loading={kpiQuery.isLoading} error={kpiQuery.isError} locale={i18n.language} t={t} compact /> : <OperationalTiles counts={counts} loading={queueQuery.isLoading} error={queueQuery.isError} t={t} />}
          <RecentOrdersPanel orders={recentOrders} loading={recentQuery.isLoading} error={recentQuery.isError} t={t} locale={i18n.language} />
        </div>
      </div>
    </div>
  );
}

function KpiGrid({
  totals,
  loading,
  error,
  locale,
  t,
  compact,
}: {
  totals: AdminCommerceOrdersListResponse["summaryTotals"] | undefined;
  loading: boolean;
  error: boolean;
  locale: string;
  t: TFunction;
  compact?: boolean;
}) {
  const pending = metricFallback(loading, error, t);
  const emptyWindow = Boolean(totals) && !loading && !error && totals?.orderCount === 0;
  return (
    <div className="space-y-2">
      <div className={compact ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"}>
        <AdminMetricCard icon={CreditCard} tone="teal" label={t("admin:adminDashboard.kpi.gmv")} value={totals ? formatMoney(totals.gmv, locale) : pending} />
        <AdminMetricCard icon={ShoppingCart} tone="teal" label={t("admin:adminDashboard.kpi.orders")} value={totals ? totals.orderCount : pending} />
        <AdminMetricCard icon={BarChart3} tone="good" label={t("admin:adminDashboard.kpi.aov")} value={totals ? formatMoney(totals.aov, locale) : pending} />
        <AdminMetricCard icon={PackageCheck} tone="good" label={t("admin:adminDashboard.kpi.subscriptions")} value={totals ? totals.paidSubscriptionCycleCount : pending} />
      </div>
      {emptyWindow ? <p className="text-xs text-text-muted">{t("admin:adminDashboard.kpi.emptyWindowHint")}</p> : null}
    </div>
  );
}

function OperationalTiles({
  counts,
  loading,
  error,
  t,
}: {
  counts: AdminCommerceOrdersListResponse["summaryCounts"] | undefined;
  loading: boolean;
  error: boolean;
  t: TFunction;
}) {
  const pending = metricFallback(loading, error, t);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <AdminMetricCard icon={ListChecks} tone="bad" label={t("admin:adminDashboard.tiles.attention")} value={counts ? counts.needsAttention : pending} onClick={() => openOms({ attentionOnly: "true", sort: "attention_priority_desc" })} />
      <AdminMetricCard icon={PackageCheck} tone="teal" label={t("admin:adminDashboard.tiles.fulfillment")} value={counts ? counts.readyForFulfillment : pending} onClick={() => openOms({ nextAction: "create_fulfillment", sort: "attention_priority_desc" })} />
      <AdminMetricCard icon={Truck} tone="warn" label={t("admin:adminDashboard.tiles.fulfillmentExceptions")} value={counts ? counts.fulfillmentExceptions : pending} onClick={() => openOms({ preset: "fulfillment_exception", sort: "attention_priority_desc" })} />
      <AdminMetricCard icon={CreditCard} tone="bad" label={t("admin:adminDashboard.tiles.payment")} value={counts ? counts.paymentIssues : pending} onClick={() => openOms({ preset: "payment_required", sort: "attention_priority_desc" })} />
      <AdminMetricCard icon={Boxes} tone="warn" label={t("admin:adminDashboard.tiles.inventory")} value={counts ? counts.inventoryRisk : pending} onClick={() => openOms({ preset: "inventory_missing", sort: "attention_priority_desc" })} />
      <AdminMetricCard icon={FileWarning} tone="warn" label={t("admin:adminDashboard.tiles.invoices")} value={counts ? counts.invoiceIssues : pending} onClick={() => openOms({ nextAction: "review_invoice", sort: "attention_priority_desc" })} />
    </div>
  );
}

function AttentionQueue({
  orders,
  data,
  loading,
  error,
  t,
  locale,
  large,
}: {
  orders: AdminCommerceOrdersListResponse["orders"];
  data: AdminCommerceOrdersListResponse | undefined;
  loading: boolean;
  error: boolean;
  t: TFunction;
  locale: string;
  large: boolean;
}) {
  const rows = orders.slice(0, large ? 8 : 5);
  const subtitle = loading
    ? t("admin:adminDashboard.queue.loading")
    : error
      ? t("admin:adminDashboard.queue.error")
      : t("admin:adminDashboard.queue.subtitle", { count: data?.summaryCounts.needsAttention ?? 0 });
  return (
    <AdminPanel className="p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="label-text text-warm-coral">{t("admin:adminDashboard.queue.title")}</p>
          <p className="mt-1 text-sm text-text-muted">{subtitle}</p>
        </div>
        <a className="focus-ring rounded-full px-3 py-1 text-xs-plus font-bold text-teal" href={omsHref({ attentionOnly: "true", sort: "attention_priority_desc" })}>
          {t("admin:adminDashboard.queue.open")}
        </a>
      </div>
      <div className="divide-y divide-warm-sand">
        {loading ? (
          <p className="py-6 text-sm text-text-muted">{t("admin:adminDashboard.queue.loading")}</p>
        ) : error ? (
          <p className="py-6 text-sm text-warm-coral">{t("admin:adminDashboard.queue.error")}</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-sm text-text-muted">{t("admin:adminDashboard.queue.empty")}</p>
        ) : (
          rows.map((order) => (
            <div key={order.orderId} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="font-display text-sm font-semibold text-teal-dark">{formatOperatorOrderRef(order.orderNumber, order.orderId)}</p>
                <p className="text-xs text-text-muted">{customerName(order)}</p>
              </div>
              <div className="text-left sm:text-right">
                <AdminStatusPill tone="warn">{t(`admin:adminOms.attention.${order.attentionReason}`)}</AdminStatusPill>
                <p className="mt-1 text-xs font-bold text-teal">{t(`admin:adminOms.nextAction.${order.nextAction}`)}</p>
                <p className="text-xs text-text-muted">{t("admin:adminDashboard.queue.orderValue", { value: formatMoney(order.total, locale) })}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </AdminPanel>
  );
}

function rangeToIso(range: DashboardRange): { from: string | undefined; to: string | undefined } {
  if (range === "all") return { from: undefined, to: undefined };
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - RANGE_DAYS[range]);
  return { from: from.toISOString(), to: to.toISOString() };
}

const RANGE_DAYS: Record<Exclude<DashboardRange, "all">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

function metricFallback(loading: boolean, error: boolean, t: TFunction) {
  if (loading) return t("admin:adminDashboard.metric.loading");
  if (error) return t("admin:adminDashboard.metric.error");
  return t("admin:adminDashboard.metric.empty");
}

function openOms(params: Record<string, string>) {
  window.location.assign(omsHref(params));
}

function omsHref(params: Record<string, string>) {
  const query = new URLSearchParams(params);
  return `/admin/orders?${query.toString()}`;
}

function formatTime(timestamp: number, locale: string) {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

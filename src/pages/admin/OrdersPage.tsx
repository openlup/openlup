import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import { AdminSectionHeader } from "@/components/admin/AdminSurface";
import { AdminPaginationControls } from "@/components/admin/AdminPaginationControls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/authContext";
import { getAdminCommerceOrders } from "@/domains/commerce/omsClient";
import type { AdminCommerceOrdersListRequest } from "@/domains/commerce/omsContracts";
import { isBlockingVisibleQueryError, visibleFulfillmentRefreshInterval } from "@/domains/fulfillment/types";
import { AdminOmsErrorState } from "./AdminOmsErrorState";
import { OrderDetailSheet } from "./OrderDetailSheet";
import { OrdersPageFilters } from "./OrdersPageFilters";
import { OrdersPageActiveFilters } from "./OrdersPageActiveFilters";
import { OrdersPageMetrics } from "./OrdersPageMetrics";
import {
  activeFilterChips,
  chipResetPatch,
  DEFAULT_ORDERS_FILTERS,
  NEXT_ACTIONS,
  PRESETS,
  SORT_OPTIONS,
  type OrdersPageFiltersState,
} from "./ordersPageFilterOptions";
import { OrderRow } from "./OrdersPageTable";
import { dateFiltersToIsoRange, PAGE_SIZE } from "./ordersPageUtils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

const EMPTY_SUMMARY_COUNTS = {
  needsAttention: 0,
  activeHold: 0,
  readyForFulfillment: 0,
  paymentIssues: 0,
  inventoryRisk: 0,
  fulfillmentBlocked: 0,
  fulfillmentExceptions: 0,
  invoiceIssues: 0,
  omnipackDispatchedNotPicked: 0,
};

export default function OrdersPage() {
  const { t, i18n } = useTranslation("admin");
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const accessToken = session?.access_token;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<OrdersPageFiltersState>(() => ({
    ...DEFAULT_ORDERS_FILTERS,
    search: searchParams.get("q") ?? "",
    preset: readPreset(searchParams.get("preset")),
    mode:
      searchParams.get("mode") === "subscription_cycle"
        ? "subscription_cycle"
        : DEFAULT_ORDERS_FILTERS.mode,
    attentionOnly: searchParams.get("attentionOnly") === "true",
    includeWithdrawn: searchParams.get("includeWithdrawn") === "true",
    nextAction: readNextAction(searchParams.get("nextAction")),
    sort: readSort(searchParams.get("sort")),
  }));
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(filters.search, 250);

  const updateFilters = useCallback((patch: Partial<OrdersPageFiltersState>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_ORDERS_FILTERS);
    setPage(0);
  }, []);

  const activeChips = useMemo(() => activeFilterChips(filters, t), [filters, t]);

  const request = useMemo<AdminCommerceOrdersListRequest>(() => {
    const next: AdminCommerceOrdersListRequest = {
      page: page + 1,
      pageSize: PAGE_SIZE,
      sort: filters.sort,
    };
    const dateRange = dateFiltersToIsoRange(filters.from, filters.to);
    const search = debouncedSearch.trim();
    if (search.length >= 2) next.search = search;
    if (filters.status !== "all") next.status = filters.status;
    if (filters.preset !== "all") next.attentionReason = filters.preset;
    if (filters.attentionOnly) next.attentionOnly = true;
    if (filters.includeWithdrawn) next.includeWithdrawn = true;
    if (filters.nextAction !== "all") next.nextAction = filters.nextAction;
    if (filters.mode !== "all") next.mode = filters.mode;
    if (filters.paymentStatus !== "all") next.paymentStatus = filters.paymentStatus;
    if (filters.fulfillmentStatus !== "all") next.fulfillmentStatus = filters.fulfillmentStatus;
    if (filters.inventoryStatus !== "all") next.inventoryStatus = filters.inventoryStatus;
    if (filters.accountingStatus !== "all") next.accountingStatus = filters.accountingStatus;
    if (filters.providerOpsStatus !== "all") next.providerOpsStatus = filters.providerOpsStatus;
    if (dateRange.from) next.from = dateRange.from;
    if (dateRange.to) next.to = dateRange.to;
    return next;
  }, [debouncedSearch, filters, page]);

  const ordersQuery = useQuery({
    queryKey: ["admin-oms-orders", request, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async ({ signal }) => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommerceOrders(accessToken, request, { signal });
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: (query) => visibleFulfillmentRefreshInterval(
      query.state.data?.orders.map((order) => order.fulfillmentStatus) ?? [],
    ),
    refetchOnWindowFocus: "always",
    retry: false,
  });

  const orders = useMemo(() => ordersQuery.data?.orders ?? [], [ordersQuery.data?.orders]);
  const totalCount = ordersQuery.data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const selectedOrder = orders.find((order) => order.orderId === selectedOrderId) ?? null;

  const stats = ordersQuery.data?.summaryCounts ?? EMPTY_SUMMARY_COUNTS;
  const activeSearch = Boolean(request.search);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (event.key === "/" && !isEditable) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (event.key === "Escape" && filters.search) {
        event.preventDefault();
        updateFilters({ search: "" });
        searchInputRef.current?.focus();
        return;
      }

      if (
        event.key === "Enter" &&
        document.activeElement === searchInputRef.current &&
        orders.length === 1 &&
        !ordersQuery.isFetching
      ) {
        event.preventDefault();
        setSelectedOrderId(orders[0].orderId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filters.search, orders, ordersQuery.isFetching, updateFilters]);

  useEffect(() => {
    if (!accessToken || totalPages <= 0 || page >= totalPages - 1) return;
    const nextRequest = { ...request, page: page + 2 };
    void queryClient.prefetchQuery({
      queryKey: ["admin-oms-orders", nextRequest, accessToken],
      queryFn: ({ signal }) => getAdminCommerceOrders(accessToken, nextRequest, { signal }),
      staleTime: 30_000,
    });
  }, [accessToken, page, queryClient, request, totalPages]);

  return (
    <div data-testid="admin-oms-page" className="p-4 text-teal-dark md:p-6 xl:p-8">
      <AdminSectionHeader
        eyebrow={t("admin:adminOms.previewLabel")}
        title={t("admin:adminOms.title")}
        description={t(activeChips.length > 0 ? "admin:adminOms.subtitleFiltered" : "admin:adminOms.subtitle", { count: totalCount })}
        actions={
          <button
            type="button"
            className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-control border border-warm-sand bg-white px-4 text-xs-plus font-bold text-teal-dark shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <Download size={15} aria-hidden="true" />
            {t("admin:adminOms.actions.exportCsv")}
          </button>
        }
      />

      <OrdersPageMetrics stats={stats} filters={filters} t={t} onChange={updateFilters} />

      <OrdersPageFilters filters={filters} t={t} onChange={updateFilters} searchInputRef={searchInputRef} />

      <OrdersPageActiveFilters
        chips={activeChips}
        onRemove={(key) => updateFilters(chipResetPatch(key))}
        onClear={resetFilters}
        t={t}
      />

      {isBlockingVisibleQueryError(ordersQuery.isError, ordersQuery.data) ? (
        <AdminOmsErrorState
          testId="admin-oms-list-error"
          title={t("admin:adminOms.errors.listTitle")}
          description={t("admin:adminOms.errors.listDescription")}
          retryLabel={t("admin:adminOms.errors.retry")}
          retrying={ordersQuery.isFetching}
          onRetry={() => {
            void ordersQuery.refetch();
          }}
        />
      ) : (
        <div data-testid="admin-oms-orders-table" className="overflow-x-auto rounded-card border border-warm-sand bg-white shadow-sm">
          <Table className="min-w-[1120px]">
            <TableHeader>
              <TableRow className="border-warm-sand hover:bg-transparent">
                <TableHead className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminOms.table.order")}</TableHead>
                <TableHead className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminOms.table.customer")}</TableHead>
                <TableHead className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminOms.table.pipeline")}</TableHead>
                <TableHead className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminOms.table.payment")}</TableHead>
                <TableHead className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminOms.table.attention")}</TableHead>
                <TableHead className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminOms.table.total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordersQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-text-muted">
                    <Loader2 className="mx-auto mb-2 animate-spin" size={20} />
                    {t("admin:adminOms.loading")}
                  </TableCell>
                </TableRow>
              ) : orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-text-muted">
                    {activeSearch ? t("admin:adminOms.emptySearch") : t("admin:adminOms.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <OrderRow
                    key={order.orderId}
                    order={order}
                    locale={i18n.language}
                    selected={selectedOrderId === order.orderId}
                    onSelect={() => setSelectedOrderId(order.orderId)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {!isBlockingVisibleQueryError(ordersQuery.isError, ordersQuery.data) && (
        <AdminPaginationControls
          page={page}
          totalPages={totalPages}
          previousLabel={t("admin:adminOms.pagination.previous")}
          nextLabel={t("admin:adminOms.pagination.next")}
          label={(current, pages) => t("admin:adminOms.pagination.label", { current: current + 1, pages })}
          onPageChange={setPage}
        />
      )}

      <OrderDetailSheet
        order={selectedOrder}
        orderId={selectedOrderId}
        accessToken={accessToken}
        locale={i18n.language}
        onClose={() => setSelectedOrderId(null)}
      />
    </div>
  );
}

function readPreset(value: string | null): OrdersPageFiltersState["preset"] {
  return PRESETS.some((preset) => preset.key === value) ? (value as OrdersPageFiltersState["preset"]) : DEFAULT_ORDERS_FILTERS.preset;
}

function readNextAction(value: string | null): OrdersPageFiltersState["nextAction"] {
  return NEXT_ACTIONS.some((action) => action === value) ? (value as OrdersPageFiltersState["nextAction"]) : DEFAULT_ORDERS_FILTERS.nextAction;
}

function readSort(value: string | null): OrdersPageFiltersState["sort"] {
  return SORT_OPTIONS.some((sort) => sort === value) ? (value as OrdersPageFiltersState["sort"]) : DEFAULT_ORDERS_FILTERS.sort;
}

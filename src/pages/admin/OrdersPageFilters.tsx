import { EyeOff, Search, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { TFunction } from "i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACCOUNTING_STATUSES,
  FULFILLMENT_STATUSES,
  INVENTORY_STATUSES,
  ORDER_MODES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PRESETS,
  PROVIDER_OPS_STATUSES,
  SORT_OPTIONS,
  type OrdersPageFiltersState,
} from "./ordersPageFilterOptions";

export function OrdersPageFilters({
  filters,
  t,
  onChange,
  searchInputRef,
}: {
  filters: OrdersPageFiltersState;
  t: TFunction;
  onChange: (patch: Partial<OrdersPageFiltersState>) => void;
  searchInputRef?: RefObject<HTMLInputElement>;
}) {
  return (
    <div className="sticky top-0 z-sticky mb-4 border-y border-warm-sand bg-offwhite/95 py-3 backdrop-blur">
      <div className="grid gap-3 xl:grid-cols-[minmax(240px,1.5fr)_repeat(3,minmax(150px,1fr))]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <Input
            ref={searchInputRef}
            data-testid="admin-oms-search"
            aria-label={t("admin:adminOms.filters.searchLabel")}
            value={filters.search}
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder={t("admin:adminOms.filters.search")}
            className="focus-ring border-warm-sand bg-white pl-9 pr-9 text-teal-dark placeholder:text-text-muted"
          />
          {filters.search && (
            <button
              type="button"
              data-testid="admin-oms-search-clear"
              aria-label={t("admin:adminOms.filters.clearSearch")}
              className="focus-ring absolute right-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-text-muted transition hover:bg-light-teal hover:text-teal-dark"
              onClick={() => {
                onChange({ search: "" });
                searchInputRef?.current?.focus();
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </div>
        <FilterSelect
          testId="admin-oms-filter-status"
          value={filters.status}
          label={t("admin:adminOms.filters.statusLabel")}
          allLabel={t("admin:adminOms.filters.allStatuses")}
          onValueChange={(status) => onChange({ status: status as OrdersPageFiltersState["status"] })}
        >
          {ORDER_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.orderStatus.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="admin-oms-filter-sort"
          value={filters.sort}
          label={t("admin:adminOms.filters.sortLabel")}
          onValueChange={(sort) => onChange({ sort: sort as OrdersPageFiltersState["sort"] })}
        >
          {SORT_OPTIONS.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.sort.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="admin-oms-filter-mode"
          value={filters.mode}
          label={t("admin:adminOms.filters.modeLabel")}
          allLabel={t("admin:adminOms.filters.allModes")}
          onValueChange={(mode) => onChange({ mode: mode as OrdersPageFiltersState["mode"] })}
        >
          {ORDER_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.mode.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        <FilterSelect
          testId="admin-oms-filter-payment"
          value={filters.paymentStatus}
          label={t("admin:adminOms.filters.paymentStatusLabel")}
          allLabel={t("admin:adminOms.filters.allPaymentStatuses")}
          onValueChange={(paymentStatus) =>
            onChange({ paymentStatus: paymentStatus as OrdersPageFiltersState["paymentStatus"] })
          }
        >
          {PAYMENT_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.paymentStatus.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="admin-oms-filter-fulfillment"
          value={filters.fulfillmentStatus}
          label={t("admin:adminOms.filters.fulfillmentStatusLabel")}
          allLabel={t("admin:adminOms.filters.allFulfillmentStatuses")}
          onValueChange={(fulfillmentStatus) =>
            onChange({ fulfillmentStatus: fulfillmentStatus as OrdersPageFiltersState["fulfillmentStatus"] })
          }
        >
          {FULFILLMENT_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.fulfillmentStatus.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="admin-oms-filter-inventory"
          value={filters.inventoryStatus}
          label={t("admin:adminOms.filters.inventoryStatusLabel")}
          allLabel={t("admin:adminOms.filters.allInventoryStatuses")}
          onValueChange={(inventoryStatus) =>
            onChange({ inventoryStatus: inventoryStatus as OrdersPageFiltersState["inventoryStatus"] })
          }
        >
          {INVENTORY_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.inventoryStatus.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="admin-oms-filter-accounting"
          value={filters.accountingStatus}
          label={t("admin:adminOms.filters.accountingStatusLabel")}
          allLabel={t("admin:adminOms.filters.allAccountingStatuses")}
          onValueChange={(accountingStatus) =>
            onChange({ accountingStatus: accountingStatus as OrdersPageFiltersState["accountingStatus"] })
          }
        >
          {ACCOUNTING_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.accountingStatus.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="admin-oms-filter-provider-ops"
          value={filters.providerOpsStatus}
          label={t("admin:adminOms.filters.providerOpsStatusLabel")}
          allLabel={t("admin:adminOms.filters.allProviderOpsStatuses")}
          onValueChange={(providerOpsStatus) =>
            onChange({ providerOpsStatus: providerOpsStatus as OrdersPageFiltersState["providerOpsStatus"] })
          }
        >
          {PROVIDER_OPS_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`admin:adminOms.providerOpsStatus.${value}`)}
            </SelectItem>
          ))}
        </FilterSelect>
        <DateFilter
          testId="admin-oms-filter-from"
          label={t("admin:adminOms.filters.fromLabel")}
          value={filters.from}
          onChange={(from) => onChange({ from })}
        />
        <DateFilter
          testId="admin-oms-filter-to"
          label={t("admin:adminOms.filters.toLabel")}
          value={filters.to}
          onChange={(to) => onChange({ to })}
        />
      </div>

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {PRESETS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            data-testid={`admin-oms-preset-${key}`}
            aria-pressed={filters.preset === key}
            onClick={() => onChange({ preset: key })}
            className={`flex min-h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs-plus font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/70 ${
              filters.preset === key
                ? "border-teal/60 bg-light-teal text-teal-dark"
                : "border-warm-sand bg-white text-text-muted hover:text-teal-dark"
            }`}
          >
            <Icon size={15} aria-hidden="true" />
            {t(`admin:adminOms.presets.${key}`)}
          </button>
        ))}
        {/* Withdrawn rows are hidden by default, never deleted. This is the way
            back to them, and it sits with the presets rather than among the
            status selects because it changes WHICH ROWS EXIST for the queue, not
            which of them is shown. */}
        <button
          type="button"
          data-testid="admin-oms-toggle-withdrawn"
          aria-pressed={filters.includeWithdrawn}
          onClick={() => onChange({ includeWithdrawn: !filters.includeWithdrawn })}
          className={`flex min-h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs-plus font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/70 ${
            filters.includeWithdrawn
              ? "border-teal/60 bg-light-teal text-teal-dark"
              : "border-warm-sand bg-white text-text-muted hover:text-teal-dark"
          }`}
        >
          <EyeOff size={15} aria-hidden="true" />
          {t("admin:adminOms.filters.includeWithdrawn")}
        </button>
      </div>
    </div>
  );
}

function FilterSelect({
  value,
  label,
  allLabel,
  testId,
  children,
  onValueChange,
}: {
  value: string;
  label: string;
  allLabel?: string;
  testId: string;
  children: ReactNode;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        data-testid={testId}
        aria-label={label}
        className="focus-ring w-full border-warm-sand bg-white text-teal-dark"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-warm-sand bg-white text-teal-dark">
        {allLabel && <SelectItem value="all">{allLabel}</SelectItem>}
        {children}
      </SelectContent>
    </Select>
  );
}

function DateFilter({
  value,
  label,
  testId,
  onChange,
}: {
  value: string;
  label: string;
  testId: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <label className="text-xxs font-semibold uppercase text-text-muted" htmlFor={testId}>
        {label}
      </label>
      <Input
        id={testId}
        data-testid={testId}
        aria-label={label}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring h-10 border-warm-sand bg-white text-teal-dark"
      />
    </div>
  );
}

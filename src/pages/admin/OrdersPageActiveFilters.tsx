import { X } from "lucide-react";
import type { TFunction } from "i18next";
import type { ActiveFilterChip, OrdersPageFiltersState } from "./ordersPageFilterOptions";

export function OrdersPageActiveFilters({
  chips,
  onRemove,
  onClear,
  t,
}: {
  chips: ActiveFilterChip[];
  onRemove: (key: keyof OrdersPageFiltersState) => void;
  onClear: () => void;
  t: TFunction;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      data-testid="admin-oms-active-filters"
      aria-label={t("admin:adminOms.filters.activeLabel")}
      className="mb-4 flex flex-wrap items-center gap-2 rounded-card border border-teal/30 bg-light-teal/40 px-3 py-2"
    >
      <span className="text-xxs font-bold uppercase text-teal-dark">{t("admin:adminOms.filters.activeLabel")}</span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          data-testid={chip.testId}
          aria-label={t("admin:adminOms.filters.removeChip", { filter: chip.label })}
          onClick={() => onRemove(chip.key)}
          className="focus-ring inline-flex items-center gap-1 rounded-full border border-teal/40 bg-white px-3 py-1 text-xs-plus font-semibold text-teal-dark transition hover:bg-light-teal"
        >
          {chip.label}
          <X size={13} aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        data-testid="admin-oms-clear-filters"
        onClick={onClear}
        className="focus-ring ml-auto rounded-full px-3 py-1 text-xs-plus font-bold text-warm-coral transition hover:underline"
      >
        {t("admin:adminOms.filters.clearFilters")}
      </button>
    </div>
  );
}

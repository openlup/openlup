import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  getAdminSubscriptionBand,
  setAdminCatalogPrice,
} from '@/domains/commerce/adminPromotionsClient';

/**
 * "Cena jednorazowa (lista)" — edit a SKU's base one-time price (the list price the
 * subscription band re-prices from). Reuses the subscription-band read for the SKU
 * list + current prices; writing here does NOT recompute the subscription price, so
 * re-apply the band afterwards.
 */
export function CatalogListPriceCard({ accessToken }: { accessToken: string | undefined }) {
  const queryClient = useQueryClient();
  const [sku, setSku] = useState('');
  const [priceInput, setPriceInput] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-subscription-band'],
    enabled: Boolean(accessToken),
    retry: false,
    queryFn: () => getAdminSubscriptionBand(accessToken as string),
  });

  // Pre-select the first SKU and seed its current list price once loaded.
  useEffect(() => {
    const entries = data?.entries ?? [];
    if (entries.length === 0) return;
    const current = entries.find((entry) => entry.sku === sku) ?? entries[0];
    if (!sku && current.sku) setSku(current.sku);
    if (!priceInput) setPriceInput((current.oneTimeMinor / 100).toFixed(2).replace('.', ','));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once from loaded data
  }, [data?.entries]);

  const save = useMutation({
    mutationFn: (input: { sku: string; unitPriceMinor: number }) =>
      setAdminCatalogPrice(accessToken as string, input),
    onSuccess: (result) => {
      toast.success(`Zaktualizowano cenę jednorazową: ${result.sku}`);
      queryClient.invalidateQueries({ queryKey: ['admin-subscription-band'] });
    },
    onError: () => toast.error('Nie udało się zapisać ceny jednorazowej'),
  });

  function handleSave() {
    const skuValue = sku.trim();
    if (!skuValue) {
      toast.error('Wybierz SKU');
      return;
    }
    const zl = Number(priceInput.replace(',', '.'));
    if (!Number.isFinite(zl) || zl <= 0 || zl > 1000) {
      toast.error('Podaj cenę z zakresu 0,01–1000,00 zł');
      return;
    }
    save.mutate({ sku: skuValue, unitPriceMinor: Math.round(zl * 100) });
  }

  return (
    <section className="rounded-2xl border border-warm-sand bg-white p-5">
      <h2 className="mb-1 font-display text-[16px] font-semibold text-teal-dark">
        Cena jednorazowa (lista)
      </h2>
      <p className="mb-4 text-xs-plus text-text-muted">
        Cena bazowa SKU (jednorazowa). Od niej liczony jest rabat subskrypcyjny. Zmiana tutaj
        NIE przelicza ceny subskrypcyjnej. Po zapisie kliknij „Zapisz" w karcie „Rabat za
        subskrypcję", aby przeliczyć cenę subskrypcji.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">SKU</span>
          <select
            value={sku}
            onChange={(event) => setSku(event.target.value)}
            className="h-10 min-w-44 rounded-lg border border-offwhite/15 bg-offwhite px-3 text-teal-dark"
          >
            {(data?.entries ?? []).map((entry) => (
              <option key={entry.variantId} value={entry.sku ?? ''}>
                {entry.sku ?? entry.variantId}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Cena (zł)</span>
          <input
            type="number"
            min={0.01}
            max={1000}
            step={0.01}
            value={priceInput}
            onChange={(event) => setPriceInput(event.target.value)}
            className="h-10 w-28 rounded-lg border border-offwhite/15 bg-offwhite px-3 text-teal-dark"
          />
        </label>
        <button
          type="button"
          onClick={handleSave}
          disabled={save.isPending || !accessToken}
          className="h-10 rounded-lg bg-teal px-4 text-sm font-semibold text-void transition hover:brightness-110 disabled:opacity-50"
        >
          {save.isPending ? 'Zapisywanie…' : 'Zapisz'}
        </button>
      </div>

      {isLoading && <p className="text-xs-plus text-text-muted">Ładowanie cen…</p>}
      {isError && <p className="text-xs-plus text-destructive">Nie udało się wczytać cen.</p>}
    </section>
  );
}

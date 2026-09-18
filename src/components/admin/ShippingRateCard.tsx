import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  getAdminShippingRate,
  setAdminShippingRate,
} from '@/domains/commerce/adminPromotionsClient';
import { DEFAULT_MONEY_LANG, formatCurrencyMinor } from '@/lib/currency/formatMinor';
import { ambientSettlementProfile } from '@/lib/currency/platformCurrency';

// Display only. The <input> below and the string it is seeded from stay on
// `toFixed(2)` on purpose: an edit affordance has to render what an operator is
// allowed to type back, and a grouped, symbol-suffixed value is not that.
function displayRate(minor: number): string {
  return formatCurrencyMinor(minor, {
    currency: ambientSettlementProfile.defaultCurrency,
    locale: DEFAULT_MONEY_LANG,
  });
}

/** "Koszt wysyłki" — flat shipping rate charged when no free-shipping promo applies. */
export function ShippingRateCard({ accessToken }: { accessToken: string | undefined }) {
  const queryClient = useQueryClient();
  const [zlInput, setZlInput] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-shipping-rate'],
    enabled: Boolean(accessToken),
    retry: false,
    queryFn: () => getAdminShippingRate(accessToken as string),
  });

  useEffect(() => {
    if (data?.shippingFlatMinor != null) setZlInput((data.shippingFlatMinor / 100).toFixed(2));
  }, [data?.shippingFlatMinor]);

  const setRate = useMutation({
    mutationFn: (shippingFlatMinor: number) =>
      setAdminShippingRate(accessToken as string, { shippingFlatMinor }),
    onSuccess: (result) => {
      toast.success(`Zaktualizowano koszt wysyłki: ${displayRate(result.shippingFlatMinor)}`);
      queryClient.invalidateQueries({ queryKey: ['admin-shipping-rate'] });
    },
    onError: () => toast.error('Nie udało się zapisać kosztu wysyłki'),
  });

  function handleSave() {
    const zl = Number(zlInput.replace(',', '.'));
    if (!Number.isFinite(zl) || zl < 0 || zl > 1000) {
      toast.error('Podaj kwotę z zakresu 0–1000 zł');
      return;
    }
    setRate.mutate(Math.round(zl * 100));
  }

  return (
    <section className="rounded-2xl border border-warm-sand bg-white p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="font-display text-[16px] font-semibold text-teal-dark">Koszt wysyłki</h2>
        {data?.shippingFlatMinor != null && (
          <span className="font-mono text-xs text-teal">
            aktualnie {displayRate(data.shippingFlatMinor)}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs-plus text-text-muted">
        Stała stawka doliczana do zamówienia, gdy nie obowiązuje promocja darmowej wysyłki.
        Przy aktywnej promocji free-shipping cena jest przekreślana do 0 w koszyku.
      </p>

      <div className="mb-2 flex items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Kwota (zł)</span>
          <input
            type="number"
            min={0}
            max={1000}
            step="0.01"
            value={zlInput}
            onChange={(event) => setZlInput(event.target.value)}
            className="h-10 w-28 rounded-lg border border-offwhite/15 bg-offwhite px-3 text-teal-dark"
          />
        </label>
        <button
          type="button"
          onClick={handleSave}
          disabled={setRate.isPending || !accessToken}
          className="h-10 rounded-lg bg-teal px-4 text-sm font-semibold text-void transition hover:brightness-110 disabled:opacity-50"
        >
          {setRate.isPending ? 'Zapisywanie…' : 'Zapisz'}
        </button>
      </div>

      {isLoading && <p className="text-xs-plus text-text-muted">Ładowanie kosztu wysyłki…</p>}
      {isError && <p className="text-xs-plus text-destructive">Nie udało się wczytać kosztu wysyłki.</p>}
    </section>
  );
}

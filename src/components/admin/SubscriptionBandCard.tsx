import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  getAdminSubscriptionBand,
  setAdminSubscriptionBand,
} from '@/domains/commerce/adminPromotionsClient';
import { DEFAULT_MONEY_LANG, formatCurrencyMinor } from '@/lib/currency/formatMinor';
import { ambientSettlementProfile } from '@/lib/currency/platformCurrency';

/** "Rabat za subskrypcję" — one global % that re-prices every SKU's subscription band. */
export function SubscriptionBandCard({ accessToken }: { accessToken: string | undefined }) {
  const queryClient = useQueryClient();
  const [percentInput, setPercentInput] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-subscription-band'],
    enabled: Boolean(accessToken),
    retry: false,
    queryFn: () => getAdminSubscriptionBand(accessToken as string),
  });

  useEffect(() => {
    if (data?.currentPercent != null) setPercentInput(String(data.currentPercent));
  }, [data?.currentPercent]);

  const setBand = useMutation({
    mutationFn: (percent: number) => setAdminSubscriptionBand(accessToken as string, { percent }),
    onSuccess: (result) => {
      toast.success(`Zaktualizowano rabat subskrypcji: ${result.appliedPercent}% (${result.updatedSkuCount} SKU)`);
      queryClient.invalidateQueries({ queryKey: ['admin-subscription-band'] });
    },
    onError: () => toast.error('Nie udało się zapisać rabatu subskrypcji'),
  });

  function handleSave() {
    const value = Number(percentInput.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value >= 100) {
      toast.error('Podaj procent z zakresu 0–99');
      return;
    }
    setBand.mutate(value);
  }

  return (
    <section className="rounded-2xl border border-warm-sand bg-white p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="font-display text-[16px] font-semibold text-teal-dark">Rabat za subskrypcję</h2>
        {data?.currentPercent != null && (
          <span className="font-mono text-xs text-teal">aktualnie −{data.currentPercent}%</span>
        )}
      </div>
      <p className="mb-4 text-xs-plus text-text-muted">
        Stała zniżka subskrypcji. Obowiązuje na pierwsze zamówienie i na każde kolejne
        odnowienie („−X% na kolejne"). Jeden globalny procent; po zapisie przelicza cenę
        subskrypcyjną każdego SKU z ceny jednorazowej (cena subskrypcji nigdy nie przekroczy
        ceny jednorazowej). Promocja „First Subscription 50%" dokłada się tylko na pierwsze zamówienie.
      </p>

      <div className="mb-4 flex items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Rabat %</span>
          <input
            type="number"
            min={0}
            max={99}
            step={1}
            value={percentInput}
            onChange={(event) => setPercentInput(event.target.value)}
            className="h-10 w-28 rounded-lg border border-offwhite/15 bg-offwhite px-3 text-teal-dark"
          />
        </label>
        <button
          type="button"
          onClick={handleSave}
          disabled={setBand.isPending || !accessToken}
          className="h-10 rounded-lg bg-teal px-4 text-sm font-semibold text-void transition hover:brightness-110 disabled:opacity-50"
        >
          {setBand.isPending ? 'Zapisywanie…' : 'Zapisz'}
        </button>
      </div>

      {isLoading && <p className="text-xs-plus text-text-muted">Ładowanie pasma cen…</p>}
      {isError && <p className="text-xs-plus text-destructive">Nie udało się wczytać pasma cen.</p>}
      {data && data.entries.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="py-1 font-medium">SKU</th>
              <th className="py-1 font-medium">Jednorazowa</th>
              <th className="py-1 font-medium">Subskrypcja</th>
              <th className="py-1 font-medium">Rabat</th>
            </tr>
          </thead>
          <tbody className="font-mono text-teal-dark/80">
            {data.entries.map((entry) => (
              <tr key={entry.variantId} className="border-t border-warm-sand">
                <td className="py-1">{entry.sku ?? entry.variantId}</td>
                <td className="py-1">{formatBandMoney(entry.oneTimeMinor)}</td>
                <td className="py-1">{formatBandMoney(entry.subscriptionMinor)}</td>
                <td className="py-1 text-teal">−{entry.percent}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// This card is untranslated prose with no `t()` in it, so it has no reader's
// language to ask and formats at DEFAULT_MONEY_LANG. The currency comes from the
// settlement profile: an operator running this admin in another currency reads
// their own prices, not the platform default's.
function formatBandMoney(minor: number): string {
  return formatCurrencyMinor(minor, {
    currency: ambientSettlementProfile.defaultCurrency,
    locale: DEFAULT_MONEY_LANG,
  });
}

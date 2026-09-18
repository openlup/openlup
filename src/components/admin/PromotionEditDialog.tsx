import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { updateAdminPromotion } from '@/domains/commerce/adminPromotionsClient';
import {
  PROMOTION_STATUSES,
  type AdminPromotion,
  type AdminPromotionUpdatePayload,
  type PromotionStatus,
} from '@/domains/commerce/adminPromotionsContracts';

interface Props {
  promotion: AdminPromotion | null;
  accessToken: string | undefined;
  onClose: () => void;
}

/** Edit one promotion's value / validity / limits / status. Code & type are fixed in v1. */
export function PromotionEditDialog({ promotion, accessToken, onClose }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<PromotionStatus>('active');
  const [validTo, setValidTo] = useState('');
  const [limitGlobal, setLimitGlobal] = useState('');
  const [limitPerCustomer, setLimitPerCustomer] = useState('');

  useEffect(() => {
    if (!promotion) return;
    setName(promotion.name);
    setValue(editableValue(promotion));
    setStatus(promotion.status);
    setValidTo(promotion.validTo ? promotion.validTo.slice(0, 10) : '');
    setLimitGlobal(promotion.redemptionLimitGlobal != null ? String(promotion.redemptionLimitGlobal) : '');
    setLimitPerCustomer(
      promotion.redemptionLimitPerCustomer != null ? String(promotion.redemptionLimitPerCustomer) : '',
    );
  }, [promotion]);

  const save = useMutation({
    mutationFn: (updates: AdminPromotionUpdatePayload) =>
      updateAdminPromotion(accessToken as string, { id: promotion!.id, updates }),
    onSuccess: () => {
      toast.success('Zapisano promocję');
      queryClient.invalidateQueries({ queryKey: ['admin-promotions'] });
      onClose();
    },
    onError: () => toast.error('Nie udało się zapisać promocji'),
  });

  function handleSave() {
    if (!promotion || promotion.readOnly) return;
    const isFreeShipping = promotion.discountType === 'free_shipping';
    const numericValue = Number(value.replace(',', '.'));
    if (!isFreeShipping && (!Number.isFinite(numericValue) || numericValue < 0)) {
      toast.error('Wartość rabatu musi być ≥ 0');
      return;
    }
    const updates: AdminPromotionUpdatePayload = {
      name: name.trim(),
      status,
      validTo: validTo ? new Date(`${validTo}T23:59:59Z`).toISOString() : null,
      redemptionLimitGlobal: limitGlobal ? Number(limitGlobal) : null,
      redemptionLimitPerCustomer: limitPerCustomer ? Number(limitPerCustomer) : null,
    };
    if (!isFreeShipping) updates.discountValue = numericValue;
    save.mutate(updates);
  }

  const isFreeShipping = promotion?.semanticBenefit.kind === 'free_shipping';
  const readOnly = promotion?.readOnly === true;

  return (
    <Dialog open={Boolean(promotion)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-warm-sand bg-white text-teal-dark sm:max-w-md">
        <h2 className="mb-1 font-display text-[18px] font-semibold">
          {promotion?.code ?? promotion?.name}
        </h2>
        <p className="mb-4 text-xs text-text-muted">
          {promotion?.triggerType} · {promotion?.discountType}
        </p>

        {readOnly && (
          <p className="mb-4 rounded-lg border border-warm-amber/40 bg-warm-amber/10 p-3 text-sm">
            Ta promocja jest zarządzana przez politykę cenową i jest dostępna tylko do odczytu.
          </p>
        )}

        {!readOnly && <div className="flex flex-col gap-3">
          <Field label="Nazwa">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {!isFreeShipping && (
            <Field
              label={promotion?.discountType === 'percentage' ? 'Wartość (%)' : 'Wartość (grosze)'}
            >
              <input
                className={inputCls}
                type="number"
                min={0}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          )}
          <Field label="Status">
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as PromotionStatus)}
            >
              {PROMOTION_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ważne do (opcjonalnie)">
            <input
              className={inputCls}
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Limit globalny">
              <input
                className={inputCls}
                type="number"
                min={1}
                value={limitGlobal}
                onChange={(e) => setLimitGlobal(e.target.value)}
              />
            </Field>
            <Field label="Limit / klienta">
              <input
                className={inputCls}
                type="number"
                min={1}
                value={limitPerCustomer}
                onChange={(e) => setLimitPerCustomer(e.target.value)}
              />
            </Field>
          </div>
        </div>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg border border-offwhite/15 px-4 text-sm text-text-muted hover:bg-offwhite"
          >
            {readOnly ? 'Zamknij' : 'Anuluj'}
          </button>
          {!readOnly && <button
            type="button"
            onClick={handleSave}
            disabled={save.isPending || !accessToken}
            className="h-10 rounded-lg bg-teal px-4 text-sm font-semibold text-void hover:brightness-110 disabled:opacity-50"
          >
            {save.isPending ? 'Zapisywanie…' : 'Zapisz'}
          </button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function statusLabel(status: PromotionStatus): string {
  return {
    active: 'Aktywna',
    paused: 'Wstrzymana',
    archived: 'Archiwalna',
    draft: 'Szkic',
  }[status];
}

function editableValue(promotion: AdminPromotion): string {
  if (promotion.semanticBenefit.kind === 'percentage') {
    return String(promotion.semanticBenefit.valuePercent);
  }
  if (promotion.semanticBenefit.kind === 'fixed_amount') {
    return String(promotion.semanticBenefit.valueMinor);
  }
  return '';
}

const inputCls = 'h-10 rounded-lg border border-offwhite/15 bg-offwhite px-3 text-teal-dark';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      {children}
    </label>
  );
}

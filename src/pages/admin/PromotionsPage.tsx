import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useAuth } from '@/lib/authContext';
import {
  getAdminPromotions,
  updateAdminPromotion,
} from '@/domains/commerce/adminPromotionsClient';
import type {
  AdminPromotion,
  PromotionStatus,
} from '@/domains/commerce/adminPromotionsContracts';
import { PromotionEditDialog } from '@/components/admin/PromotionEditDialog';
import { SubscriptionBandCard } from '@/components/admin/SubscriptionBandCard';
import { CatalogListPriceCard } from '@/components/admin/CatalogListPriceCard';
import { ShippingRateCard } from '@/components/admin/ShippingRateCard';
import { LegacyPromotionsSection } from '@/components/admin/LegacyPromotionsSection';
import {
  PromotionCodeCenter,
  type LegacyCompatibility,
} from '@/components/admin/promotion-codes/PromotionCodeCenter';

export default function PromotionsPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AdminPromotion | null>(null);
  // The Code Center is unconditional (its rollout flags were retired in PR 2243).
  // This is runtime state, not a gate: the Code Center reports whether it can
  // represent every legacy coupon, and only then does the legacy coupon list
  // stand down. Until it has answered we render nothing rather than assuming
  // "incompatible"; that assumption mounted the legacy section on every load and
  // tore it back down a moment later, in full view of the operator.
  const [legacyCompatibility, setLegacyCompatibility] = useState<LegacyCompatibility>('unknown');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-promotions'],
    enabled: Boolean(accessToken),
    retry: false,
    queryFn: () => getAdminPromotions(accessToken as string),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: PromotionStatus }) =>
      updateAdminPromotion(accessToken as string, { id, updates: { status } }),
    onSuccess: () => {
      toast.success('Zaktualizowano status promocji');
      queryClient.invalidateQueries({ queryKey: ['admin-promotions'] });
    },
    onError: () => toast.error('Nie udało się zmienić statusu'),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="font-display text-[24px] font-bold text-teal-dark">Rabaty</h1>
          <p className="text-sm text-text-muted">
            Zarządzaj cenami, promocjami automatycznymi i kodami promocyjnymi.
          </p>
        </header>

        <CatalogListPriceCard accessToken={accessToken} />

        <SubscriptionBandCard accessToken={accessToken} />

        <ShippingRateCard accessToken={accessToken} />
      </div>

      {accessToken && (
        <PromotionCodeCenter
          accessToken={accessToken}
          onLegacyCompatibilityChange={setLegacyCompatibility}
        />
      )}

      <div className="mx-auto max-w-4xl">
        <LegacyPromotionsSection
          title="Promocje automatyczne"
          promotions={data?.promotions.filter(
            (promotion) => promotion.triggerType === 'automatic',
          )}
          isLoading={isLoading}
          isError={isError}
          statusPending={changeStatus.isPending}
          onEdit={setEditing}
          onStatus={(id, status) => changeStatus.mutate({ id, status })}
        />
      </div>

      {/* Deliberately the last flow element on the page: mounting it only once
          compatibility is known appends at the bottom and displaces nothing the
          operator is already reading, so withholding it costs no layout shift. */}
      {legacyCompatibility === 'incompatible' && (
        <div className="mx-auto max-w-4xl">
          <LegacyPromotionsSection
            title="Kody rabatowe (legacy)"
            promotions={data?.promotions.filter(
              (promotion) => promotion.triggerType !== 'automatic',
            )}
            isLoading={isLoading}
            isError={isError}
            statusPending={changeStatus.isPending}
            onEdit={setEditing}
            onStatus={(id, status) => changeStatus.mutate({ id, status })}
          />
        </div>
      )}

      <PromotionEditDialog
        promotion={editing}
        accessToken={accessToken}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

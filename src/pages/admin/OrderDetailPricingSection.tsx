import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { DetailSection, InfoBlock } from "./OrderDetailBlocks";
import { formatMoney } from "./ordersPageUtils";

export function PricingSummarySection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  const pricing = detail.pricingSummary;
  const firstSubscription = detail.firstSubscriptionPricePresentation;
  if (firstSubscription) {
    const freeShipping = firstSubscription.shipping.amountMinor > 0
      && firstSubscription.shippingEffective.amountMinor === 0;
    return (
      <DetailSection testId="admin-oms-pricing-section" title={t("admin:adminOms.detail.pricing")}>
        <div className="grid gap-2 md:grid-cols-2">
          <InfoBlock label={t("admin:adminOms.detail.catalogProducts")} value={formatMoney(firstSubscription.catalogProducts, locale)} meta="" />
          <InfoBlock label={t("admin:adminOms.detail.firstSubscriptionDiscount", { percent: firstSubscription.discountPercent })} value={formatDiscount(firstSubscription.productDiscount, locale)} meta="" />
          <InfoBlock label={t("admin:adminOms.detail.productsAfterDiscount")} value={formatMoney(firstSubscription.productPayable, locale)} meta="" />
          <InfoBlock label={freeShipping ? t("admin:adminOms.detail.shippingFree") : t("admin:adminOms.detail.shippingAfterDiscount")} value={freeShipping ? t("admin:adminOms.detail.shippingFree") : formatMoney(firstSubscription.shippingEffective, locale)} meta="" />
        </div>
        <div className="mt-3 rounded-md border border-teal/25 bg-teal/10 px-3 py-2">
          <p className="text-xxs font-semibold uppercase text-teal/80">{t("admin:adminOms.detail.finalPaid")}</p>
          <p className="font-display text-xl font-semibold text-teal-dark">{formatMoney(firstSubscription.total, locale)}</p>
          <p className="text-xs text-text-muted">{t(`admin:adminOms.pricingSource.${pricing.source}`)}</p>
        </div>
      </DetailSection>
    );
  }
  return (
    <DetailSection testId="admin-oms-pricing-section" title={t("admin:adminOms.detail.pricing")}>
      <div className="grid gap-2 md:grid-cols-2">
        <InfoBlock label={t("admin:adminOms.detail.subtotalBeforeDiscounts")} value={formatMoney(pricing.subtotal, locale)} meta="" />
        <InfoBlock label={t("admin:adminOms.detail.productDiscount")} value={formatDiscount(pricing.productDiscount, locale)} meta="" />
        <InfoBlock label={t("admin:adminOms.detail.shippingAfterDiscount")} value={formatMoney(pricing.shipping, locale)} meta="" />
        <InfoBlock label={t("admin:adminOms.detail.shippingDiscount")} value={formatDiscount(pricing.shippingDiscount, locale)} meta="" />
      </div>
      <div className="mt-3 rounded-md border border-teal/25 bg-teal/10 px-3 py-2">
        <p className="text-xxs font-semibold uppercase text-teal/80">{t("admin:adminOms.detail.finalPaid")}</p>
        <p className="font-display text-xl font-semibold text-teal-dark">{formatMoney(pricing.finalTotal, locale)}</p>
        <p className="text-xs text-text-muted">{t(`admin:adminOms.pricingSource.${pricing.source}`)}</p>
      </div>
    </DetailSection>
  );
}

function formatDiscount(money: { amountMinor?: number; currency: string }, locale: string): string {
  const amount = Math.abs(money.amountMinor ?? 0);
  return amount === 0 ? formatMoney({ ...money, amountMinor: 0 }, locale) : `-${formatMoney({ ...money, amountMinor: amount }, locale)}`;
}

import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

import type { StorefrontSsgSummaryItem } from "@/domains/catalog/storefrontSsgCatalog";
import { useCommerceOfferPricing } from "@/domains/commerce/useCommerceOfferPricing";
import { STARTER_DELIVERY2_DISCOUNT_BPS } from "@/domains/commerce/starterOfferPolicy";
import { formatMoney } from "@/checkout/composer/configuratorPricing";

/**
 * Oferta startowa na karcie produktu — JEDNA karta, bez wyboru.
 *
 * Poprzednio stał tu radiogroup „subskrypcja / zamówienie jednorazowe". Wybór
 * zniknął razem z jednorazówką w ścieżce pozyskania: nowy klient dostaje pakiet
 * startowy (patrz `starterOfferPolicy`), więc dwie opcje obiecywały tryb, którego
 * konfigurator już nie zaproponuje. Grupa radio z jedną opcją byłaby gorsza niż
 * jej brak — czytnik ekranu ogłaszałby decyzję, której nie ma — dlatego semantyka
 * radio została usunięta, a nie zwinięta do jednego pola.
 *
 * Kształt celowo 1:1 z kafelkiem subskrypcji, który stał tu wcześniej: nagłówek
 * z plakietką, duża cena, JEDNA linia warunków. Wersja z wypunktowaną listą
 * warunków wewnątrz nasyconego pudełka czytała się jak ostrzeżenie, a nie jak
 * oferta (Maciej, review) — cena musi być największym elementem, a nie jednym
 * z pięciu bloków tekstu.
 *
 * Linia warunków mówi TYLKO o dostawie 1 i 2. Rabat od trzeciej dostawy jest
 * indywidualny (wyliczany z zapotrzebowania psa), więc żadna "stała cena"
 * ani procent nie mogą tu paść (Maciej, review 2026-08-17).
 *
 * Procenty: dostawa 1 pochodzi z serwerowej projekcji oferty, dostawa 2 ze
 * `STARTER_DELIVERY2_DISCOUNT_BPS` — tej samej stałej, z której liczy checkout
 * i serwerowy guard. Bez projekcji karta zostaje i nadal niesie drabinkę,
 * ale bez kwot.
 */

interface Props {
  product: Pick<StorefrontSsgSummaryItem, "slug" | "color">;
}

const STARTER_DELIVERY2_PERCENT = STARTER_DELIVERY2_DISCOUNT_BPS / 100;

const ProductOfferCard = ({ product }: Props) => {
  const { i18n, t } = useTranslation("catalog");
  const lang = i18n.language === "en" ? "en" : "pl";
  const { data } = useCommerceOfferPricing();
  const pricing = data?.products.find((entry) => entry.productSlug === product.slug);

  return (
    <div className="mt-5 max-w-[520px]">
      <section
        aria-label={t("catalog:product.offerGroupLabel")}
        className="rounded-2xl border-2 px-5 py-4 shadow-sm"
        style={{ borderColor: product.color, backgroundColor: `${product.color}14` }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex w-5 h-5 rounded-full items-center justify-center text-white"
              style={{ backgroundColor: product.color }}
            >
              <Check className="w-3 h-3" strokeWidth={3.5} />
            </span>
            <span className="font-body font-semibold text-base text-charcoal">
              {t("catalog:product.offerLabel")}
            </span>
          </span>
          {pricing && pricing.initialDiscountPercent > 0 && (
            <span
              className="rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-white"
              style={{ backgroundColor: product.color }}
            >
              {t("catalog:product.offerBadgeDynamic", {
                percent: pricing.initialDiscountPercent,
              })}
            </span>
          )}
        </div>

        {pricing && (
          <div className="mt-2 flex items-baseline gap-2 flex-wrap">
            <span className="font-display font-semibold text-[26px] text-teal-dark">
              {t("catalog:product.fromPrice", {
                price: formatMoney(pricing.subscriptionInitial.unitGross.amountMinor, lang),
              })}
            </span>
            <span className="font-body text-sm text-charcoal/55">
              {t("catalog:product.fromPriceUnit")}
            </span>
            {pricing.catalogAnchorUnitGross.amountMinor >
              pricing.subscriptionInitial.unitGross.amountMinor && (
              <span className="font-body text-sm text-charcoal/40 line-through">
                {formatMoney(pricing.catalogAnchorUnitGross.amountMinor, lang)}
              </span>
            )}
          </div>
        )}

        <p className="font-body text-xs-plus text-charcoal/60 leading-snug mt-1">
          {pricing
            ? t("catalog:product.offerLadderDynamic", {
                initialPercent: pricing.initialDiscountPercent,
                secondPercent: STARTER_DELIVERY2_PERCENT,
              })
            : t("catalog:product.offerLadder", { secondPercent: STARTER_DELIVERY2_PERCENT })}
        </p>
      </section>
    </div>
  );
};

export default ProductOfferCard;

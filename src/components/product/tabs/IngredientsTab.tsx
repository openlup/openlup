import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";
import { ingredientIcon } from "./ingredientIcons";

interface Props {
  product: StorefrontItem;
}

type CardData = StorefrontItem["ingredientCards"][number];

// Product-specific rationale headings are presentation copy, not formula facts.
// They remain in i18n until a later, explicitly scoped presentation migration;
// every ingredient fact below comes directly from the locale-specific snapshot.
const headingKeys: Record<string, { label: string; title: string; body: string | null }> = {
  lamb: {
    label: "catalog:product.ingredientRationale",
    title: "catalog:product.ingredientDefaultTitle",
    body: "catalog:product.lambIngBody",
  },
  venison: {
    label: "catalog:product.ingredientRationale",
    title: "catalog:product.venisonIngTitle",
    body: "catalog:product.venisonIngBody",
  },
  chicken: {
    label: "catalog:product.ingredientRationale",
    title: "catalog:product.chickenIngTitle",
    body: "catalog:product.chickenIngBody",
  },
  salmon: {
    label: "catalog:product.ingredientRationale",
    title: "catalog:product.salmonIngTitle",
    body: "catalog:product.salmonIngBody",
  },
};

const formatPct = (pct: string, lang: string) =>
  lang === "en" ? pct.replace(",", ".") : pct.replace(".", ",");

const IngredientTile = ({ card, product, isPrimary }: { card: CardData; product: StorefrontItem; isPrimary: boolean }) => {
  const { i18n } = useTranslation("catalog");
  const icon = ingredientIcon(card.name);

  return (
    <div
      className="rounded-2xl bg-white border p-5 flex flex-col items-center text-center h-full"
      style={{ borderColor: isPrimary ? product.color : "rgba(0,0,0,0.08)" }}
    >
      {icon && (
        <span className="w-16 h-16 rounded-full flex items-center justify-center mb-3 shrink-0" style={{ backgroundColor: `${product.color}12` }}>
          <img src={icon} alt="" loading="lazy" decoding="async" className="w-10 h-10 object-contain" />
        </span>
      )}
      <h3 className="font-display font-semibold text-base text-text-on-light leading-tight">{card.name}</h3>
      <span className={`font-mono font-bold mt-1 ${isPrimary ? "text-lg" : "text-sm"}`} style={{ color: isPrimary ? product.color : "hsl(var(--text-muted))" }}>
        {formatPct(card.pct, i18n.language)}
      </span>
      <p className="font-body text-[10px] text-text-muted mt-1 uppercase tracking-wider">{card.role}</p>
      <p className="font-body text-xs text-text-on-light/65 leading-[1.55] mt-2">{card.body}</p>
      {card.claimPill && <ClaimPill card={card} product={product} />}
    </div>
  );
};

const ClaimPill = ({ card, product }: { card: CardData; product: StorefrontItem }) => (
  <span
    className="inline-block rounded-full border font-mono text-[10px] px-2.5 py-1 mt-2.5"
    style={{ borderColor: `${product.color}50`, color: product.color }}
  >
    {card.claimPill}
  </span>
);

const MicroTile = ({ card, product }: { card: CardData; product: StorefrontItem }) => {
  const { i18n } = useTranslation("catalog");
  const icon = ingredientIcon(card.name);
  return (
    <div className="rounded-xl bg-white border border-border-light p-3.5 flex items-start gap-3">
      {icon && (
        <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${product.color}10` }}>
          <img src={icon} alt="" loading="lazy" decoding="async" className="w-6 h-6 object-contain" />
        </span>
      )}
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-body font-medium text-xs-plus text-text-on-light">{card.name}</span>
          <span className="font-mono text-xxs text-text-muted">{formatPct(card.pct, i18n.language)}</span>
        </div>
        <p className="font-body text-xxs text-text-muted/70">{card.role}</p>
        <p className="font-body text-xs text-text-on-light/55 leading-normal mt-0.5">{card.body}</p>
        {card.claimPill && <ClaimPill card={card} product={product} />}
      </div>
    </div>
  );
};

const IngredientsTab = ({ product }: Props) => {
  const { t } = useTranslation("catalog");
  const hKeys = headingKeys[product.slug] || {
    label: "catalog:product.ingredientRationale",
    title: "catalog:product.ingredientDefaultTitle",
    body: null,
  };

  const pctNum = (s: string) => parseFloat(s.replace(",", "."));
  const primaryIngredients = product.ingredientCards.filter(c => pctNum(c.pct) >= 10);
  const midIngredients = product.ingredientCards.filter(c => {
    const p = pctNum(c.pct);
    return p >= 1 && p < 10;
  });
  const microIngredients = product.ingredientCards.filter(c => {
    const p = pctNum(c.pct);
    return p < 1 || c.pct.startsWith("<") || c.pct.startsWith("~");
  });

  return (
    <div>
      <p className="label-text mb-2" style={{ letterSpacing: "0.18em", color: product.color }}>
        {t(hKeys.label)}
      </p>
      <h2 className="font-display font-semibold text-[24px] lg:text-[36px] text-text-on-light leading-[1.05]">
        {t(hKeys.title)}
      </h2>
      <p className="font-body text-sm-plus text-text-on-light/70 mt-2 max-w-[600px]">
        {t(hKeys.body ?? "catalog:product.ingredientDefaultBody")}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-8">
        {[...primaryIngredients, ...midIngredients].map((card, i, arr) => (
          <div key={card.name} className={arr.length % 2 === 1 && i === arr.length - 1 ? "sm:col-span-2" : ""}>
            <IngredientTile card={card} product={product} isPrimary={pctNum(card.pct) >= 10} />
          </div>
        ))}
      </div>

      {microIngredients.length > 0 && (
        <div className="mt-6">
          <p className="micro-text text-text-muted mb-3 uppercase tracking-wider">{t("catalog:product.traceIngredients")}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {microIngredients.map((card) => <MicroTile key={card.name} card={card} product={product} />)}
          </div>
        </div>
      )}
    </div>
  );
};

export default IngredientsTab;

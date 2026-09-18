import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";

interface Props {
  product: StorefrontItem;
}

const nutrientKeyMap: Record<string, string> = {
  "Crude Protein": "catalog:product.nutrientCrudeProtein",
  "Crude Fat": "catalog:product.nutrientCrudeFat",
  "Moisture": "catalog:product.nutrientMoisture",
  "Crude Ash": "catalog:product.nutrientCrudeAsh",
  "Crude Fibre": "catalog:product.nutrientCrudeFibre",
  "Carbohydrates": "catalog:product.nutrientCarbohydrates",
  "Calcium": "catalog:product.nutrientCalcium",
  "Phosphorus": "catalog:product.nutrientPhosphorus",
  "Ca:P ratio": "catalog:product.nutrientCaPRatio",
};

const NutritionalTab = ({ product }: Props) => {
  const hasTBC = product.analytics.some((r) => r.pct === "–");
  const { t } = useTranslation("catalog");
  const isCat = product.species === "Cat";

  return (
    <div>
      <p className="label-text mb-2" style={{ letterSpacing: "0.18em", color: product.color }}>
        {t("catalog:product.analyticalConstituents")}
      </p>
      <h2 className="font-display font-semibold text-[24px] lg:text-[36px] text-text-on-light leading-[1.05]">
        {t("catalog:product.nutritionHeading")}
      </h2>
      <p className="font-body text-xs-plus text-text-on-light/60 mt-2">
        {isCat ? t("catalog:product.fediafVerifiedCat") : t("catalog:product.fediafVerifiedDog")}
      </p>

      <div className="grid md:grid-cols-2 gap-6 mt-8">
        {/* Analytics table */}
        <div className="rounded-2xl border border-border-light bg-white overflow-hidden">
          <div className="grid grid-cols-3 px-4 py-2.5 border-b border-border-light bg-offwhite">
            <p className="micro-text text-text-muted">{t("catalog:product.nutrientCol")}</p>
            <p className="micro-text text-text-muted text-right">{t("catalog:product.asFedCol")}</p>
            <p className="micro-text text-text-muted text-right">{t("catalog:product.dryMatterCol")}</p>
          </div>
          {product.analytics.map((row, i) => (
            <div
              key={row.name}
              className={`grid grid-cols-3 px-4 py-2.5 ${i < product.analytics.length - 1 ? "border-b border-border-light/50" : ""}`}
            >
              <p className="font-body text-xs-plus text-text-on-light font-medium">{t(nutrientKeyMap[row.name] || row.name)}</p>
              <p className="font-mono text-xs text-text-on-light text-right">{row.pct}{row.pct !== "–" && row.name !== "Ca:P ratio" ? "%" : ""}</p>
              <p className="font-mono text-xs text-text-muted text-right">{row.dm ?? "–"}{row.dm && row.dm !== "–" && row.name !== "Ca:P ratio" ? "%" : ""}</p>
            </div>
          ))}
          <div className="grid grid-cols-3 px-4 py-2.5 border-t border-border-light" style={{ background: `${product.color}0a` }}>
            <p className="font-body text-xs-plus font-semibold" style={{ color: product.color }}>{t("catalog:product.energyLabel")}</p>
            <p className="font-mono text-xs text-right font-semibold" style={{ color: product.color }}>
              {product.energyPer100g ? `${product.energyPer100g} kcal` : t("catalog:product.pendingLabel")}
            </p>
            <p className="font-mono text-xs text-text-muted text-right">/ 100 g</p>
          </div>
          {hasTBC && (
            <p className="font-mono text-[10px] text-text-muted px-4 py-2">
              {t("catalog:product.labAnalysisPending")}
            </p>
          )}
        </div>

        {/* Supplements */}
        <div className="rounded-2xl border border-border-light bg-white p-4">
          <p className="label-text mb-3" style={{ letterSpacing: "0.12em", color: product.color }}>
            {t("catalog:product.nutritionalAdditives")}
          </p>
          {product.supplementsList ? (
            <div className="space-y-2.5">
              {product.supplementsList.map((sup) => (
                <div key={sup.nameKey} className="flex items-baseline justify-between gap-3">
                  <div>
                    <span className="font-body text-xs-plus text-text-on-light font-medium">{t(sup.nameKey)}</span>
                    {sup.roleKey && (
                      <span className="font-body text-xs text-text-on-light/50 ml-1.5">– {t(sup.roleKey)}</span>
                    )}
                  </div>
                  <span className="font-mono text-xs text-text-on-light shrink-0">{sup.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="micro-text text-text-muted mb-1">IU / kg</p>
                <p className="font-body text-xs-plus text-text-on-light leading-[1.6]">{product.supplements.IU_kg}</p>
              </div>
              <div>
                <p className="micro-text text-text-muted mb-1">mg / kg</p>
                <p className="font-body text-xs-plus text-text-on-light leading-[1.6]">{product.supplements.mg_kg}</p>
              </div>
              <div>
                <p className="micro-text text-text-muted mb-1">µg / kg</p>
                <p className="font-body text-xs-plus text-text-on-light leading-[1.6]">{product.supplements.ug_kg}</p>
              </div>
            </div>
          )}
          <div className="mt-4 pt-3 border-t border-border-light">
            <p className="micro-text text-text-muted leading-relaxed">
              {product.supplements.note || t("catalog:product.additivesDefaultNote")}
            </p>
          </div>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid sm:grid-cols-3 gap-4 mt-8">
        {[
          { title: t("catalog:product.aminoAcid"), body: t("catalog:product.aminoAcidBody") },
          { title: t("catalog:product.vitaminMineral"), body: t("catalog:product.vitaminMineralBody") },
          { title: t("catalog:product.omega3Balance"), body: isCat ? t("catalog:product.omega3BalanceBodyCat") : t("catalog:product.omega3BalanceBody") },
        ].map((card) => (
          <div key={card.title} className="rounded-2xl bg-white border border-border-light p-4">
            <h3 className="font-display font-semibold text-sm-plus text-text-on-light">{card.title}</h3>
            <p className="font-body text-xs-plus text-text-on-light/65 leading-normal mt-1.5">{card.body}</p>
          </div>
        ))}
      </div>

      {product.nutritionExtra && (
        <div className="mt-6 max-w-[640px]">
          <div className="rounded-xl p-4" style={{ border: `1px solid ${product.color}33` }}>
            <p className="label-text mb-1" style={{ letterSpacing: "0.12em", color: product.color, fontSize: "10px" }}>
              {product.nutritionExtra.label}
            </p>
            <p className="font-body text-xs-plus text-text-on-light/60 leading-[1.6]">
              {product.nutritionExtra.body}
            </p>
          </div>
        </div>
      )}

      <p className="font-body text-xs text-text-muted mt-6 leading-relaxed">
        {t("catalog:product.nutritionDisclaimer")}
      </p>
    </div>
  );
};

export default NutritionalTab;

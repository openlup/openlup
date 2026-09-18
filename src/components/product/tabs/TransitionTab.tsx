import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";
import FeedingGuideCompact from "../FeedingGuideCompact";

interface Props {
  product: StorefrontItem;
}

const transitionCalloutKey: Record<string, string> = {
  venison: "catalog:product.venisonTransitionCallout",
};

const TransitionTab = ({ product }: Props) => {
  const { t } = useTranslation("catalog");

  const steps = [
    { daysKey: "catalog:product.transitionDays12", pct: 25, oldPct: 75, label: `75% ${t("catalog:product.currentFood")} + 25% openlup` },
    { daysKey: "catalog:product.transitionDays34", pct: 50, oldPct: 50, label: `50% ${t("catalog:product.currentFood")} + 50% openlup` },
    { daysKey: "catalog:product.transitionDays56", pct: 75, oldPct: 25, label: `25% ${t("catalog:product.currentFood")} + 75% openlup` },
    { daysKey: "catalog:product.transitionDay7", pct: 100, oldPct: 0, label: "100% openlup" },
  ];

  return (
    <div>
      {/* Feeding guide with silhouettes */}
      <div className="rounded-2xl bg-white border border-border-light p-6 lg:p-8 mb-10">
        <FeedingGuideCompact product={product} />
      </div>

      <h2 className="font-display font-semibold text-[24px] lg:text-[36px] text-text-on-light leading-[1.05]">
        {t("catalog:product.transitionHeading")}
      </h2>
      {product.transitionIntro && (
        <p className="font-body text-sm-plus text-text-on-light/70 mt-2 max-w-[560px]">
          {product.transitionIntro}
        </p>
      )}

      {product.transitionCallout && (
        <div className="mt-6 max-w-[640px]">
          <div className="rounded-r-xl p-4" style={{ background: `${product.color}0f`, borderLeft: `4px solid ${product.color}` }}>
            <p className="font-body text-sm text-text-on-light/80 leading-[1.6]">{t(transitionCalloutKey[product.slug] ?? product.transitionCallout)}</p>
          </div>
        </div>
      )}

      {/* Timeline — progress bars */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-8">
        {steps.map((step) => (
          <div key={step.daysKey} className="rounded-2xl bg-white border border-border-light p-4 text-center">
            <p className="font-display font-semibold text-sm text-text-on-light mb-3">{t(step.daysKey)}</p>
            <div className="h-[80px] w-[40px] mx-auto rounded-lg overflow-hidden flex flex-col-reverse border border-border-light/60">
              <div
                className="transition-all duration-300"
                style={{
                  height: `${step.pct}%`,
                  backgroundColor: `${product.color}cc`,
                }}
              />
              <div
                className="bg-charcoal/10 transition-all duration-300"
                style={{ height: `${step.oldPct}%` }}
              />
            </div>
            <p className="font-mono text-[10px] text-text-muted mt-2 leading-tight">{step.label}</p>
          </div>
        ))}
      </div>

      {/* Storage info */}
      <div className="mt-8 rounded-xl p-4 bg-white border border-border-light">
        <p className="font-body text-sm text-text-on-light/80 leading-[1.6]">
          {t("catalog:product.storageInfo")}
        </p>
      </div>
    </div>
  );
};

export default TransitionTab;

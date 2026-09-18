import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";

interface Props {
  product: StorefrontItem;
}

const NutritionalPanel = ({ product }: Props) => {
  const hasTBC = product.analytics.some((r) => r.pct === "–");

  return (
    <section id="nutrition" className="bg-white py-[100px] lg:py-[140px] px-6 lg:px-[72px]">
      <div className="max-w-[1080px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
          <p className="label-text mb-4" style={{ letterSpacing: "0.18em", color: product.color }}>
            ANALYTICAL CONSTITUENTS
          </p>
          <h2 className="font-display font-semibold text-[28px] lg:text-[48px] text-text-on-light leading-none">
            Full nutritional transparency.
          </h2>
          <p className="font-body text-sm text-text-on-light/60 mt-3">
            FEDIAF-verified. Complete and balanced for adult {product.species === "Cat" ? "cats" : "dogs"}.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8 lg:gap-12 mt-12">
          {/* Left — Analytics table */}
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
            <div className="rounded-3xl border border-border-light bg-offwhite overflow-hidden">
              <div className="grid grid-cols-3 px-5 py-3 border-b border-border-light">
                <p className="micro-text text-text-muted">Nutrient</p>
                <p className="micro-text text-text-muted text-right">As Fed</p>
                <p className="micro-text text-text-muted text-right">Dry Matter</p>
              </div>
              {product.analytics.map((row, i) => (
                <div
                  key={row.name}
                  className={`grid grid-cols-3 px-5 py-3 ${i < product.analytics.length - 1 ? "border-b border-border-light/50" : ""}`}
                >
                  <p className="font-body text-sm text-text-on-light font-medium">{row.name}</p>
                  <p className="font-mono text-xs-plus text-text-on-light text-right">{row.pct}</p>
                  <p className="font-mono text-xs-plus text-text-muted text-right">{row.dm ?? "–"}</p>
                </div>
              ))}
              {/* Energy row */}
              <div className="grid grid-cols-3 px-5 py-3 border-t border-border-light" style={{ background: `${product.color}0a` }}>
                <p className="font-body text-sm font-semibold" style={{ color: product.color }}>Energy</p>
                <p className="font-mono text-xs-plus text-right font-semibold" style={{ color: product.color }}>
                  {product.energyPer100g ? `${product.energyPer100g} kcal` : "–"}
                </p>
                <p className="font-mono text-xs-plus text-text-muted text-right">/ 100 g</p>
              </div>
            </div>
            {hasTBC && (
              <p className="font-mono text-[10px] text-text-muted mt-3">
                * Lab analysis pending. Certificate available upon request.
              </p>
            )}
          </motion.div>

          {/* Right — Supplements */}
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
            <div className="rounded-3xl border border-border-light bg-offwhite p-5 lg:p-6">
              <p className="label-text mb-4" style={{ letterSpacing: "0.12em", color: product.color }}>
                NUTRITIONAL ADDITIVES
              </p>

              <div className="space-y-5">
                <div>
                  <p className="micro-text text-text-muted mb-2">IU / kg</p>
                  <p className="font-body text-sm text-text-on-light leading-[1.7]">
                    {product.supplements.IU_kg}
                  </p>
                </div>
                <div>
                  <p className="micro-text text-text-muted mb-2">mg / kg</p>
                  <p className="font-body text-sm text-text-on-light leading-[1.7]">
                    {product.supplements.mg_kg}
                  </p>
                </div>
                <div>
                  <p className="micro-text text-text-muted mb-2">µg / kg</p>
                  <p className="font-body text-sm text-text-on-light leading-[1.7]">
                    {product.supplements.ug_kg}
                  </p>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-border-light">
                <p className="micro-text text-text-muted leading-relaxed">
                  {product.supplements.note || "All additives listed with EU feed additive registration numbers. Fully traceable and verifiable."}
                </p>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Nutrition extra callout (salmon omega-3 note) */}
        {product.nutritionExtra && (
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="mt-8 max-w-[640px] mx-auto">
            <div
              className="rounded-xl p-5"
              style={{
                border: `1px solid ${product.color}33`,
              }}
            >
              <p className="label-text mb-2" style={{ letterSpacing: "0.12em", color: product.color, fontSize: "10px" }}>
                {product.nutritionExtra.label}
              </p>
              <p className="font-body text-sm text-text-on-light/60 leading-[1.7]">
                {product.nutritionExtra.body}
              </p>
            </div>
          </motion.div>
        )}
      </div>
    </section>
  );
};

export default NutritionalPanel;

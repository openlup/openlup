import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";

interface Props {
  product: StorefrontItem;
}

const IngredientsSection = ({ product }: Props) => {
  const { t } = useTranslation("catalog");

  const headingKey = `catalog:product.${product.slug}IngTitle`;
  const bodyKey = `catalog:product.${product.slug}IngBody`;
  const labelKey = "catalog:product.ingredientRationale";
  const defaultTitleKey = "catalog:product.ingredientDefaultTitle";

  const headingTitle = t(headingKey, { defaultValue: "" }) || t(defaultTitleKey);
  const headingBody = t(bodyKey, { defaultValue: "" }) || product.tagline;

  return (
    <section id="ingredients" className="bg-offwhite py-[100px] lg:py-[140px] px-6 lg:px-[72px]">
      <div className="max-w-[960px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
          <p
            className="label-text mb-4"
            style={{ letterSpacing: "0.18em", color: product.color }}
          >
            {t(labelKey)}
          </p>
          <h2 className="font-display font-semibold text-[28px] lg:text-[48px] text-text-on-light leading-none whitespace-pre-line">
            {headingTitle}
          </h2>
          <p className="font-body text-base text-text-on-light/70 mt-4 max-w-[600px]">
            {headingBody}
          </p>
        </motion.div>

        <div className="mt-12 space-y-5">
          {product.ingredientCards.map((card) => {
            const name = card.nameKey ? t(card.nameKey) : card.name;
            const role = card.roleKey ? t(card.roleKey) : card.role;
            const body = card.bodyKey ? t(card.bodyKey) : card.body;
            const pill = card.claimPillKey ? t(card.claimPillKey) : card.claimPill;

            return (
              <motion.div
                key={card.name}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={fadeUp}
                className="rounded-3xl bg-white border border-border-light overflow-hidden"
              >
                <div className="flex">
                  <div className="w-1 shrink-0" style={{ backgroundColor: product.color }} />
                  <div className="p-6 lg:p-8 flex-1">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <h3 className="font-display font-semibold text-xl lg:text-[24px] text-text-on-light">
                        {name}
                      </h3>
                      <span className="font-mono text-xs-plus font-semibold" style={{ color: product.color }}>
                        {card.pct}
                      </span>
                    </div>
                    <p className="label-text text-text-muted mt-1" style={{ letterSpacing: "0.12em" }}>
                      {role}
                    </p>
                    <div className="font-body text-sm-plus text-[#3A3A3A] leading-[1.7] mt-4 whitespace-pre-line">
                      {body}
                    </div>
                    {pill && (
                      <span
                        className="inline-block rounded-full border font-mono text-xxs px-3 py-1.5 mt-4"
                        style={{
                          borderColor: `${product.color}50`,
                          color: product.color,
                        }}
                      >
                        {pill}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default IngredientsSection;

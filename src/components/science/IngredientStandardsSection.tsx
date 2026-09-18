import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { Tag, Award, Filter, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";

const pointDefs = [
  { icon: Tag, iconColor: "hsl(var(--sage-mint))", bgClass: "bg-[hsl(var(--sage-tint))]", titleKey: "content:science.ingredients.card1Title", bodyKey: "content:science.ingredients.card1Body" },
  { icon: Award, iconColor: "hsl(var(--warm-coral))", bgClass: "bg-[hsl(var(--coral-tint))]", titleKey: "content:science.ingredients.card2Title", bodyKey: "content:science.ingredients.card2Body" },
  { icon: Filter, iconColor: "hsl(var(--soft-lavender))", bgClass: "bg-[hsl(var(--lavender-tint))]", titleKey: "content:science.ingredients.card3Title", bodyKey: "content:science.ingredients.card3Body" },
  { icon: Eye, iconColor: "hsl(var(--warm-amber))", bgClass: "bg-offwhite", titleKey: "content:science.ingredients.card4Title", bodyKey: "content:science.ingredients.card4Body" },
];

const IngredientStandardsSection = () => {
  const { t } = useTranslation("content");

  return (
    <section className="bg-offwhite py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[960px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-14">
          <span className="inline-block label-text text-charcoal/45 rounded-full border border-charcoal/15 px-4 py-1.5">{t("content:science.ingredients.badge")}</span>
          <h2 className="font-display font-semibold text-[32px] lg:text-[48px] text-charcoal leading-[0.95] mt-6">
            {t("content:science.ingredients.heading1")}<br />{t("content:science.ingredients.heading2")}
          </h2>
        </motion.div>
        <div className="grid sm:grid-cols-2 gap-6">
          {pointDefs.map((p) => {
            const Icon = p.icon;
            return (
              <motion.div key={p.titleKey} initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className={`${p.bgClass} rounded-[16px] p-8 border border-charcoal/6`}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ backgroundColor: `${p.iconColor}20` }}>
                  <Icon size={24} style={{ color: p.iconColor }} />
                </div>
                <h3 className="font-display font-semibold text-lg text-charcoal">{t(p.titleKey)}</h3>
                <p className="font-body text-sm-plus text-charcoal/60 leading-relaxed mt-3">{t(p.bodyKey)}</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default IngredientStandardsSection;

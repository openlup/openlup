import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";
import { Bug, Shield, Flame, HeartPulse } from "lucide-react";

interface Props {
  product?: StorefrontItem | null;
}

const GutScienceStrip = ({ product }: Props) => {
  const { t } = useTranslation("catalog");

  const cards = [
    {
      icon: Bug,
      labelKey: "catalog:product.gutCore1Label",
      descKey: "catalog:product.gutCore1Desc",
      color: "text-teal",
      bg: "bg-teal/10",
      border: "border-teal/20",
    },
    {
      icon: Shield,
      labelKey: "catalog:product.gutCore2Label",
      descKey: "catalog:product.gutCore2Desc",
      color: "text-sage-mint",
      bg: "bg-sage-mint/10",
      border: "border-sage-mint/20",
    },
    {
      icon: Flame,
      labelKey: "catalog:product.gutCore3Label",
      descKey: "catalog:product.gutCore3Desc",
      color: "text-warm-amber",
      bg: "bg-warm-amber/10",
      border: "border-warm-amber/20",
    },
    {
      icon: HeartPulse,
      labelKey: "catalog:product.gutCore4Label",
      descKey: "catalog:product.gutCore4Desc",
      color: "text-warm-coral",
      bg: "bg-warm-coral/10",
      border: "border-warm-coral/20",
    },
  ];

  return (
    <section id="gut-science" className="bg-warm-cream py-[80px] lg:py-[100px] px-6 lg:px-[72px]">
      <div className="max-w-[1080px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-10">
          <p className="label-text text-teal mb-4" style={{ letterSpacing: "0.18em" }}>
            {t("catalog:product.dualActionHeading")}
          </p>
          <h2 className="font-display font-semibold text-[28px] lg:text-[40px] text-teal-dark leading-[1.05]">
            {t("catalog:product.gutCoreTitle")}
          </h2>
        </motion.div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((card, i) => (
            <motion.div
              key={card.labelKey}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              className={`rounded-2xl border ${card.border} bg-white p-5 shadow-xs hover:shadow-md transition-shadow duration-300`}
            >
              <div className={`w-10 h-10 rounded-xl ${card.bg} flex items-center justify-center mb-3`}>
                <card.icon className={`w-5 h-5 ${card.color}`} strokeWidth={1.5} />
              </div>
              <h3 className="font-display font-semibold text-sm-plus text-teal-dark leading-tight">
                {t(card.labelKey)}
              </h3>
              <p className="font-body text-xs-plus text-charcoal/60 leading-normal mt-2">
                {t(card.descKey)}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default GutScienceStrip;

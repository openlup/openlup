import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { useTranslation } from "react-i18next";
import { X, Check } from "lucide-react";
import { scienceAncestorPortrait as wolfAncestor } from "#deployment-media";

const WildDietSection = () => {
  const { t } = useTranslation("content");

  const dryFoodItems = [
    "content:science.wildDiet.dryFoodItem1",
    "content:science.wildDiet.dryFoodItem2",
    "content:science.wildDiet.dryFoodItem3",
    "content:science.wildDiet.dryFoodItem4",
    "content:science.wildDiet.dryFoodItem5",
  ];

  const veliItems = [
    "content:science.wildDiet.veliItem1",
    "content:science.wildDiet.veliItem2",
    "content:science.wildDiet.veliItem3",
    "content:science.wildDiet.veliItem4",
    "content:science.wildDiet.veliItem5",
  ];

  return (
    <section className="relative overflow-hidden">
      {/* Wolf background */}
      <div className="absolute inset-0">
        <img
          src={wolfAncestor}
          alt=""
          loading="lazy"
          decoding="async"
          width={720}
          height={1290}
          className="w-full h-full object-cover opacity-[0.08]"
        />
        <div className="absolute inset-0 bg-linear-to-r from-[hsl(var(--void))] via-[hsl(var(--void))/0.9] to-[hsl(var(--void))/0.8]" />
      </div>

      <div className="relative z-10 py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
        <div className="max-w-[1100px] mx-auto">
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-12">
            <p className="label-text text-offwhite/40 mb-4" style={{ letterSpacing: "0.14em" }}>
              {t("content:science.wildDiet.badge")}
            </p>
            <h2 className="font-display font-semibold text-[34px] lg:text-[52px] text-offwhite leading-[0.95]">
              {t("content:science.wildDiet.heading1")}<br />{t("content:science.wildDiet.heading2")}
            </h2>
            <p className="font-body text-lg text-offwhite/60 max-w-[680px] mx-auto mt-6 leading-relaxed">
              {t("content:science.wildDiet.lead")}
            </p>
          </motion.div>

          {/* Comparison blocks */}
          <div className="grid md:grid-cols-2 gap-6 lg:gap-8">
            {/* Dry food - negative */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="rounded-[16px] bg-charcoal/40 border border-offwhite/6 p-8"
            >
              <p className="font-display font-semibold text-lg text-offwhite/50 mb-6">
                {t("content:science.wildDiet.dryFoodTitle")}
              </p>
              <div className="space-y-4">
                {dryFoodItems.map((key) => (
                  <div key={key} className="flex items-start gap-3">
                    <X size={16} className="text-offwhite/25 mt-0.5 shrink-0" strokeWidth={2} />
                    <span className="font-body text-sm-plus text-offwhite/45 leading-relaxed">{t(key)}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* OPENLUP - positive */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="rounded-[16px] bg-teal/8 border border-teal/20 p-8"
            >
              <p className="font-display font-semibold text-lg text-teal mb-6">
                {t("content:science.wildDiet.veliTitle")}
              </p>
              <div className="space-y-4">
                {veliItems.map((key) => (
                  <div key={key} className="flex items-start gap-3">
                    <Check size={16} className="text-teal mt-0.5 shrink-0" strokeWidth={2} />
                    <span className="font-body text-sm-plus text-offwhite/70 leading-relaxed">{t(key)}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Closing */}
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="mt-14 text-center">
            <p className="font-display font-semibold text-[24px] lg:text-[32px] text-offwhite/80 tracking-wide">
              {t("content:science.wildDiet.closing")}
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default WildDietSection;

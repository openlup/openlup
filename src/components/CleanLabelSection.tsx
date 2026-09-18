import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/animations";
import { X, Leaf, Shield, Eye, FlaskConical, Wheat, Ban, CheckCircle2, Beaker } from "lucide-react";
import { lifestyleOwnerPortrait as womanWithAkita } from "#deployment-media";

const CleanLabelSection = () => {
  const { t } = useTranslation("home");

  const removedItems = [
    { name: t("home:cleanLabel.r1name"), reason: t("home:cleanLabel.r1reason"), icon: Wheat },
    { name: t("home:cleanLabel.r2name"), reason: t("home:cleanLabel.r2reason"), icon: Ban },
    { name: t("home:cleanLabel.r3name"), reason: t("home:cleanLabel.r3reason"), icon: FlaskConical },
  ];

  const comparisonRows = [
    { bad: "Maize / corn meal", good: t("home:cleanLabel.notPresent"), named: false },
    { bad: "Wheat flour", good: t("home:cleanLabel.notPresent"), named: false },
    { bad: "Potato starch", good: t("home:cleanLabel.notPresent"), named: false },
    { bad: "Pea protein concentrate", good: t("home:cleanLabel.notPresent"), named: false },
    { bad: "Carrageenan (gum)", good: t("home:cleanLabel.notPresent"), named: false },
    { bad: "Meat meal (unspecified)", good: t("home:cleanLabel.namedCutsOnly"), named: true },
    { bad: "Flavour enhancers (E-numbers)", good: t("home:cleanLabel.naturalBrothOnly"), named: true },
  ];

  const principles = [
    { icon: Leaf, label: t("home:cleanLabel.speciesAppropriate") },
    { icon: Shield, label: t("home:cleanLabel.noFillers") },
    { icon: Eye, label: t("home:cleanLabel.fullTransparency") },
    { icon: Beaker, label: t("home:cleanLabel.scienceBacked") },
  ];

  return (
    <section className="bg-sage-tint py-[120px] px-6 lg:px-[72px] max-md:py-[72px]">
      <div className="max-w-[1280px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="flex flex-wrap gap-3 sm:gap-4 mb-12">
          {principles.map((p, i) => (
            <div key={i} className="flex items-center gap-2 bg-white/80 backdrop-blur-xs rounded-full px-4 py-2 border border-sage-mint/40 shadow-xs">
              <p.icon size={16} className="text-sage-mint" strokeWidth={2} />
              <span className="font-body text-xs-plus font-medium text-text-on-light/80">{p.label}</span>
            </div>
          ))}
        </motion.div>
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-start">
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
            <p className="mono-label tracking-[0.12em] text-sage-mint mb-7">{t("home:cleanLabel.label")}</p>
            <h2 className="font-display font-semibold text-[30px] lg:text-[44px] text-text-on-light leading-[1.1] whitespace-pre-line">{t("home:cleanLabel.heading")}</h2>
            <p className="font-body text-base lg:text-base-plus text-text-on-light/70 leading-[1.7] max-w-[440px] mt-6">{t("home:cleanLabel.body1")}</p>
            <p className="font-body text-base lg:text-base-plus text-text-on-light/70 leading-[1.7] max-w-[440px] mt-4">{t("home:cleanLabel.body2")}</p>
            <div className="mt-8 mb-8 flex flex-col gap-3">
              {removedItems.map((item, i) => (
                <div key={i} className="flex items-start gap-3 bg-white/70 rounded-xl px-4 py-3 border border-warm-coral/10 shadow-xs hover:shadow-md transition-shadow duration-200">
                  <div className="shrink-0 w-8 h-8 rounded-lg bg-warm-coral/10 flex items-center justify-center mt-0.5">
                    <item.icon size={16} className="text-warm-coral" strokeWidth={2} />
                  </div>
                  <div>
                    <span className="font-body text-xs-plus font-semibold text-text-on-light/80 flex items-center gap-1.5">
                      <X size={12} className="text-warm-coral" strokeWidth={3} />{item.name}
                    </span>
                    <p className="font-body text-xs text-text-on-light/50 mt-0.5">{item.reason}</p>
                  </div>
                </div>
              ))}
            </div>
            <a href="#products" className="font-body font-medium text-sm text-teal hover:underline inline-flex items-center gap-1.5">
              <Eye size={14} />{t("home:cleanLabel.seeIngredients")}
            </a>
          </motion.div>
          <div className="space-y-8">
            <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1, duration: 0.5 }} className="rounded-[20px] overflow-hidden shadow-lg">
              <img src={womanWithAkita} alt="Woman with her Akita dog" className="w-full h-[280px] lg:h-[320px] object-cover" loading="lazy" />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.15, duration: 0.5 }} className="bg-white rounded-[20px] p-5 sm:p-6 lg:p-8 shadow-[0_2px_24px_rgba(0,0,0,0.06)] overflow-x-auto">
              <div className="grid grid-cols-2 border-b border-black/8 pb-3 mb-1">
                <span className="mono-label tracking-widest text-warm-coral flex items-center gap-1.5"><Ban size={12} strokeWidth={2.5} />{t("home:cleanLabel.typicalPetFood")}</span>
                <span className="mono-label tracking-widest text-teal flex items-center gap-1.5"><CheckCircle2 size={12} strokeWidth={2.5} />{t("home:cleanLabel.openlup")}</span>
              </div>
              {comparisonRows.map((row, i) => (
                <div key={i} className={`grid grid-cols-2 py-2.5 px-1 sm:px-2 rounded-md font-body text-xs-plus sm:text-sm leading-[1.4] ${i % 2 === 1 ? "bg-sage-tint/50" : ""}`}>
                  <span className="text-black/35 line-through decoration-warm-coral/60 decoration-[1.5px]">{row.bad}</span>
                  <span className={row.named ? "text-text-on-light font-medium" : "text-black/50 italic"}>{row.good}</span>
                </div>
              ))}
              <div className="mt-5 pt-4 border-t border-black/6 flex items-center justify-center gap-2">
                <Shield size={14} className="text-sage-mint" />
                <p className="font-body text-xs text-black/35 italic">{t("home:cleanLabel.comparisonFooter")}</p>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CleanLabelSection;
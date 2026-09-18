import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/animations";
import { Shield, Activity, Sparkles, Zap, Hexagon } from "lucide-react";

const SystemSection = () => {
  const { t } = useTranslation("common");

  const benefits = [
    { icon: Shield, label: t("common:system.b1"), desc: t("common:system.b1d"), color: "text-sage-mint", bgColor: "bg-sage-mint/15" },
    { icon: Activity, label: t("common:system.b2"), desc: t("common:system.b2d"), color: "text-warm-coral", bgColor: "bg-warm-coral/15" },
    { icon: Sparkles, label: t("common:system.b3"), desc: t("common:system.b3d"), color: "text-soft-lavender", bgColor: "bg-soft-lavender/15" },
    { icon: Zap, label: t("common:system.b4"), desc: t("common:system.b4d"), color: "text-warm-amber", bgColor: "bg-warm-amber/15" },
    { icon: Hexagon, label: t("common:system.b5"), desc: t("common:system.b5d"), color: "text-teal-mint", bgColor: "bg-teal-mint/15" },
  ];

  return (
    <section id="science" className="bg-void py-[140px] px-6 lg:px-[72px] max-md:py-[72px]">
      <div className="max-w-[1280px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
          <p className="label-text text-teal mb-3">{t("common:system.label1")}</p>
          <p className="label-text text-teal mb-7">{t("common:system.label2")}</p>
          <h2 className="font-display font-semibold text-[34px] lg:text-[56px] text-offwhite leading-none whitespace-pre-line">{t("common:system.heading")}</h2>
          <p className="font-body text-lg text-text-on-dark leading-[1.75] max-w-[560px] mt-6">{t("common:system.body")}</p>
          <p className="font-body text-sm text-text-muted mt-3">{t("common:system.sub")}</p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-6 mt-16">
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="rounded-3xl bg-sage-mint/12 border border-sage-mint/20 p-10 lg:p-12">
            <p className="label-text text-sage-mint">{t("common:system.entoproLabel")}</p>
            <h3 className="font-display font-semibold text-[30px] lg:text-[32px] text-offwhite mt-3">{t("common:system.entoproTitle")}</h3>
            <p className="font-body text-base text-text-on-dark leading-[1.7] mt-4">{t("common:system.entoproBody")}</p>
            <p className="label-text text-sage-mint mt-6">{t("common:system.entoproSub")}</p>
          </motion.div>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="rounded-3xl bg-warm-coral/10 border border-warm-coral/20 p-10 lg:p-12">
            <p className="label-text text-warm-coral">{t("common:system.trupetLabel")}</p>
            <h3 className="font-display font-semibold text-[30px] lg:text-[32px] text-offwhite mt-3">{t("common:system.trupetTitle")}</h3>
            <p className="font-body text-base text-text-on-dark leading-[1.7] mt-4">{t("common:system.trupetBody")}</p>
            <p className="label-text text-warm-coral mt-6">{t("common:system.trupetSub")}</p>
          </motion.div>
        </div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="flex flex-wrap justify-between gap-6 mt-[72px] max-md:grid max-md:grid-cols-2">
          {benefits.map((b) => (
            <div key={b.label} className="flex flex-col items-center text-center max-w-[160px] mx-auto group">
              <div className={`w-16 h-16 rounded-2xl ${b.bgColor} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-200`}>
                <b.icon size={28} className={b.color} strokeWidth={1.5} />
              </div>
              <p className="font-body font-semibold text-sm-plus text-offwhite">{b.label}</p>
              <p className="font-body text-xs-plus text-text-muted mt-1">{b.desc}</p>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default SystemSection;
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/animations";
import { Pill } from "@/components/brand/Pill";
import { Link2, Sparkles, Shield, Droplets, Zap, Waves, Check } from "lucide-react";

const NutritionSection = () => {
  const { t } = useTranslation("home");

  const nutrients = [
    { icon: Link2, iconColor: "hsl(181, 47%, 50%)", bgTint: "bg-teal/5", title: t("home:nutrition.n1t"), body: t("home:nutrition.n1b"), tag: t("home:nutrition.n1tag") },
    { icon: Sparkles, iconColor: "hsl(36, 77%, 59%)", bgTint: "bg-warm-amber/5", title: t("home:nutrition.n2t"), body: t("home:nutrition.n2b"), tag: t("home:nutrition.n2tag") },
    { icon: Shield, iconColor: "hsl(275, 27%, 76%)", bgTint: "bg-soft-lavender/5", title: t("home:nutrition.n3t"), body: t("home:nutrition.n3b"), tag: t("home:nutrition.n3tag") },
    { icon: Droplets, iconColor: "hsl(163, 33%, 62%)", bgTint: "bg-teal-mint/5", title: t("home:nutrition.n4t"), body: t("home:nutrition.n4b"), tag: t("home:nutrition.n4tag") },
    { icon: Zap, iconColor: "hsl(90, 27%, 71%)", bgTint: "bg-sage-mint/5", title: t("home:nutrition.n5t"), body: t("home:nutrition.n5b"), tag: t("home:nutrition.n5tag") },
    { icon: Waves, iconColor: "hsl(17, 76%, 64%)", bgTint: "bg-warm-coral/5", title: t("home:nutrition.n6t"), body: t("home:nutrition.n6b"), tag: t("home:nutrition.n6tag") },
  ];

  return (
    <section className="bg-lavender-tint py-[120px] px-6 lg:px-[72px] max-md:py-[72px]">
      <div className="max-w-[960px] mx-auto text-center">
        <motion.p initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="label-text text-soft-lavender mb-7">{t("home:nutrition.label")}</motion.p>
        <motion.h2 initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="font-display font-semibold text-[32px] lg:text-[48px] text-text-on-light leading-[1.1] whitespace-pre-line">{t("home:nutrition.heading")}</motion.h2>
        <motion.p initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="font-body text-lg text-text-on-light/65 leading-[1.75] max-w-[560px] mx-auto mt-6">{t("home:nutrition.body")}</motion.p>
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="inline-flex items-center gap-4 border-[1.5px] border-soft-lavender/40 rounded-2xl px-8 py-5 mt-10 bg-white/60 backdrop-blur-xs shadow-xs">
          <div className="w-12 h-12 rounded-full bg-soft-lavender text-white flex items-center justify-center shrink-0"><Check size={22} strokeWidth={3} /></div>
          <div className="text-left">
            <span className="font-display font-semibold text-xl text-text-on-light block">{t("home:nutrition.fediafTitle")}</span>
            <span className="font-body text-xs-plus text-text-on-light/50 block mt-0.5">{t("home:nutrition.fediafSub")}</span>
          </div>
        </motion.div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-12">
          {nutrients.map((n, i) => {
            const Icon = n.icon;
            return (
              <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.06, duration: 0.4 }} className="bg-white border border-soft-lavender/15 rounded-2xl p-6 text-left hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
                <Icon size={40} color={n.iconColor} strokeWidth={1.5} className="mb-4" />
                <h3 className="font-display font-semibold text-base-plus text-text-on-light mb-2.5">{n.title}</h3>
                <p className="font-body text-sm leading-[1.65] text-text-on-light/60 mb-4">{n.body}</p>
                <Pill tone="mono" className="tracking-[0.08em] border-soft-lavender/25 text-soft-lavender">{n.tag}</Pill>
              </motion.div>
            );
          })}
        </div>
        <motion.p initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="font-body text-sm-plus text-text-on-light/40 max-w-[640px] mx-auto mt-12 leading-[1.7]">{t("home:nutrition.disclaimer")}</motion.p>
      </div>
    </section>
  );
};

export default NutritionSection;
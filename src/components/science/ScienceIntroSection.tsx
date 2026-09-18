import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { ShieldCheck, Sparkles, FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";

const cards = [
  { icon: ShieldCheck, titleKey: "content:science.intro.card1Title", bodyKey: "content:science.intro.card1Body" },
  { icon: Sparkles, titleKey: "content:science.intro.card2Title", bodyKey: "content:science.intro.card2Body" },
  { icon: FlaskConical, titleKey: "content:science.intro.card3Title", bodyKey: "content:science.intro.card3Body" },
];

const ScienceIntroSection = () => {
  const { t } = useTranslation("content");

  return (
    <section className="bg-void py-[80px] lg:py-[100px] px-6 lg:px-[72px] max-md:py-[56px] relative">
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-teal/3 to-transparent" />
      <div className="max-w-[1100px] mx-auto relative z-10">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-12">
          <p className="label-text text-teal/70 mb-4" style={{ letterSpacing: "0.14em" }}>
            {t("content:science.intro.badge")}
          </p>
          <h2 className="font-display font-semibold text-[32px] lg:text-[48px] text-offwhite leading-[0.95]">
            {t("content:science.intro.heading")}
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {cards.map((card, i) => (
            <motion.div
              key={card.titleKey}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="rounded-[16px] bg-void/50 border border-offwhite/6 p-7"
            >
              <card.icon size={24} className="text-sage-mint mb-4" strokeWidth={1.5} />
              <h3 className="font-display font-semibold text-base-plus text-offwhite mb-3">
                {t(card.titleKey)}
              </h3>
              <p className="font-body text-sm text-offwhite/55 leading-relaxed">
                {t(card.bodyKey)}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ScienceIntroSection;

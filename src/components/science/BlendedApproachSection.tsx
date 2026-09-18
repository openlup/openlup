import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { Beef, FlaskConical, Shield } from "lucide-react";
import { brandMark as veliLogo } from "#deployment-media";
import { useTranslation } from "react-i18next";

const layers = [
  {
    labelKey: "content:science.blended.layer1Label",
    titleKey: "content:science.blended.layer1Title",
    bodyKey: "content:science.blended.layer1Body",
    icon: Beef,
    color: "hsl(var(--warm-coral))",
    borderColor: "border-warm-coral/25",
    bgColor: "bg-warm-coral/4",
  },
  {
    labelKey: "content:science.blended.layer2Label",
    titleKey: "content:science.blended.layer2Title",
    bodyKey: "content:science.blended.layer2Body",
    icon: FlaskConical,
    color: "hsl(var(--teal-mint))",
    borderColor: "border-teal-mint/25",
    bgColor: "bg-teal-mint/4",
  },
  {
    labelKey: "content:science.blended.layer3Label",
    titleKey: "content:science.blended.layer3Title",
    bodyKey: "content:science.blended.layer3Body",
    icon: Shield,
    color: "hsl(var(--sage-mint))",
    borderColor: "border-sage-mint/25",
    bgColor: "bg-sage-mint/4",
  },
];

const BlendedApproachSection = () => {
  const { t } = useTranslation("content");

  return (
    <section className="bg-offwhite py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[960px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-12">
          <h2 className="font-display font-semibold text-[32px] lg:text-[48px] text-charcoal leading-[0.95]">
            {t("content:science.blended.heading1")}<br />{t("content:science.blended.heading2")}
          </h2>
        </motion.div>

        {/* 3 cards */}
        <div className="grid md:grid-cols-3 gap-5">
          {layers.map((layer, i) => {
            const Icon = layer.icon;
            return (
              <motion.div
                key={layer.labelKey}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5 }}
                className={`rounded-[20px] ${layer.bgColor} border ${layer.borderColor} p-7 text-center`}
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4"
                  style={{ backgroundColor: `${layer.color}15` }}
                >
                  <Icon size={24} style={{ color: layer.color }} strokeWidth={1.5} />
                </div>
                <span
                  className="label-text text-xxs"
                  style={{ color: layer.color, letterSpacing: "0.12em" }}
                >
                  {t(layer.labelKey)}
                </span>
                <h3 className="font-display font-semibold text-[19px] text-charcoal mt-2 leading-tight">
                  {t(layer.titleKey)}
                </h3>
                <p className="font-body text-sm text-charcoal/60 leading-relaxed mt-3">
                  {t(layer.bodyKey)}
                </p>
              </motion.div>
            );
          })}
        </div>

        {/* Connector lines (desktop) */}
        <div className="hidden md:block">
          <svg viewBox="0 0 960 70" fill="none" className="w-full max-w-[960px] mx-auto" preserveAspectRatio="xMidYMid meet">
            {/* Left line */}
            <path d="M160 0 Q160 35, 480 60" stroke="hsl(var(--warm-coral))" strokeWidth="1.5" fill="none" opacity="0.4" />
            {/* Center line */}
            <line x1="480" y1="0" x2="480" y2="60" stroke="hsl(var(--teal-mint))" strokeWidth="1.5" opacity="0.4" />
            {/* Right line */}
            <path d="M800 0 Q800 35, 480 60" stroke="hsl(var(--sage-mint))" strokeWidth="1.5" fill="none" opacity="0.4" />
            {/* Merge dot */}
            <circle cx="480" cy="62" r="5" fill="hsl(var(--warm-coral))" opacity="0.7" />
          </svg>
        </div>

        {/* Mobile connector */}
        <div className="md:hidden flex justify-center my-4">
          <svg viewBox="0 0 20 40" fill="none" className="w-5 h-10">
            <line x1="10" y1="0" x2="10" y2="34" stroke="hsl(var(--warm-coral))" strokeWidth="1.5" opacity="0.4" />
            <polygon points="6,34 10,40 14,34" fill="hsl(var(--warm-coral))" opacity="0.5" />
          </svg>
        </div>

        {/* OPENLUP summary box */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="rounded-[20px] border-[1.5px] border-warm-coral/30 bg-warm-coral/3 p-8 text-center max-w-[480px] mx-auto"
        >
          <img src={veliLogo} alt="openlup" className="h-[26px] w-auto mx-auto mb-3" />
          <p className="font-display font-semibold text-lg text-charcoal leading-snug whitespace-pre-line">
            {t("content:science.blended.boxLabel")}
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default BlendedApproachSection;

import { motion, useReducedMotion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import {
  Atom,
  Brain,
  Droplet,
  Dumbbell,
  HeartPulse,
  Pill,
  Shield,
  Sprout,
  UtensilsCrossed,
} from "lucide-react";
import { useTranslation } from "react-i18next";

const benefitDefs = [
  {
    icon: Shield,
    colorClass: "text-teal-mint",
    bgClass: "bg-teal-mint/15",
    termKey: "content:science.health.item1Term",
    descKey: "content:science.health.item1Desc",
  },
  {
    icon: HeartPulse,
    colorClass: "text-warm-coral",
    bgClass: "bg-warm-coral/15",
    termKey: "content:science.health.item2Term",
    descKey: "content:science.health.item2Desc",
  },
  {
    icon: Droplet,
    colorClass: "text-soft-lavender",
    bgClass: "bg-soft-lavender/15",
    termKey: "content:science.health.item3Term",
    descKey: "content:science.health.item3Desc",
  },
  {
    icon: Pill,
    colorClass: "text-warm-amber",
    bgClass: "bg-warm-amber/15",
    termKey: "content:science.health.item4Term",
    descKey: "content:science.health.item4Desc",
  },
  {
    icon: Atom,
    colorClass: "text-sage-mint",
    bgClass: "bg-sage-mint/15",
    termKey: "content:science.health.item5Term",
    descKey: "content:science.health.item5Desc",
  },
  {
    icon: Dumbbell,
    colorClass: "text-warm-coral",
    bgClass: "bg-warm-coral/15",
    termKey: "content:science.health.item6Term",
    descKey: "content:science.health.item6Desc",
  },
  {
    icon: Brain,
    colorClass: "text-soft-lavender",
    bgClass: "bg-soft-lavender/15",
    termKey: "content:science.health.item7Term",
    descKey: "content:science.health.item7Desc",
  },
  {
    icon: Sprout,
    colorClass: "text-sage-mint",
    bgClass: "bg-sage-mint/15",
    termKey: "content:science.health.item8Term",
    descKey: "content:science.health.item8Desc",
  },
  {
    icon: UtensilsCrossed,
    colorClass: "text-warm-amber",
    bgClass: "bg-warm-amber/15",
    termKey: "content:science.health.item9Term",
    descKey: "content:science.health.item9Desc",
  },
];

const HealthIngredientsSection = () => {
  const { t } = useTranslation("content");
  const shouldReduceMotion = useReducedMotion();

  return (
    <section className="bg-offwhite px-4 py-16 md:px-6 md:py-24 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <motion.div
          initial={shouldReduceMotion ? false : "hidden"}
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="mb-14 text-center"
        >
          <span className="inline-block label-text text-charcoal/45 rounded-full border border-charcoal/15 px-4 py-1.5">
            {t("content:science.health.badge")}
          </span>
          <h2 className="mx-auto mt-6 max-w-3xl font-display text-3xl font-semibold leading-tight text-charcoal lg:text-5xl">
            {t("content:science.health.heading")}
          </h2>
          <p className="mx-auto mt-5 max-w-2xl font-body text-base leading-relaxed text-charcoal/60">
            {t("content:science.health.intro")}
          </p>
        </motion.div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {benefitDefs.map((item, i) => {
            const Icon = item.icon;

            return (
              <motion.div
                key={item.termKey}
                initial={shouldReduceMotion ? false : { opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{
                  delay: shouldReduceMotion ? 0 : (i % 3) * 0.08,
                  duration: shouldReduceMotion ? 0 : 0.5,
                }}
                className="flex flex-col rounded-card border border-charcoal/6 bg-white p-6"
              >
                <div className={`mb-4 flex size-11 items-center justify-center rounded-xl ${item.bgClass}`}>
                  <Icon
                    aria-hidden="true"
                    className={item.colorClass}
                    size={22}
                    strokeWidth={1.5}
                  />
                </div>
                <h3 className="font-display text-base-plus font-semibold leading-snug text-charcoal">
                  {t(item.termKey)}
                </h3>
                <p className="mt-2 font-body text-sm leading-relaxed text-charcoal/60">
                  {t(item.descKey)}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default HealthIngredientsSection;

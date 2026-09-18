import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";

import {
  lifecycleBannerApproved as approvedBanner,
  lifecycleBannerDelivered as deliveredBanner,
  lifecycleBannerWelcome as welcomeBanner,
} from "#deployment-media";

/**
 * Ollie-style "How it works" z lekkimi wariantami WebP istniejących wizuali.
 * Docelowo zastąpimy je własnymi ilustracjami rozpakowywania paczki.
 */

interface Step {
  label: string;
  title: string;
  body: string;
  image: string;
}

export function HowItWorks() {
  const { t } = useTranslation("home");

  const steps: Step[] = [
    {
      label: t("home:howItWorks.step1Label"),
      title: t("home:howItWorks.step1Title"),
      body: t("home:howItWorks.step1Body"),
      image: welcomeBanner,
    },
    {
      label: t("home:howItWorks.step2Label"),
      title: t("home:howItWorks.step2Title"),
      body: t("home:howItWorks.step2Body"),
      image: approvedBanner,
    },
    {
      label: t("home:howItWorks.step3Label"),
      title: t("home:howItWorks.step3Title"),
      body: t("home:howItWorks.step3Body"),
      image: deliveredBanner,
    },
  ];

  return (
    <section id="jak-to-dziala" className="scroll-mt-24 bg-soft-sage py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[1280px] mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-14"
        >
          <h2 className="font-display font-semibold text-[34px] lg:text-[52px] text-text-on-light leading-tight max-w-[640px] mx-auto">
            {t("home:howItWorks.title")}
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {steps.map((step, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08, duration: 0.5 }}
              className="relative"
            >
              <div className="rounded-2xl overflow-hidden bg-warm-cream aspect-[5/3] mb-5 border border-border shadow-xs">
                <img
                  src={step.image}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width={1280}
                  height={543}
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="font-mono text-[10px] uppercase tracking-wider text-teal-dark mb-2">
                {step.label}
              </p>
              <h3 className="font-display font-semibold text-[18px] lg:text-[20px] text-text-on-light leading-tight">
                {step.title}
              </h3>
              <p className="font-body text-sm-plus text-charcoal/75 leading-[1.7] mt-2">
                {step.body}
              </p>
              {i < steps.length - 1 && (
                <div className="hidden lg:block absolute top-[78px] -right-4 w-8 h-px bg-border" />
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
